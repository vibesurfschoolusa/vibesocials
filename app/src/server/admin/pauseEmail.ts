import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import { SUPPORT_EMAIL } from "@/lib/siteInfo";
import { sendEmail } from "@/server/notifications/email";

/**
 * The owners' email when the operator pauses or resumes a workspace (/admin).
 * Pure builder plus a best-effort sender that never throws.
 */

export type PauseChangeKind = "pause" | "resume";

/** Minimal HTML-entity escaper (same table as limitReachedEmail.ts). */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function buildWorkspacePauseEmail(params: {
  kind: PauseChangeKind;
  workspaceName: string;
  reason: string | null;
}): { subject: string; html: string } {
  const workspace = escapeHtml(params.workspaceName);
  if (params.kind === "pause") {
    return {
      subject: `${params.workspaceName} is paused on Vibe Socials`,
      html: [
        `<p><strong>${workspace}</strong> was paused by Vibe Socials.</p>`,
        `<p>Reason: ${escapeHtml(params.reason ?? "")}</p>`,
        "<p>While it is paused, nobody in it can upload, create, schedule or publish posts. Scheduled posts that come due while it is paused are not published; they are marked failed, and you can retry them once it is active again.</p>",
        "<p>You can still sign in, see your posts and media, change settings, disconnect accounts and delete your account.</p>",
        `<p>To ask about this, write to ${SUPPORT_EMAIL}.</p>`,
        "<p>— Vibe Socials</p>",
      ].join("\n"),
    };
  }
  return {
    subject: `${params.workspaceName} is active again on Vibe Socials`,
    html: [
      `<p><strong>${workspace}</strong> is active again. You can upload, create, schedule and publish posts as before.</p>`,
      "<p>Posts that came due while it was paused were not published. Find them on the Activity page and retry the ones you still want to go out.</p>",
      `<p>Questions: ${SUPPORT_EMAIL}.</p>`,
      "<p>— Vibe Socials</p>",
    ].join("\n"),
  };
}

/**
 * Email every owner once about this pause or resume. `actionId` (the
 * AdminAction row) keys the send, so a repeat of the same change sends nothing
 * twice. Logs and swallows every failure: the change itself is already saved.
 */
export async function notifyOwnersOfPauseChange(args: {
  actionId: string;
  kind: PauseChangeKind;
  workspaceId: string;
  workspaceName: string;
  reason: string | null;
}): Promise<void> {
  try {
    const owners = await prisma.workspaceMember.findMany({
      where: { workspaceId: args.workspaceId, role: "owner" },
      select: { user: { select: { id: true, email: true } } },
    });
    const email = buildWorkspacePauseEmail(args);
    for (const owner of owners) {
      await sendEmail(
        { to: owner.user.email, ...email },
        { idempotencyKey: `workspace-pause/${args.actionId}/${owner.user.id}` },
      );
    }
  } catch (error) {
    logger.error("[admin] Couldn't email the owners about a pause change (ignored)", {
      error,
      workspaceId: args.workspaceId,
      kind: args.kind,
    });
  }
}
