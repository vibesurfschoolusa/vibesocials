import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import { sendEmail } from "@/server/notifications/email";
import { workspaceLink } from "@/server/notifications/links";

/**
 * R2-client-journey L3: anyone holding the workspace's invite link can join
 * it, so every owner is told about each new member, with a way to remove them
 * and to revoke the link. Sent by POST /api/invites/[token]/accept only when
 * the accept added a membership (not for someone already in the workspace).
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

/** One line, safe for a subject header. */
function oneLine(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

export function buildMemberJoinedEmail(params: {
  memberName: string | null;
  memberEmail: string;
  workspaceId: string;
  workspaceName: string;
  /** `process.env.NEXTAUTH_URL`. Null renders the email with no link. */
  appBaseUrl: string | null;
}): { subject: string; html: string } {
  const name = params.memberName?.trim() || null;
  const who = name
    ? `<strong>${escapeHtml(name)}</strong> (${escapeHtml(params.memberEmail)})`
    : `<strong>${escapeHtml(params.memberEmail)}</strong>`;
  const workspace = escapeHtml(params.workspaceName);
  const base = params.appBaseUrl || null;
  const link = base
    ? `<p><a href="${escapeHtml(workspaceLink(params.workspaceId, "/settings#team", base))}">Open Settings, Team</a></p>`
    : "";

  return {
    subject: `${oneLine(params.workspaceName)}: ${oneLine(name ?? params.memberEmail)} joined through your invite link`,
    html: [
      `<p>${who} joined <strong>${workspace}</strong> as a member through your invite link.</p>`,
      "<p>If you don't know them, remove them in Settings, Team. To stop more people joining, revoke the invite link there.</p>",
      link,
      "<p>— Vibe Socials</p>",
    ]
      .filter((part) => part !== "")
      .join("\n"),
  };
}

/** Email every owner of the workspace. Never throws: the person has already joined. */
export async function notifyOwnersOfMemberJoined(params: {
  workspaceId: string;
  member: { name: string | null; email: string };
}): Promise<void> {
  try {
    const [workspace, owners] = await Promise.all([
      prisma.workspace.findUnique({ where: { id: params.workspaceId }, select: { name: true } }),
      prisma.workspaceMember.findMany({
        where: { workspaceId: params.workspaceId, role: "owner" },
        select: { user: { select: { email: true } } },
      }),
    ]);
    if (!workspace) return;

    const email = buildMemberJoinedEmail({
      memberName: params.member.name,
      memberEmail: params.member.email,
      workspaceId: params.workspaceId,
      workspaceName: workspace.name,
      appBaseUrl: process.env.NEXTAUTH_URL || null,
    });
    for (const owner of owners) {
      await sendEmail({ to: owner.user.email, ...email });
    }
  } catch (error) {
    logger.error("[invites] Couldn't email the owners about a new member (ignored)", {
      workspaceId: params.workspaceId,
      error,
    });
  }
}
