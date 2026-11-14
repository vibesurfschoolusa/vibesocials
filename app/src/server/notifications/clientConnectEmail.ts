import type { Platform } from "@prisma/client";

import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import { platformLabel } from "@/lib/platforms";
import { sendEmail } from "@/server/notifications/email";
import { workspaceLink } from "@/server/notifications/links";

/**
 * Fix round 1, F4 (R1 M4): a client who connects an account through the
 * workspace's connect link (/c/<token>) is not the owner, so the owner would
 * not know. Every owner gets one email per successful connect, sent by the
 * connect-link callback wrapper (server/connectLink/callback.ts). A Google
 * Business Profile connect starts without a business location, and posts to
 * Google fail until one is chosen, so that email says so.
 */

/** Minimal HTML-entity escaper (same table as the other email builders). */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function buildClientConnectEmail(params: {
  platform: Platform;
  workspaceId: string;
  workspaceName: string;
  /** `process.env.NEXTAUTH_URL`. Null renders the email with no link. */
  appBaseUrl: string | null;
}): { subject: string; html: string } {
  const label = platformLabel(params.platform);
  const platform = escapeHtml(label);
  const workspace = escapeHtml(params.workspaceName);
  const isGoogle = params.platform === "google_business_profile";
  const base = params.appBaseUrl || null;

  const what = isGoogle
    ? `<p>Your client connected <strong>${platform}</strong> to <strong>${workspace}</strong> through your connect link.</p>`
    : `<p>Your client connected <strong>${platform}</strong> to <strong>${workspace}</strong> through your connect link. Posts in ${workspace} can go to ${platform} now.</p>`;
  const location = isGoogle
    ? "<p>Before posts can go to Google, choose the business location: open Settings, Connections and pick it under Google Business Profile. Until then, posts to Google fail.</p>"
    : "";
  const link = base
    ? `<p><a href="${escapeHtml(workspaceLink(params.workspaceId, "/settings#connections", base))}">Open Settings, Connections</a></p>`
    : "<p>Open Settings, Connections in Vibe Socials to see it.</p>";

  return {
    subject: `${params.workspaceName.replace(/[\r\n]+/g, " ").trim()}: your client connected ${label}`,
    html: [what, location, link, "<p>— Vibe Socials</p>"].filter((part) => part !== "").join("\n"),
  };
}

/** Email every owner of the workspace. Never throws: the connect already succeeded. */
export async function notifyOwnersOfClientConnect(params: { workspaceId: string; platform: Platform }): Promise<void> {
  try {
    const [workspace, owners] = await Promise.all([
      prisma.workspace.findUnique({ where: { id: params.workspaceId }, select: { name: true } }),
      prisma.workspaceMember.findMany({
        where: { workspaceId: params.workspaceId, role: "owner" },
        select: { user: { select: { id: true, email: true } } },
      }),
    ]);
    if (!workspace) return;

    const email = buildClientConnectEmail({
      platform: params.platform,
      workspaceId: params.workspaceId,
      workspaceName: workspace.name,
      appBaseUrl: process.env.NEXTAUTH_URL || null,
    });
    for (const owner of owners) {
      await sendEmail({ to: owner.user.email, ...email });
    }
  } catch (error) {
    logger.error("[connect-link] Couldn't email the owners about a client connect (ignored)", {
      workspaceId: params.workspaceId,
      platform: params.platform,
      error,
    });
  }
}
