import { emailDate, emailDateTime } from "@/server/notifications/emailTime";
import { workspaceLink } from "@/server/notifications/links";

/**
 * Connection notices, sent to every OWNER of the workspace (pure builders,
 * tested; transport is the fail-safe sendEmail()):
 *  - the reconnect email, once per flag, when a connection has stopped working:
 *    a token refresh was refused for good, a post was answered with a dead-token
 *    error (Graph 190, a 401), or a sign-in that cannot be renewed lapsed
 *    (server/jobs/connectionNotices.ts);
 *  - the pre-expiry warning, a week before such a sign-in lapses.
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

/** "Reconnect <Platform> in Settings", linked through /go when there is a base URL. */
function reconnectLine(platform: string, workspaceId: string, base: string | null): string {
  return base
    ? `<p><a href="${escapeHtml(workspaceLink(workspaceId, "/settings#connections", base))}">Reconnect ${platform} in Settings</a>: it takes about a minute.</p>`
    : `<p>Reconnect ${platform} in Settings: it takes about a minute.</p>`;
}

/**
 * R5-client-journey L4: an agency's client often connected the account through a
 * connect link, and only the client can connect it again.
 */
function clientLine(workspaceId: string, base: string | null): string {
  const place = base
    ? `<a href="${escapeHtml(workspaceLink(workspaceId, "/settings#connect-link", base))}">Settings, Connections</a>`
    : "Settings, Connections";
  return `<p>If your client connected it, send them a connect link from ${place}.</p>`;
}

export function buildReconnectEmail(params: {
  platformLabel: string;
  /** The link opens this workspace's connections through /go (F4). */
  workspaceId: string;
  workspaceName: string;
  /** `process.env.NEXTAUTH_URL`. Omit/null to render the email with no link. */
  appBaseUrl: string | null;
  /**
   * "rejected" (default): the platform refused the sign-in. "expired": a sign-in
   * that cannot be renewed reached its end date.
   */
  reason?: "rejected" | "expired";
}): { subject: string; html: string } {
  const platform = escapeHtml(params.platformLabel);
  const workspace = escapeHtml(params.workspaceName);
  const base = params.appBaseUrl || null;
  const why =
    params.reason === "expired"
      ? `its sign-in expired, and ${platform} does not let us renew it automatically.`
      : `${platform} no longer accepts its sign-in, which usually means access was removed or the sign-in expired.`;

  return {
    // R2-pages L5: an owner of several workspaces sees which one is affected.
    subject: `Action needed: reconnect ${params.platformLabel} in ${subjectText(params.workspaceName)}`,
    html: [
      `<p>The ${platform} connection in <strong>${workspace}</strong> has stopped working: ${why}</p>`,
      `<p>Until it is reconnected, new and scheduled posts to ${platform} will fail.</p>`,
      reconnectLine(platform, params.workspaceId, base),
      clientLine(params.workspaceId, base),
      `<p>— Vibe Socials</p>`,
    ].join("\n"),
  };
}

/**
 * R5-publishing M1: the warning a week before a sign-in that cannot be renewed
 * (LinkedIn gives this app no refresh token) lapses. Dated in the owner's own
 * time zone (emailTime.ts), or in UTC labelled as such.
 */
export function buildExpiryWarningEmail(params: {
  platformLabel: string;
  workspaceId: string;
  workspaceName: string;
  expiresAt: Date;
  /** The owner's `User.timeZone`. */
  timeZone: string | null;
  appBaseUrl: string | null;
}): { subject: string; html: string } {
  const platform = escapeHtml(params.platformLabel);
  const workspace = escapeHtml(params.workspaceName);
  const base = params.appBaseUrl || null;
  const day = emailDate(params.expiresAt, params.timeZone);
  const moment = emailDateTime(params.expiresAt, params.timeZone);

  return {
    subject: `${params.platformLabel} needs reconnecting by ${day} (${subjectText(params.workspaceName)})`,
    html: [
      `<p>The ${platform} connection in <strong>${workspace}</strong> stops working on ${escapeHtml(moment)}. ${platform} does not let us renew this sign-in automatically, so it has to be connected again.</p>`,
      `<p>If it is not reconnected by then, new and scheduled posts to ${platform} will fail.</p>`,
      reconnectLine(platform, params.workspaceId, base),
      clientLine(params.workspaceId, base),
      `<p>— Vibe Socials</p>`,
    ].join("\n"),
  };
}
