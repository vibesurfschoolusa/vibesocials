import type { Platform } from "@prisma/client";

import { toConnectionSummary } from "@/lib/connectionSummary";
import { prisma } from "@/lib/db";
import { connectedAccountName } from "@/lib/differentAccount";
import { logger } from "@/lib/logger";
import { platformLabel } from "@/lib/platforms";
import { consumeFixedWindow } from "@/lib/rateLimit";
import { sendEmail } from "@/server/notifications/email";
import { workspaceLink } from "@/server/notifications/links";

/**
 * R7-client-journey L4: a client's reconnect through the workspace's connect
 * link came back with a different account than the one connected, so nothing
 * changed (server/connections/saveConnection.ts). The client is told to ask
 * the owner, so the owners hear of it here. Sent from the client's /c page,
 * which anyone holding the link can open with any query, so it goes out at
 * most once per connection per UTC day.
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

  const what = `<p>Your client used your connect link for <strong>${workspace}</strong> and signed in to a different ${platform} account than the one connected (<strong>${name}</strong>). Nothing was changed.</p>`;
  const next = `<p>If your client should post from their own account, disconnect ${name} in Settings, Connections; then they can connect theirs through the link. If ${name} is the right account, it has to be signed in to: use Reconnect in Settings, Connections, or ask your client to sign in to ${name}.</p>`;
  const link = base
    ? `<p><a href="${escapeHtml(workspaceLink(params.workspaceId, "/settings#connections", base))}">Open Settings, Connections</a></p>`
    : "<p>Open Settings, Connections in Vibe Socials to see it.</p>";

  return {
    subject: `${params.workspaceName.replace(/[\r\n]+/g, " ").trim()}: your client signed in to a different ${label} account`,
    html: [what, next, link, "<p>— Vibe Socials</p>"].join("\n"),
  };
}

function nextUtcMidnight(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
}

/** Email every owner, once per connection per UTC day. Never throws: the page still renders. */
export async function notifyOwnersOfRefusedConnect(params: { workspaceId: string; platform: Platform }): Promise<void> {
  try {
    const connection = await prisma.socialConnection.findUnique({
      where: { workspaceId_platform: { workspaceId: params.workspaceId, platform: params.platform } },
      select: { id: true, platform: true, accountIdentifier: true, metadata: true, needsReconnect: true },
    });
    if (!connection) return;

    const now = new Date();
    // Fail closed: a store error sends nothing rather than one email per page load.
    const { allowed } = await consumeFixedWindow({
      key: `refused-connect-email:${connection.id}:${now.toISOString().slice(0, 10)}`,
      limit: 1,
      resetAt: nextUtcMidnight(now),
      failClosed: true,
    });
    if (!allowed) return;

    const [workspace, owners] = await Promise.all([
      prisma.workspace.findUnique({ where: { id: params.workspaceId }, select: { name: true } }),
      prisma.workspaceMember.findMany({
        where: { workspaceId: params.workspaceId, role: "owner" },
        select: { user: { select: { email: true } } },
      }),
    ]);
    if (!workspace) return;

    const email = buildRefusedConnectEmail({
      platform: params.platform,
      workspaceId: params.workspaceId,
      workspaceName: workspace.name,
      connectedName: connectedAccountName(toConnectionSummary(connection)),
      appBaseUrl: process.env.NEXTAUTH_URL || null,
    });
    for (const owner of owners) {
      await sendEmail({ to: owner.user.email, ...email });
    }
  } catch (error) {
    logger.error("[connect-link] Couldn't email the owners about a refused client sign-in (ignored)", {
      workspaceId: params.workspaceId,
      platform: params.platform,
      error,
    });
  }
}
