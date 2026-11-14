import { safeCallbackPath } from "@/lib/safeRedirect";

/**
 * Links in notification emails (fix round 1, F4). The active workspace is one
 * cookie, so a plain "/queue" link opened while another workspace is active
 * shows the wrong one. Every email link goes through GET /go instead, which
 * switches to the email's workspace (members only) and then opens the page.
 */

/** The Settings section that holds the email switches (src/app/settings/sections.ts). */
export const EMAIL_SETTINGS_PATH = "/settings#post-defaults";

/** Minimal HTML-entity escaper (same table as the email builders). */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * The /go address that opens `path` in `workspaceId`. Absolute with a base
 * (NEXTAUTH_URL by default), relative without one. Not HTML-escaped.
 */
export function workspaceLink(
  workspaceId: string,
  path: string,
  appBaseUrl: string | null | undefined = process.env.NEXTAUTH_URL,
): string {
  const base = (appBaseUrl ?? "").replace(/\/+$/, "");
  return `${base}/go?w=${encodeURIComponent(workspaceId)}&to=${encodeURIComponent(path)}`;
}

/** Where /go sends the browser: `to` when it is a same-site path, else "/". */
export function goTarget(to: string | null | undefined): string {
  return safeCallbackPath(to, "/");
}

/**
 * The closing line every opt-out email ends with: what to switch off, in
 * Settings, Posts and emails, linked through /go when there is a base URL.
 * `action` is plain text ("turn off ..."); it is escaped here.
 */
export function emailSettingsLine(params: {
  action: string;
  workspaceId: string;
  appBaseUrl: string | null;
}): string {
  const base = params.appBaseUrl ? params.appBaseUrl.replace(/\/+$/, "") : null;
  const place = base
    ? `<a href="${escapeHtml(workspaceLink(params.workspaceId, EMAIL_SETTINGS_PATH, base))}">Settings, Posts and emails</a>`
    : "Settings, Posts and emails";
  return `<p>To stop these emails, ${escapeHtml(params.action)} in ${place}.</p>`;
}
