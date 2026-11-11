import { prisma } from "@/lib/db";
import { hashInviteToken } from "@/lib/inviteToken";
import { logger } from "@/lib/logger";
import { consumeFixedWindow } from "@/lib/rateLimit";
import { isUploadLinkTokenShape, uploadLinkHourWindow } from "@/lib/uploadLink";
import { billingFieldsSelect } from "@/lib/billing";
import { workspaceBlock } from "@/lib/workspaceStatus";
import { buildClientUploadEmail } from "@/server/notifications/clientUploadEmail";
import { sendEmail } from "@/server/notifications/email";

/**
 * Client upload link (2026-11-10), server side: resolving a token from the URL
 * to its link, and the owners' email when files arrive.
 */

export type ActiveUploadLink = {
  id: string;
  workspaceId: string;
  createdById: string;
  workspaceName: string;
};

/**
 * The active link a raw token names, or null. Unknown and revoked both give
 * null, so every caller answers them the same way. The public routes take the
 * workspace, the owner and the link id from this, never from the request. A
 * paused workspace's link is not active either (workspaceBlock) until it is
 * resumed; the client is not told why.
 */
export async function findActiveUploadLink(token: string): Promise<ActiveUploadLink | null> {
  if (!isUploadLinkTokenShape(token)) return null;
  const row = await prisma.workspaceUploadLink.findUnique({
    where: { tokenHash: hashInviteToken(token) },
    select: {
      id: true,
      workspaceId: true,
      createdById: true,
      revokedAt: true,
      // 21a: the plan columns too, only with billing on.
      workspace: { select: { name: true, pausedAt: true, pausedReason: true, ...billingFieldsSelect() } },
    },
  });
  if (!row || row.revokedAt || workspaceBlock(row.workspace)) return null;
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    createdById: row.createdById,
    workspaceName: row.workspace.name,
  };
}

/**
 * Who owns a file sent through the link (a media item needs an owner): the
 * link's creator while they are still an owner of its workspace, otherwise the
 * longest-standing owner. Resolved at each registration, because the creator
 * may have left, been made a member, or deleted their account (memberships are
 * deleted with it); a file owned by a non-member would later be deleted along
 * with that person's account. Null when the workspace has no owner at all.
 */
export async function resolveUploadLinkOwner(link: ActiveUploadLink): Promise<string | null> {
  const owners = await prisma.workspaceMember.findMany({
    where: { workspaceId: link.workspaceId, role: "owner" },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { userId: true },
  });
  if (owners.length === 0) return null;
  return owners.some((owner) => owner.userId === link.createdById)
    ? link.createdById
    : owners[0].userId;
}

/** How long the owners' email may run before the caller carries on (as workspaceUsage.ts). */
const NOTIFY_TIMEOUT_MS = 5_000;

type ClientUploadNotice = {
  linkId: string;
  workspaceId: string;
  workspaceName: string;
  senderName: string | null;
  now: Date;
};

async function sendClientUploadEmails(args: ClientUploadNotice): Promise<void> {
  const { linkId, workspaceId } = args;
  const hour = uploadLinkHourWindow(args.now);
  const first = await consumeFixedWindow({
    key: `client-upload-email:${linkId}:${hour.key}`,
    limit: 1,
    resetAt: hour.end,
  });
  if (!first.allowed) return;

  const owners = await prisma.workspaceMember.findMany({
    where: { workspaceId, role: "owner" },
    select: { user: { select: { id: true, email: true } } },
  });
  const email = buildClientUploadEmail({
    senderName: args.senderName,
    workspaceName: args.workspaceName,
    appUrl: process.env.NEXTAUTH_URL ?? "",
  });
  for (const owner of owners) {
    await sendEmail(
      { to: owner.user.email, ...email },
      { idempotencyKey: `client-upload/${linkId}/${hour.key}/${owner.user.id}` },
    );
  }
}

/**
 * Email the owners the first time files arrive through the link in a UTC hour.
 * Follows notifyOwnersOfLimitReached: a limit-1 counter decides "first", the
 * per-owner idempotency key stops a repeat if the counter store is down (it
 * fails open), it never throws, and it stops waiting after 5 seconds. The
 * registration route runs it after the response, so it never delays the client.
 */
export async function notifyOwnersOfClientUpload(args: ClientUploadNotice): Promise<void> {
  const { linkId, workspaceId } = args;
  const work = sendClientUploadEmails(args).then(
    () => "sent" as const,
    (error: unknown) => {
      logger.error("[upload-link] Couldn't email the owners about client files (ignored)", {
        error,
        linkId,
        workspaceId,
      });
      return "failed" as const;
    },
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), NOTIFY_TIMEOUT_MS);
  });
  try {
    if ((await Promise.race([work, timeout])) === "timeout") {
      logger.error("[upload-link] Emailing the owners took too long; carrying on", {
        linkId,
        workspaceId,
        timeoutMs: NOTIFY_TIMEOUT_MS,
      });
    }
  } finally {
    clearTimeout(timer);
  }
}
