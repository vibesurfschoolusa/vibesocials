import { workspaceLink } from "@/server/notifications/links";

/**
 * Proactive reconnect notice, sent by the connectionHealthSweep cron to every
 * OWNER of the workspace whose connection just terminally failed a token
 * refresh — BEFORE a scheduled post fails on it. Pure builder (tested);
 * transport is the fail-safe sendEmail().
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

/** A workspace name on one line, safe for a subject header. */
function subjectText(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

export function buildReconnectEmail(params: {
  platformLabel: string;
  /** The link opens this workspace's connections through /go (F4). */
  workspaceId: string;
  workspaceName: string;
  /** `process.env.NEXTAUTH_URL`. Omit/null to render the email with no link. */
  appBaseUrl: string | null;
}): { subject: string; html: string } {
  const platform = escapeHtml(params.platformLabel);
  const workspace = escapeHtml(params.workspaceName);
  const base = params.appBaseUrl || null;
  const reconnectLine = base
    ? `<p><a href="${escapeHtml(workspaceLink(params.workspaceId, "/settings#connections", base))}">Reconnect ${platform} in Settings</a> — it takes about a minute.</p>`
    : `<p>Reconnect ${platform} in Settings — it takes about a minute.</p>`;

  return {
    // R2-pages L5: an owner of several workspaces sees which one is affected.
    subject: `Action needed: reconnect ${params.platformLabel} in ${subjectText(params.workspaceName)}`,
    html: [
      `<p>The ${platform} connection in <strong>${workspace}</strong> has stopped working — the platform rejected our renewal, which usually means the authorization was revoked or expired.</p>`,
      `<p>Until it is reconnected, new and scheduled posts to ${platform} will fail.</p>`,
      reconnectLine,
      `<p>— Vibe Socials</p>`,
    ].join("\n"),
  };
}
