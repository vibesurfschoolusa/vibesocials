import type { Platform } from "@prisma/client";

import { PLATFORM_CAPTIONS_HEADING, platformCaptionEntries } from "@/lib/platforms";

/**
 * Approval workflow emails (2026-07-26 plan, Task 3). Pure builders — the
 * transport is the fail-safe sendEmail(). Same conventions as
 * reconnectEmail.ts: local HTML escaper, NEXTAUTH_URL-derived base with a
 * trailing-slash trim, and a linkless fallback when no base URL is configured.
 */

/** Minimal HTML-entity escaper (same table as postOutcomeEmail.ts). */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function normalizeBase(appBaseUrl: string | null): string | null {
  return appBaseUrl ? appBaseUrl.replace(/\/+$/, "") : null;
}

/** Short, safe preview of a caption for an email body. */
function captionBlock(caption: string): string {
  const trimmed = caption.trim();
  const shown = trimmed.length > 240 ? `${trimmed.slice(0, 240)}…` : trimmed;
  return `<blockquote style="margin:12px 0;padding-left:12px;border-left:3px solid #ddd">${escapeHtml(
    shown,
  )}</blockquote>`;
}

/**
 * 2026-11-01 audit (M1): the per-platform texts that replace the base caption
 * on their platforms. They are what is being approved, so each is shown in
 * full (unlike the base caption's 240-character preview) and HTML-escaped.
 * Empty string when the post has none.
 */
function platformCaptionsBlock(
  platformCaptions: Partial<Record<Platform, string>> | null | undefined,
): string {
  const entries = platformCaptionEntries(platformCaptions);
  if (entries.length === 0) return "";
  const items = entries.map(
    (entry) =>
      `<li style="margin:6px 0;white-space:pre-wrap"><strong>${escapeHtml(entry.label)}:</strong> ${escapeHtml(
        entry.text,
      )}</li>`,
  );
  return [
    `<p><strong>${PLATFORM_CAPTIONS_HEADING}</strong> — these replace the caption above on their platforms:</p>`,
    `<ul style="margin:12px 0;padding-left:20px">${items.join("")}</ul>`,
  ].join("\n");
}

/** "Thursday, November 12, 2026 (UTC)": the server does not know the owner's zone. */
function utcDate(date: Date): string {
  return `${date.toLocaleDateString("en-US", {
    timeZone: "UTC",
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  })} (UTC)`;
}

/** The line a held series adds; empty for a single post. */
function seriesLine(series: { count: number; first: Date; last: Date } | undefined): string {
  if (!series) return "";
  return `<p>This post repeats: ${series.count} posts from ${utcDate(series.first)} to ${utcDate(
    series.last,
  )}. Each one needs its own approval in the Queue.</p>`;
}

/** Sent to every workspace OWNER when a member submits a post for approval. */
export function buildApprovalRequestedEmail(params: {
  submitterName: string;
  workspaceName: string;
  caption: string;
  /** Per-platform overrides that will publish with the post; omit/null/empty for none. */
  platformCaptions?: Partial<Record<Platform, string>> | null;
  /** `process.env.NEXTAUTH_URL`. Omit/null to render the email with no link. */
  appBaseUrl: string | null;
  /** A held repeating post (brief 11): how many posts, and the first and last times. */
  series?: { count: number; first: Date; last: Date };
}): { subject: string; html: string } {
  const submitter = escapeHtml(params.submitterName);
  const workspace = escapeHtml(params.workspaceName);
  const base = normalizeBase(params.appBaseUrl);
  const cta = base
    ? `<p><a href="${base}/queue">Review it in the Queue</a></p>`
    : `<p>Review it in the Queue.</p>`;

  return {
    subject: `A post needs your approval in ${params.workspaceName}`,
    html: [
      `<p>${submitter} submitted a post in <strong>${workspace}</strong> and it is waiting for your approval.</p>`,
      captionBlock(params.caption),
      platformCaptionsBlock(params.platformCaptions),
      seriesLine(params.series),
      `<p>It will not publish until you approve it.</p>`,
      cta,
      `<p>— Vibe Socials</p>`,
    ]
      .filter((part) => part !== "")
      .join("\n"),
  };
}

/** Sent to the submitting member once an owner approves or rejects. */
export function buildApprovalDecisionEmail(params: {
  approved: boolean;
  workspaceName: string;
  caption: string;
  /** The post's scheduled time when approval scheduled it, else null. */
  scheduledFor: string | null;
  appBaseUrl: string | null;
}): { subject: string; html: string } {
  const workspace = escapeHtml(params.workspaceName);
  const base = normalizeBase(params.appBaseUrl);

  if (!params.approved) {
    const cta = base
      ? `<p><a href="${base}/queue">Open the Queue</a></p>`
      : `<p>Open the Queue to start another post.</p>`;
    return {
      subject: "Your post wasn't approved",
      html: [
        `<p>An owner of <strong>${workspace}</strong> reviewed your post and it will not be published.</p>`,
        captionBlock(params.caption),
        `<p>Ask them what to change, then submit a new version any time.</p>`,
        cta,
        `<p>— Vibe Socials</p>`,
      ].join("\n"),
    };
  }

  const outcome = params.scheduledFor
    ? `<p>It is approved and <strong>scheduled</strong> for ${escapeHtml(
        new Date(params.scheduledFor).toUTCString(),
      )}.</p>`
    : `<p>It is approved and <strong>publishing now</strong>.</p>`;
  const cta = base
    ? `<p><a href="${base}/activity">Track it in Activity</a></p>`
    : `<p>Track it in Activity.</p>`;

  return {
    subject: "Your post was approved",
    html: [
      `<p>An owner of <strong>${workspace}</strong> approved your post.</p>`,
      captionBlock(params.caption),
      outcome,
      cta,
      `<p>— Vibe Socials</p>`,
    ].join("\n"),
  };
}
