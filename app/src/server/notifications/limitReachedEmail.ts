import { SUPPORT_EMAIL } from "@/lib/siteInfo";
import { formatStorageGb, utcDateLabel, utcDayMonthLabel, type UsageLimitKind } from "@/lib/usageLimits";
import { countWord } from "@/lib/plural";

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

/** The sentence after the workspace's name, then the body's other lines. */
function limitLines(
  kind: UsageLimitKind,
  limit: number,
  resetsAt: Date | null,
  day: Date | null,
): [string, ...string[]] {
  switch (kind) {
    case "postsPerDay":
      // The full day can be a future one (a post scheduled into it), which does
      // not "open again": name the day and say only what is true.
      return [
        `reached its limit of ${limit} ${countWord(limit, "post", "posts")} for ${day ? utcDayMonthLabel(day) : "that day"}. Posts on other days are not affected.`,
      ];
    case "xPostsPerMonth":
      return [
        `has used its ${limit} ${countWord(limit, "X post", "X posts")} for this month.`,
        "Posts to every other platform still go out.",
        resetsAt ? `X posts start again on ${utcDateLabel(resetsAt)}.` : "X posts start again next month.",
      ];
    case "youtubeUploadsPerDay":
      return [
        `has reached its limit of ${limit} ${countWord(limit, "YouTube upload", "YouTube uploads")} a day.`,
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
  /** When the limit starts again (X, YouTube); null when the email names no such time. */
  resetsAt: Date | null;
  /** Posts per day only: the UTC day that is full. */
  day?: Date | null;
}): { subject: string; html: string } {
  const workspace = escapeHtml(params.workspaceName);
  const [reached, ...rest] = limitLines(params.kind, params.limit, params.resetsAt, params.day ?? null);

  return {
    subject: `${params.workspaceName} reached a Vibe Socials limit`,
    html: [
      `<p><strong>${workspace}</strong> ${reached}</p>`,
      ...rest.map((line) => `<p>${line}</p>`),
      `<p>If you need a higher limit, write to ${SUPPORT_EMAIL} and we will raise it.</p>`,
      `<p>— Vibe Socials</p>`,
    ].join("\n"),
  };
}
