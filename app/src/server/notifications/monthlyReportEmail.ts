import { monthLabel, numberLine, type MonthlyReport } from "@/lib/monthlyReport";

/**
 * The monthly report email (18b), sent by the `monthly-report-email` cron to a
 * workspace's owners. Pure builder (tested); transport is sendEmail(). It
 * states the report object's own numbers, so the email and the page agree.
 * It never carries the client review link or its token: only whether one is on.
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

/** The listing's four numbers, labelled as the report page labels them. */
const LISTING_LINES = [
  { key: "views", label: "Views (Search and Maps)" },
  { key: "calls", label: "Calls" },
  { key: "directionRequests", label: "Direction requests" },
  { key: "websiteClicks", label: "Website clicks" },
] as const;

export function buildMonthlyReportEmail(params: {
  report: MonthlyReport;
  /** `process.env.NEXTAUTH_URL`. Null renders the email with no link. */
  appBaseUrl: string | null;
  /** The workspace has an active client review link. */
  hasClientLink: boolean;
}): { subject: string; html: string } {
  const { report } = params;
  const month = monthLabel(report.month);
  const name = escapeHtml(report.workspaceName);
  const lines: string[] = [];

  if (report.logoUrl) {
    lines.push(`<img src="${escapeHtml(report.logoUrl)}" alt="${name}" style="max-height:48px;width:auto">`);
  }
  lines.push(`<p>Here is the report for <strong>${name}</strong> for ${escapeHtml(month)}.</p>`);

  lines.push(`<p>Posts published: ${report.postCount}</p>`);
  if (report.totals.resultsByPlatform.length > 0) {
    const items = report.totals.resultsByPlatform.map(
      (entry) => `<li>${escapeHtml(entry.platform)}: ${entry.count}</li>`,
    );
    lines.push(`<ul>\n${items.join("\n")}\n</ul>`);
  }
  if (report.totals.numbers.length > 0) {
    const items = report.totals.numbers.map((total) => `<li>${escapeHtml(numberLine(total))}</li>`);
    lines.push(`<ul>\n${items.join("\n")}\n</ul>`);
    if (report.postCount > report.posts.length) {
      lines.push(`<p>The numbers cover the ${report.posts.length} most recent posts.</p>`);
    }
  }

  if (report.listing) {
    const { listing } = report;
    lines.push(`<p><strong>Google listing</strong></p>`);
    lines.push(
      `<p>Numbers for ${listing.daysCovered} of ${listing.daysCounted} days${listing.partial ? " so far" : ""}.</p>`,
    );
    const items = LISTING_LINES.map(({ key, label }) => `<li>${label}: ${listing.totals[key]}</li>`);
    lines.push(`<ul>\n${items.join("\n")}\n</ul>`);
  }

  // Trim a trailing slash so "https://host/" never yields "https://host//reports".
  const base = params.appBaseUrl ? params.appBaseUrl.replace(/\/+$/, "") : null;
  if (base) {
    const href = escapeHtml(`${base}/reports?month=${encodeURIComponent(report.month)}`);
    lines.push(
      `<p><a href="${href}" style="display:inline-block;padding:10px 16px;background:#111827;color:#ffffff;text-decoration:none;border-radius:6px">Open the report</a></p>`,
    );
  } else {
    lines.push(`<p>Open Reports in Vibe Socials to see the full report.</p>`);
  }
  if (params.hasClientLink) {
    lines.push(`<p>Your client can open the same report from their review link.</p>`);
  }

  lines.push(`<p>To stop this monthly email, turn it off in Settings, Notifications.</p>`);
  lines.push(`<p>— Vibe Socials</p>`);

  return { subject: `${report.workspaceName}: your report for ${month}`, html: lines.join("\n") };
}
