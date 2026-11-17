import { billingFieldsSelect } from "@/lib/billing";
import { prisma } from "@/lib/db";
import { platformLabel } from "@/lib/platforms";
import { clientLinkPanelStatus } from "@/server/clientLinkPanelStatus";
import { sendEmailOutcome, type SendEmailOutcome } from "@/server/notifications/email";
import { buildExpiryWarningEmail, buildReconnectEmail } from "@/server/notifications/reconnectEmail";
import { expiryNoticeDue, expiryNoticeWhere } from "./connectionHealthSweep";

/**
 * Connection notices (R5-publishing M1: no connection may die unannounced).
 *
 * Two columns make each notice go out once without anything ever being cleared:
 *  - `reconnectEmailedAt`: when the owners were emailed about the current flag.
 *    The flag's own time is `refreshFailedAt` (written with every flag,
 *    connectionHealth.ts), so the email is due while the flag is newer than
 *    the last email. A reconnect clears the flag; the next flag is newer again.
 *  - `expiryWarnedFor`: the `expiresAt` the last pre-expiry warning was about. A
 *    reconnect writes a new `expiresAt`, so its expiry is warned about again.
 */

/**
 * The `lastRefreshErrorCode` the sweep flags with when a sign-in that cannot be
 * renewed reaches its end date (diagnostic, and it picks the email's wording).
 */
export const CONNECTION_EXPIRED_CODE = "CONNECTION_SIGN_IN_EXPIRED";

/**
 * Connections each pass of {@link sendConnectionNotices} handles per day; the
 * rest wait for tomorrow. At two owners and a sequential send of a few hundred
 * ms, 100 + 100 stays well inside one step's time and Resend's 10 requests/s.
 */
export const CONNECTION_NOTICES_BATCH = 100;

/**
 * Flagged connections read per day, newest flag first, to find the ones not yet
 * told (three small columns each). A new flag is always among the newest, so it
 * is missed only if more than this many newer flags are waiting too, and then it
 * is reached as those are told on the following days.
 */
export const CONNECTION_FLAG_SCAN_LIMIT = 500;

type Stamp = Date | string | null;

/**
 * The workspace row both notices read: its name, and what decides the client
 * line (R24 pages L4: the pause and billing columns clientLinkPanelStatus uses,
 * as Settings' connect-link group reads them).
 */
const WORKSPACE_SELECT = () => ({ name: true, pausedAt: true, pausedReason: true, ...billingFieldsSelect() }) as const;

/**
 * R43 platform L1: what one notice's sends add up to. `sent`: the owners it
 * reached. `done`: no owner is left to try, so the notice may be recorded: an
 * owner Resend refused for good is done (one bad address must not hold the
 * record back for ever), one whose send can still go (a quota answer, no or a
 * bad key) is not, and the next sweep tries the notice again. A rate limit or
 * a 5xx still throws out of the send (throwOnRetryable), and nothing is recorded.
 */
async function sendToEach<T>(
  owners: readonly T[],
  send: (owner: T) => Promise<SendEmailOutcome>,
): Promise<{ sent: number; done: boolean }> {
  let sent = 0;
  let done = true;
  for (const owner of owners) {
    const outcome = await send(owner);
    if (outcome.sent) sent++;
    else if (outcome.reason !== "refused") done = false;
  }
  return { sent, done };
}

/** Was the reconnect email already sent for the connection's current flag? */
function reconnectAlreadyEmailed(connection: { refreshFailedAt: Stamp; reconnectEmailedAt: Stamp }): boolean {
  if (connection.reconnectEmailedAt === null) return false;
  if (connection.refreshFailedAt === null) return true;
  return new Date(connection.reconnectEmailedAt).getTime() >= new Date(connection.refreshFailedAt).getTime();
}

/**
 * Email every owner of the connection's workspace that it needs reconnecting,
 * once per flag, then record it (`reconnectEmailedAt`). Re-checks the flag so an
 * owner who reconnected meanwhile is not told to. Returns a COUNT only.
 *
 * 2026-11-01 scale audit (jobs, notifications): a retryable Resend failure throws
 * out of the step (the function's `retries` re-run it) instead of being dropped;
 * nothing is recorded then, and the per-owner idempotency key keeps the owners
 * already emailed from being emailed again on that retry.
 *
 * 2026-11-02 scale audit (jobs, notifications): the UTC day in that key is an
 * argument (a memoized step output), not read from the clock here: a retry after
 * midnight UTC would otherwise build a new key and email the owners a second time.
 */
export async function notifyOwnersToReconnect(
  socialConnectionId: string,
  utcDay: string,
): Promise<{ emailed: number }> {
  const connection = await prisma.socialConnection.findUnique({
    where: { id: socialConnectionId },
    select: {
      platform: true,
      workspaceId: true,
      needsReconnect: true,
      lastRefreshErrorCode: true,
      refreshFailedAt: true,
      reconnectEmailedAt: true,
    },
  });
  if (!connection?.needsReconnect || reconnectAlreadyEmailed(connection)) return { emailed: 0 };

  const [workspace, owners] = await Promise.all([
    prisma.workspace.findUnique({
      where: { id: connection.workspaceId },
      select: WORKSPACE_SELECT(),
    }),
    prisma.workspaceMember.findMany({
      where: { workspaceId: connection.workspaceId, role: "owner" },
      select: { user: { select: { id: true, email: true } } },
    }),
  ]);
  const email = buildReconnectEmail({
    platformLabel: platformLabel(connection.platform),
    workspaceId: connection.workspaceId,
    workspaceName: workspace?.name ?? "your workspace",
    appBaseUrl: process.env.NEXTAUTH_URL || null,
    reason: connection.lastRefreshErrorCode === CONNECTION_EXPIRED_CODE ? "expired" : "rejected",
    clientLinks: workspace ? clientLinkPanelStatus(workspace) : {},
  });
  // One reconnect email per owner per connection per UTC day: a retry of the step
  // (or a lost ack) re-sends with the same key, which Resend treats as a no-op for
  // owners already emailed (V18).
  const { sent: emailed, done } = await sendToEach(owners, (owner) =>
    sendEmailOutcome(
      { to: owner.user.email, ...email },
      {
        idempotencyKey: `reconnect/${socialConnectionId}/${utcDay}/${owner.user.id}`,
        throwOnRetryable: true,
      },
    ),
  );
  if (!done) return { emailed };
  await prisma.socialConnection.updateMany({
    where: { id: socialConnectionId, needsReconnect: true },
    data: { reconnectEmailedAt: new Date() },
  });
  return { emailed };
}

/**
 * Warn each owner, in their own time zone, that the sign-in ends on `expiresAt`.
 * Returns how many owners it reached; it is recorded only once none is left to try.
 */
async function warnOwnersOfExpiry(connection: {
  id: string;
  platform: Parameters<typeof platformLabel>[0];
  workspaceId: string;
  expiresAt: Date;
}): Promise<number> {
  const [workspace, owners] = await Promise.all([
    prisma.workspace.findUnique({ where: { id: connection.workspaceId }, select: WORKSPACE_SELECT() }),
    prisma.workspaceMember.findMany({
      where: { workspaceId: connection.workspaceId, role: "owner" },
      select: { user: { select: { id: true, email: true, timeZone: true } } },
    }),
  ]);
  const expiry = connection.expiresAt.toISOString();
  const clientLinks = workspace ? clientLinkPanelStatus(workspace) : {};
  const { sent, done } = await sendToEach(owners, (owner) => {
    const email = buildExpiryWarningEmail({
      platformLabel: platformLabel(connection.platform),
      workspaceId: connection.workspaceId,
      workspaceName: workspace?.name ?? "your workspace",
      expiresAt: connection.expiresAt,
      timeZone: owner.user.timeZone,
      appBaseUrl: process.env.NEXTAUTH_URL || null,
      clientLinks,
    });
    return sendEmailOutcome(
      { to: owner.user.email, ...email },
      { idempotencyKey: `expiry-warning/${connection.id}/${expiry}/${owner.user.id}`, throwOnRetryable: true },
    );
  });
  if (!done) return sent;
  // Only while the expiry is the one warned about: a reconnect meanwhile has its own.
  await prisma.socialConnection.updateMany({
    where: { id: connection.id, expiresAt: connection.expiresAt },
    data: { expiryWarnedFor: connection.expiresAt },
  });
  return sent;
}

/**
 * The daily sweep's notices (one step, connectionHealthSweep in
 * inngest-functions.ts), in order:
 *  1. a sign-in that cannot be renewed and ends within EXPIRY_WARNING_LEAD_MS:
 *     its owners are warned once ("LinkedIn needs reconnecting by <date>");
 *  2. one that has ended: the connection is flagged, only while it is the row
 *     that was read (same `expiresAt`: a reconnect writes a new one), so posts
 *     stop being sent with a dead token and Settings says to reconnect;
 *  3. every flagged connection whose flag has not had its email (step 2's, or a
 *     failed post's): the reconnect email. What was flagged, or had lapsed, at release
 *     was marked told by the migration (20261114570000_connection_notices), so
 *     old and test connections send nothing.
 * The cron runs at 04:45 UTC, the evening before in the US, so the lapse email
 * goes out on the day the sign-in ended there, or within the next day.
 *
 * Throws only a retryable send failure (the step is retried; what was recorded
 * is skipped). Returns counts only.
 */
export async function sendConnectionNotices(
  nowIso: string,
  utcDay: string,
): Promise<{ warned: number; lapsed: number; reconnectEmails: number }> {
  const now = new Date(nowIso);
  let warned = 0;
  let lapsed = 0;

  const candidates = await prisma.socialConnection.findMany({
    where: expiryNoticeWhere(now),
    select: { id: true, platform: true, workspaceId: true, expiresAt: true, expiryWarnedFor: true },
    orderBy: { expiresAt: "asc" },
    take: CONNECTION_NOTICES_BATCH,
  });
  for (const candidate of candidates) {
    if (!candidate.expiresAt) continue;
    // The WHERE already holds these two; the rule is checked whole.
    const due = expiryNoticeDue({ ...candidate, refreshToken: null, needsReconnect: false }, now);
    if (due === "warning") {
      // Counted when it reached an owner; one not recorded is tried at the next sweep.
      if ((await warnOwnersOfExpiry({ ...candidate, expiresAt: candidate.expiresAt })) > 0) warned++;
    } else if (due === "lapsed") {
      // Flag fields only, never a token (connectionHealth.ts invariant).
      const flagged = await prisma.socialConnection.updateMany({
        where: { id: candidate.id, needsReconnect: false, refreshToken: null, expiresAt: candidate.expiresAt },
        data: { needsReconnect: true, lastRefreshErrorCode: CONNECTION_EXPIRED_CODE, refreshFailedAt: now },
      });
      lapsed += flagged.count;
    }
  }

  // The newest flags first, compared with their email time here: a plain WHERE
  // and sort, no column-to-column comparison. A flag is written with its time
  // (connectionHealth.ts), so one without is from before that existed, and the
  // release migration marked every flag present then as told.
  const flagged = await prisma.socialConnection.findMany({
    where: { needsReconnect: true, refreshFailedAt: { not: null } },
    select: { id: true, refreshFailedAt: true, reconnectEmailedAt: true },
    orderBy: { refreshFailedAt: "desc" },
    take: CONNECTION_FLAG_SCAN_LIMIT,
  });
  const unannounced = flagged.filter((row) => !reconnectAlreadyEmailed(row)).slice(0, CONNECTION_NOTICES_BATCH);
  let reconnectEmails = 0;
  for (const { id } of unannounced) {
    reconnectEmails += (await notifyOwnersToReconnect(id, utcDay)).emailed;
  }

  return { warned, lapsed, reconnectEmails };
}
