import type { Platform } from "@prisma/client";

import { platformLabel } from "./platforms";

/**
 * Sentences a publish result or a post carries when it did not go out (F1, fix
 * round 1). No server-only imports: the Activity card reads them too.
 */

/** A chosen platform whose connection needs reconnecting when the post is sent (H1). */
export function reconnectRequiredMessage(platform: Platform): string {
  return `Reconnect ${platformLabel(platform)} in Settings, then retry.`;
}

/** A chosen platform with no connection at all when the post is sent (H1). */
export function connectionGoneMessage(platform: Platform): string {
  return `${platformLabel(platform)} is no longer connected. Connect it in Settings, then retry.`;
}

/**
 * A failed post with no results (H3; review round 2, item 4): no platform was
 * tried, because no connection could take it or because our side gave up after
 * 2 h. The job records neither cause, so the Activity card shows only this
 * sentence, true for both and for old jobs, next to its Send again button.
 */
export const NOT_SENT_MESSAGE = "This post was not sent. Use Send again to try once more.";

/** A 4xx refusal of the post whose error text was not written for the user (L7). */
export function platformRefusedMessage(platform: Platform): string {
  const label = platformLabel(platform);
  return `${label} did not accept the post. Try again; if it fails again, check the post meets ${label}'s rules.`;
}

/** The platform answered 5xx, still after the in-step retries (review round 2, item 3). */
export function platformDownMessage(platform: Platform): string {
  return `${platformLabel(platform)} had a problem on its side. Try again later.`;
}

/**
 * No answer from the platform to judge: a network failure, our database, or an
 * error nobody wrote for the user. Not a refusal, so no rules advice.
 */
export function notReachedMessage(platform: Platform): string {
  return `The post did not reach ${platformLabel(platform)}. Try again later.`;
}

// Our clients tag the errors they write for users with an UPPER_SNAKE code
// (TIKTOK_PRIVACY_REQUIRED, GBP_POST_REJECTED). Node and undici codes
// (ERR_*, UND_ERR_*), single-word system codes (ECONNRESET) and Prisma's
// (P2025) are not ours.
const OWN_CODE = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/;
const FOREIGN_CODE = /^(?:ERR_|UND_ERR)/;
// assertOk and the clients' HTTP helpers end a message with the status.
const HTTP_STATUS_LINE = /\(status (\d{3})\)\s*$/;
// The connection must be renewed: a token refresh the platform refused, no
// refresh or access token stored, or a client's own reconnect code.
const RENEW_CODE = /(?:_TOKEN_REFRESH_FAILED|_NO_REFRESH_TOKEN|_NO_ACCESS_TOKEN|RECONNECT_REQUIRED)$/;
// Database, network and host details that must never reach the user.
const INTERNALS =
  /prisma|database|can't reach|ECONN|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|getaddrinfo|socket|fetch failed|localhost|\b\d{1,3}(?:\.\d{1,3}){3}\b|\b[a-z0-9-]+(?:\.[a-z0-9-]+)+:\d{2,5}\b/i;

/**
 * The errorMessage stored for a platform error (L7; review round 2, item 3). In
 * order: a connection that must be renewed (its code, or a 401) reads the
 * reconnect sentence, a removed one the connection-gone sentence; a 5xx (the
 * in-step retries are over by now) is the platform's own problem; then the
 * client's own sentence, when it wrote one for the user; a 4xx is a refusal of
 * the post (the rules sentence); anything else did not reach the platform. The
 * raw text belongs in the server log only.
 */
export function publishErrorMessage(
  platform: Platform,
  error: { message?: unknown; code?: unknown; status?: unknown },
): string {
  const message = typeof error.message === "string" ? error.message.trim() : "";
  const code = typeof error.code === "string" ? error.code : "";
  const statusLine = HTTP_STATUS_LINE.exec(message);
  const status =
    typeof error.status === "number" ? error.status : statusLine ? Number(statusLine[1]) : null;

  if (RENEW_CODE.test(code) || status === 401) return reconnectRequiredMessage(platform);
  if (code === "CONNECTION_GONE") return connectionGoneMessage(platform);
  if (status !== null && status >= 500) return platformDownMessage(platform);
  const written =
    message !== "" &&
    OWN_CODE.test(code) &&
    !FOREIGN_CODE.test(code) &&
    statusLine === null &&
    !INTERNALS.test(message);
  if (written) return message;
  if (status !== null && status >= 400) return platformRefusedMessage(platform);
  return notReachedMessage(platform);
}
