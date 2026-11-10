import type { Platform } from "@prisma/client";

import { platformLabel } from "@/lib/platforms";

/**
 * The daily problems email (2026-11-10), sent by the `daily-problem-digest`
 * cron to an owner whose workspaces need attention. Pure builder (tested);
 * transport is sendEmail(). Same shape as reconnectEmail.ts.
 */

/** One workspace's problems, as the digest collects them. */
export interface ProblemDigestWorkspace {
  workspaceId: string;
  name: string;
  /** Posts with a platform result that failed in the 24 hours before the run. */
  failedPosts: number;
  failedPlatforms: Platform[];
  needsReconnect: Platform[];
  waitingForApproval: number;
}

/** Minimal HTML-entity escaper (same table as reconnectEmail.ts). */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** "A", "A and B", "A, B and C". */
function joinNames(names: string[]): string {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

function platformNames(platforms: Platform[]): string {
  return joinNames(platforms.map(platformLabel));
}

/** The plain lines for one workspace, in a fixed order. */
function problemLines(workspace: ProblemDigestWorkspace): string[] {
  const lines: string[] = [];
  if (workspace.failedPosts > 0) {
    const posts = workspace.failedPosts === 1 ? "1 post" : `${workspace.failedPosts} posts`;
    lines.push(`${posts} failed on ${platformNames(workspace.failedPlatforms)}`);
  }
  if (workspace.needsReconnect.length > 0) {
    const verb = workspace.needsReconnect.length === 1 ? "needs" : "need";
    lines.push(`${platformNames(workspace.needsReconnect)} ${verb} reconnecting`);
  }
  if (workspace.waitingForApproval > 0) {
    lines.push(
      workspace.waitingForApproval === 1
        ? "1 post is waiting for your approval"
        : `${workspace.waitingForApproval} posts are waiting for your approval`,
    );
  }
  return lines;
}

export function buildProblemDigestEmail(params: {
  workspaces: ProblemDigestWorkspace[];
  /** `process.env.NEXTAUTH_URL`. Null renders the email with no link. */
  appBaseUrl: string | null;
}): { subject: string; html: string } {
  const count = params.workspaces.length;
  const subject =
    count === 1
      ? "Vibe Socials: 1 workspace needs attention"
      : `Vibe Socials: ${count} workspaces need attention`;

  const blocks = params.workspaces.map((workspace) => {
    const lines = problemLines(workspace).map((line) => `<li>${escapeHtml(line)}</li>`);
    return `<p><strong>${escapeHtml(workspace.name)}</strong></p>\n<ul>\n${lines.join("\n")}\n</ul>`;
  });

  // Trim a trailing slash so "https://host/" never yields "https://host//workspaces".
  const base = params.appBaseUrl ? params.appBaseUrl.replace(/\/+$/, "") : null;
  const linkLine = base
    ? `<p><a href="${base}/workspaces">See all your workspaces</a></p>`
    : `<p>Open Workspaces in Vibe Socials to see all your workspaces.</p>`;

  return {
    subject,
    html: [
      `<p>Here is what needs your attention today.</p>`,
      ...blocks,
      linkLine,
      `<p>To stop this daily email, turn it off in Settings, Notifications.</p>`,
      `<p>— Vibe Socials</p>`,
    ].join("\n"),
  };
}
