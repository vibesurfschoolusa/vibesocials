import { SUPPORT_EMAIL } from "@/lib/siteInfo";
import { formatStorageGb, utcDateLabel, type UsageLimitKind } from "@/lib/usageLimits";

/**
 * Sent to every OWNER of a workspace the first time it hits one of its usage
 * limits in that limit's window (src/server/usage/workspaceUsage.ts). Pure
 * builder (tested); transport is the fail-safe sendEmail().
 */

/** Minimal HTML-entity escaper (same table as reconnectEmail.ts). */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function limitLines(kind: UsageLimitKind, limit: number, resetsAt: Date | null): [string, string, string] {
  switch (kind) {
    case "postsPerDay":
      return [
        `has reached its limit of ${limit} posts a day.`,
        "Drafts and posts scheduled for other days still work.",
        resetsAt
          ? `New posts for that day are possible again from 00:00 UTC on ${utcDateLabel(resetsAt)}.`
          : "New posts are possible again the next UTC day.",
      ];
    case "xPostsPerMonth":
      return [
        `has used its ${limit} X posts for this month.`,
        "Posts to every other platform still go out.",
        resetsAt ? `X posts start again on ${utcDateLabel(resetsAt)}.` : "X posts start again next month.",
      ];
    case "youtubeUploadsPerDay":
      return [
        `has reached its limit of ${limit} YouTube uploads a day.`,
        "Posts to every other platform still go out.",
        "YouTube uploads start again at midnight Pacific time.",
      ];
    case "storage":
      return [
        `has used all of its ${formatStorageGb(limit)} of media storage.`,
        "Posting with media already in the library still works.",
        "Uploads work again as soon as media is deleted on the Media page.",
      ];
  }
}

export function buildLimitReachedEmail(params: {
  workspaceName: string;
  kind: UsageLimitKind;
  /** The limit's number: posts or uploads, or bytes for storage. */
  limit: number;
  /** When the window ends; null for storage, which has none. */
  resetsAt: Date | null;
}): { subject: string; html: string } {
  const workspace = escapeHtml(params.workspaceName);
  const [reached, stillWorks, startsAgain] = limitLines(params.kind, params.limit, params.resetsAt);

  return {
    subject: `${params.workspaceName} reached a Vibe Socials limit`,
    html: [
      `<p><strong>${workspace}</strong> ${reached}</p>`,
      `<p>${stillWorks}</p>`,
      `<p>${startsAgain}</p>`,
      `<p>If you need a higher limit, write to ${SUPPORT_EMAIL} and we will raise it.</p>`,
      `<p>— Vibe Socials</p>`,
    ].join("\n"),
  };
}
