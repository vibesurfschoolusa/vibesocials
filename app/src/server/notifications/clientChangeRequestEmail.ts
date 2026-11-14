import { emailDateTime } from "@/server/notifications/emailTime";
import { workspaceLink } from "@/server/notifications/links";

/**
 * Sent to every OWNER of a workspace when the client asks for a change to a
 * post through the review link (src/server/reviewLink.ts). Pure builder
 * (tested); transport is the fail-safe sendEmail().
 *
 * The note is typed by whoever has the link and the caption by the workspace,
 * so every value is escaped in the HTML. The time is shown in each owner's own
 * zone (User.timeZone, F4), or in UTC, labelled, when it is not known yet.
 */

/** Minimal HTML-entity escaper (same table as clientUploadEmail.ts). */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const CAPTION_PREVIEW_CHARS = 100;

function formatWhen(date: Date | null, timeZone: string | null): string {
  if (!date) return "No time set";
  return emailDateTime(date, timeZone);
}

export function buildClientChangeRequestEmail(params: {
  /** The link opens this workspace through /go (F4). */
  workspaceId: string;
  workspaceName: string;
  /** The recipient owner's User.timeZone; null shows UTC, labelled. */
  timeZone: string | null;
  scheduledFor: Date | null;
  caption: string;
  note: string;
  /** NEXTAUTH_URL; empty gives a relative link. */
  appUrl: string;
}): { subject: string; html: string } {
  const queueUrl = workspaceLink(params.workspaceId, "/queue", params.appUrl);
  const caption = Array.from(params.caption).slice(0, CAPTION_PREVIEW_CHARS).join("");

  return {
    subject: `${params.workspaceName}: your client asked for a change`,
    html: [
      `<p>Your client asked for a change to a post in <strong>${escapeHtml(params.workspaceName)}</strong>. It is out of the schedule and will not go out until you schedule it again.</p>`,
      `<p><strong>When:</strong> ${escapeHtml(formatWhen(params.scheduledFor, params.timeZone))}</p>`,
      `<p><strong>Caption:</strong> ${escapeHtml(caption)}</p>`,
      `<p><strong>Your client wrote:</strong></p>`,
      `<p style="white-space:pre-wrap">${escapeHtml(params.note)}</p>`,
      `<p><a href="${escapeHtml(queueUrl)}">Open the Queue</a></p>`,
      `<p>— Vibe Socials</p>`,
    ].join("\n"),
  };
}
