import type { Platform } from "@prisma/client";

import { toConnectionSummary } from "@/lib/connectionSummary";
import { prisma } from "@/lib/db";
import {
  connectedAccountName,
  linkedPageAccount,
  linkedPageNotReturned,
  pageAccountLabel,
  signInTo,
} from "@/lib/differentAccount";
import { logger } from "@/lib/logger";
import { platformLabel } from "@/lib/platforms";
import { sendEmail } from "@/server/notifications/email";
import { workspaceLink } from "@/server/notifications/links";
import { sendOncePer, sendToEach } from "@/server/notifications/onceADay";

/**
 * R7-client-journey L4: a client's reconnect through the workspace's connect
 * link came back with a different account than the one connected, so nothing
 * changed (server/connections/saveConnection.ts). The client is told to ask
 * the owner, so the owners hear of it here. Sent where the refusal happens
 * (server/connectLink/callback.ts and the link's choice route), never from the
 * /c page; at most once per connection per UTC day, however often it is tried.
 */

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function buildRefusedConnectEmail(params: {
  platform: Platform;
  workspaceId: string;
  workspaceName: string;
  connectedName: string;
  /** `process.env.NEXTAUTH_URL`. Null renders the email with no link. */
  appBaseUrl: string | null;
}): { subject: string; html: string } {
  const label = platformLabel(params.platform);
  const platform = escapeHtml(label);
  const workspace = escapeHtml(params.workspaceName);
  const name = escapeHtml(params.connectedName);
  const base = params.appBaseUrl || null;
  // R8-client-journey L2: a LinkedIn or Facebook page is not signed in to; an
  // account that manages it is (lib/differentAccount.ts).
  const pageAccount = pageAccountLabel(params.platform);
  const signIn = escapeHtml(signInTo(params.platform, params.connectedName));
  // R51 pages-a L2: Instagram is signed in to through Facebook, from the Page
  // linked to it, so the account itself is never signed in to.
  const viaAccount = linkedPageAccount(params.platform);
  const notReturned = linkedPageNotReturned(params.platform, params.connectedName);

  const what = notReturned
    ? `<p>Your client used your connect link for <strong>${workspace}</strong> to reconnect ${platform}, but ${escapeHtml(notReturned)}. Nothing was changed.</p>`
    : pageAccount
      ? `<p>Your client used your connect link for <strong>${workspace}</strong> and signed in with a ${pageAccount} account for a different page than the one connected (<strong>${name}</strong>). Nothing was changed.</p>`
      : `<p>Your client used your connect link for <strong>${workspace}</strong> and signed in to a different ${platform} account than the one connected (<strong>${name}</strong>). Nothing was changed.</p>`;
  const next = pageAccount
    ? `<p>If your client should post to their own page, disconnect ${name} in Settings, Connections; then they can connect theirs through the link. If ${name} is the right page, use Reconnect in Settings, Connections, or ask your client to ${signIn}.</p>`
    : `<p>If your client should post from their own account, disconnect ${name} in Settings, Connections; then they can connect theirs through the link. If ${name} is the right account, ${notReturned ? "" : "it has to be signed in to: "}use Reconnect in Settings, Connections, or ask your client to ${signIn}.</p>`;
  const subjectTail = viaAccount
    ? `your client's ${viaAccount} sign-in didn't return the connected ${label} account`
    : `your client signed in to ${pageAccount ? `${pageAccount} for a different page` : `a different ${label} account`}`;
  const link = base
    ? `<p><a href="${escapeHtml(workspaceLink(params.workspaceId, "/settings#connections", base))}">Open Settings, Connections</a></p>`
    : "<p>Open Settings, Connections in Vibe Socials to see it.</p>";

  return {
    subject: `${params.workspaceName.replace(/[\r\n]+/g, " ").trim()}: ${subjectTail}`,
    html: [what, next, link, "<p>— Vibe Socials</p>"].join("\n"),
  };
}

function nextUtcMidnight(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
}

/**
 * Email every owner, once per connection per UTC day. Through sendOnceADay:
 * a store error sends nothing rather than one email per page load, and the
 * day is let go again when the reads fail or no email went (R38
 * client-journey L2). Never throws: the page still renders.
 */
export async function notifyOwnersOfRefusedConnect(params: { workspaceId: string; platform: Platform }): Promise<void> {
  const onError = (error: unknown) =>
    logger.error("[connect-link] Couldn't email the owners about a refused client sign-in (ignored)", {
      workspaceId: params.workspaceId,
      platform: params.platform,
      error,
    });
  let connection: Awaited<ReturnType<typeof findConnection>>;
  try {
    connection = await findConnection(params);
  } catch (error) {
    onError(error);
    return;
  }
  if (!connection) return;
  const found = connection;

  const now = new Date();
  const day = now.toISOString().slice(0, 10);
  await sendOncePer(
    {
      key: `refused-connect-email:${found.id}:${day}`,
      resetAt: nextUtcMidnight(now),
      keysFrom: new Date(`${day}T00:00:00.000Z`),
      perRecipientKeys: true,
    },
    async (sendStarted) => {
      const [workspace, owners] = await Promise.all([
        prisma.workspace.findUnique({ where: { id: params.workspaceId }, select: { name: true } }),
        prisma.workspaceMember.findMany({
          where: { workspaceId: params.workspaceId, role: "owner" },
          select: { user: { select: { id: true, email: true } } },
        }),
      ]);
      if (!workspace) return false;

      const email = buildRefusedConnectEmail({
        platform: params.platform,
        workspaceId: params.workspaceId,
        workspaceName: workspace.name,
        connectedName: connectedAccountName(toConnectionSummary(found)),
        appBaseUrl: process.env.NEXTAUTH_URL || null,
      });
      // R38 lead review: a lost reply throws (so the day is let go) and the
      // next try that day reuses the key, so Resend sends no second copy.
      // sendToEach: one owner's failure never stops the next (R39 L3).
      return sendToEach(owners, (owner) =>
        sendEmail(
          { to: owner.user.email, ...email },
          {
            label: "refused-connect",
            idempotencyKey: `refused-connect/${found.id}/${day}/${owner.user.id}`,
            throwOnRetryable: true,
          },
        ),
        sendStarted,
      );
    },
    onError,
  );
}

function findConnection(params: { workspaceId: string; platform: Platform }) {
  return prisma.socialConnection.findUnique({
    where: { workspaceId_platform: { workspaceId: params.workspaceId, platform: params.platform } },
    select: { id: true, platform: true, accountIdentifier: true, metadata: true, needsReconnect: true },
  });
}
