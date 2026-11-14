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
 * A scheduled post that kept failing on our side before any platform was tried
 * (H3). The job then has no results to carry a message, so the Activity card
 * shows this one.
 */
export const OUR_SIDE_FAILURE_MESSAGE =
  "This post could not be sent because of a problem on our side. Use Post now to send it again.";

/** What a platform's refusal reads when its error text was not written for the user (L7). */
export function platformRefusedMessage(platform: Platform): string {
  const label = platformLabel(platform);
  return `${label} did not accept the post. Try again; if it fails again, check the post meets ${label}'s rules.`;
}

// Our clients tag the errors they write for users with an UPPER_SNAKE code
// (TIKTOK_PRIVACY_REQUIRED, GBP_POST_REJECTED). Node and undici codes
// (ERR_*, UND_ERR_*), single-word system codes (ECONNRESET) and Prisma's
// (P2025) are not ours.
const OWN_CODE = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/;
const FOREIGN_CODE = /^(?:ERR_|UND_ERR)/;
// assertOk and the clients' HTTP helpers end a message with the status.
const HTTP_STATUS_LINE = /\(status \d{3}\)\s*$/;
// Database, network and host details that must never reach the user.
const INTERNALS =
  /prisma|database|can't reach|ECONN|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|getaddrinfo|socket|fetch failed|localhost|\b\d{1,3}(?:\.\d{1,3}){3}\b|\b[a-z0-9-]+(?:\.[a-z0-9-]+)+:\d{2,5}\b/i;

/**
 * The errorMessage stored for a platform error (L7): the client's own sentence
 * when it wrote one for the user, else the platform's plain sentence. The raw
 * text belongs in the server log only.
 */
export function publishErrorMessage(
  platform: Platform,
  error: { message?: unknown; code?: unknown },
): string {
  const message = typeof error.message === "string" ? error.message.trim() : "";
  const code = typeof error.code === "string" ? error.code : "";
  const written =
    message !== "" &&
    OWN_CODE.test(code) &&
    !FOREIGN_CODE.test(code) &&
    !HTTP_STATUS_LINE.test(message) &&
    !INTERNALS.test(message);
  return written ? message : platformRefusedMessage(platform);
}
