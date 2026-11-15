import type { Platform } from "@prisma/client";

import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import { platformLabel } from "@/lib/platforms";
import { sendEmail } from "@/server/notifications/email";
import { emailDate } from "@/server/notifications/emailTime";
import { workspaceLink } from "@/server/notifications/links";

/**
 * Fix round 1, F4 (R1 M4): a client who connects an account through the
 * workspace's connect link (/c/<token>) is not the owner, so the owner would
 * not know. Every owner gets one email per successful connect, sent by the
 * connect-link callback wrapper (server/connectLink/callback.ts). A first
 * Google Business Profile connect starts without a business location, and
 * posts to Google fail until one is chosen, so that email says so; a
 * reconnect keeps the chosen location (R2-pages L6), so its email does not.
 * R10-client-journey L2: when LinkedIn answered the sign-in with the end date
 * the connection already had (same_end), posts after that date still fail, so
 * the email says that instead of that posts can go out.
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
  /** Google Business Profile only: the connection already has its business location. */
  locationChosen?: boolean;
  /** The sign-in kept the connection's end date: that date, as the recipient reads it. */
  keptEndDate?: string;
}): { subject: string; html: string } {
  const label = platformLabel(params.platform);
  const platform = escapeHtml(label);
  const workspace = escapeHtml(params.workspaceName);
  const needsLocation = params.platform === "google_business_profile" && !params.locationChosen;
  const base = params.appBaseUrl || null;

  const connected = `Your client connected <strong>${platform}</strong> to <strong>${workspace}</strong> through your connect link.`;
  const what = needsLocation
    ? `<p>${connected}</p>`
    : params.keptEndDate
      ? `<p>${connected} ${platform} kept the end date ${escapeHtml(params.keptEndDate)}; posts due after it fail until it is reconnected after that date.</p>`
      : `<p>${connected} Posts in ${workspace} can go to ${platform} now.</p>`;
  const location = needsLocation
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

/** Whether the workspace's Google connection has a business location (metadata.locationName). */
async function googleLocationChosen(workspaceId: string): Promise<boolean> {
  const connection = await prisma.socialConnection.findUnique({
    where: { workspaceId_platform: { workspaceId, platform: "google_business_profile" } },
    select: { metadata: true },
  });
  const metadata = connection?.metadata;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return false;
  const name = (metadata as Record<string, unknown>).locationName;
  return typeof name === "string" && name.trim() !== "";
}

/** The connection's stored end date (the one the sign-in kept), or null. */
async function storedEndDate(workspaceId: string, platform: Platform): Promise<Date | null> {
  const connection = await prisma.socialConnection.findUnique({
    where: { workspaceId_platform: { workspaceId, platform } },
    select: { expiresAt: true },
  });
  return connection?.expiresAt ?? null;
}

/**
 * Email every owner of the workspace. Never throws: the connect already succeeded.
 * `sameEnd`: the callback's same_end flag (the sign-in kept the end date).
 */
export async function notifyOwnersOfClientConnect(params: {
  workspaceId: string;
  platform: Platform;
  sameEnd?: boolean;
}): Promise<void> {
  try {
    const [workspace, owners] = await Promise.all([
      prisma.workspace.findUnique({ where: { id: params.workspaceId }, select: { name: true } }),
      prisma.workspaceMember.findMany({
        where: { workspaceId: params.workspaceId, role: "owner" },
        select: { user: { select: { id: true, email: true, timeZone: true } } },
      }),
    ]);
    if (!workspace) return;

    const locationChosen =
      params.platform === "google_business_profile" && (await googleLocationChosen(params.workspaceId));
    const keptEnd = params.sameEnd ? await storedEndDate(params.workspaceId, params.platform) : null;
    for (const owner of owners) {
      const email = buildClientConnectEmail({
        platform: params.platform,
        workspaceId: params.workspaceId,
        workspaceName: workspace.name,
        appBaseUrl: process.env.NEXTAUTH_URL || null,
        locationChosen,
        ...(keptEnd ? { keptEndDate: emailDate(keptEnd, owner.user.timeZone) } : {}),
      });
      await sendEmail({ to: owner.user.email, ...email }, { label: "client-connect" });
    }
  } catch (error) {
    logger.error("[connect-link] Couldn't email the owners about a client connect (ignored)", {
      workspaceId: params.workspaceId,
      platform: params.platform,
      error,
    });
  }
}
