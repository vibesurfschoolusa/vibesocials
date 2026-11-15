import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import { sendEmail } from "@/server/notifications/email";
import { workspaceLink } from "@/server/notifications/links";

/**
 * R5-security L1 (2026-11-14): an owner can copy the client upload link and
 * the client review link, and both keep working after that owner is demoted
 * or leaves. The owners who remain are emailed that the person had them, and
 * the demote answer offers "Make new client links" (POST
 * /api/workspaces/client-links, which replaces both at once).
 */

/** Settings, Team: where the owners make new client links. */
export const CLIENT_LINKS_SETTINGS_PATH = "/settings#team";

/** Minimal HTML-entity escaper (same table as the email builders). */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function buildFormerOwnerEmail(input: {
  workspaceId: string;
  workspaceName: string;
  formerOwnerName: string;
  uploadLink: boolean;
  reviewLink: boolean;
  appBaseUrl: string | null | undefined;
}): { subject: string; html: string; text: string } {
  const { workspaceName, formerOwnerName } = input;
  const both = input.uploadLink && input.reviewLink;
  const links = both
    ? "client upload link and client review link, and those links still work"
    : `client ${input.uploadLink ? "upload" : "review"} link, and that link still works`;
  const lines = [
    `${formerOwnerName} is no longer an owner of ${workspaceName}. As an owner, ${formerOwnerName} had access to its ${links}.`,
    `To stop ${both ? "them" : "it"} working, open Settings, Team and press "Make new client links". It replaces ${both ? "both at once" : "it"}; send the new ${both ? "links" : "link"} to your client.`,
  ];
  const href = workspaceLink(input.workspaceId, CLIENT_LINKS_SETTINGS_PATH, input.appBaseUrl);
  return {
    subject: `Make new client links for ${workspaceName}`,
    text: `${lines.join("\n\n")}\n\nOpen Settings, Team: ${href}\n`,
    html: `${lines.map((line) => `<p>${escapeHtml(line)}</p>`).join("")}<p><a href="${escapeHtml(href)}">Open Settings, Team</a></p>`,
  };
}

/**
 * After `formerOwner` stopped being an owner of the workspace (demoted, or
 * left): when a client upload or review link is on, emails each remaining
 * owner once and answers that the links should be replaced. Best-effort and
 * never throws: the change it follows has already been made.
 */
export async function noticeOwnersOfFormerOwner(input: {
  workspaceId: string;
  workspaceName: string;
  formerOwnerId: string;
  /** Given when the person is being deleted, so their row cannot be read. */
  formerOwnerName?: string;
  at: Date;
}): Promise<{ clientLinksToReplace: boolean }> {
  const { workspaceId, formerOwnerId } = input;
  let links: { uploadLink: boolean; reviewLink: boolean };
  try {
    const [upload, review] = await Promise.all([
      prisma.workspaceUploadLink.findFirst({ where: { workspaceId, revokedAt: null }, select: { id: true } }),
      prisma.workspaceReviewLink.findFirst({ where: { workspaceId, revokedAt: null }, select: { id: true } }),
    ]);
    links = { uploadLink: upload !== null, reviewLink: review !== null };
  } catch (error) {
    logger.error("[workspaces] Couldn't read the client links after an owner stepped down", { error, workspaceId });
    return { clientLinksToReplace: false };
  }
  if (!links.uploadLink && !links.reviewLink) return { clientLinksToReplace: false };

  try {
    const [former, owners] = await Promise.all([
      input.formerOwnerName
        ? Promise.resolve({ name: input.formerOwnerName, email: input.formerOwnerName })
        : prisma.user.findUnique({ where: { id: formerOwnerId }, select: { name: true, email: true } }),
      prisma.workspaceMember.findMany({
        where: { workspaceId, role: "owner", userId: { not: formerOwnerId } },
        select: { user: { select: { id: true, email: true } } },
      }),
    ]);
    const email = buildFormerOwnerEmail({
      workspaceId,
      workspaceName: input.workspaceName,
      formerOwnerName: former?.name?.trim() || former?.email || "A former owner",
      ...links,
      appBaseUrl: process.env.NEXTAUTH_URL || null,
    });
    for (const owner of owners) {
      await sendEmail(
        { to: owner.user.email, ...email },
        {
          idempotencyKey: `former-owner-links/${workspaceId}/${formerOwnerId}/${input.at.toISOString()}/${owner.user.id}`,
        },
      );
    }
  } catch (error) {
    logger.error("[workspaces] Couldn't email the owners about the client links", {
      error: error instanceof Error ? error.name : typeof error,
      workspaceId,
    });
  }
  return { clientLinksToReplace: true };
}
