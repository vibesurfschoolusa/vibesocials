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

/** R9-client-journey L4: the reconnect sentence a member reads; only an owner can reconnect. */
export function memberReconnectMessage(platform: Platform): string {
  return `The workspace owner can reconnect ${platformLabel(platform)}; then retry.`;
}

/**
 * The member variant of each sentence a publish result can carry that tells
 * its reader to act in Settings: this module's own, and the ones the publish
 * run and the platform clients write (server/jobs, server/platforms; their
 * test runs every such literal through {@link sentenceForRecipient}).
 */
function memberVariants(platform: Platform): ReadonlyMap<string, string> {
  const label = platformLabel(platform);
  const reconnect = memberReconnectMessage(platform);
  const chooseBoard = `The workspace owner can reconnect ${label} and choose a board; then retry.`;
  const linkedinNotSuperAdminMember =
    "LinkedIn refused the post because the connected LinkedIn account is not a Super admin of this company page. A Super admin of the page can add that account as a Super admin (Page admin tools > Manage admins); then the workspace owner can reconnect LinkedIn.";
  return new Map([
    [reconnectRequiredMessage(platform), reconnect],
    [connectionGoneMessage(platform), `The workspace owner can connect ${label}; then retry.`],
    [
      renewalRefusedMessage(platform),
      `${label} didn't renew the connection. Try again later; if it keeps happening, the workspace owner can reconnect ${label}.`,
    ],
    ["This platform needs to be reconnected in Settings before publishing.", reconnect],
    ["This platform is no longer connected. Reconnect it in Settings and try again.", `${label} is no longer connected. ${reconnect}`],
    ["This platform connection was removed. Reconnect and retry.", `The ${label} connection was removed. ${reconnect}`],
    [
      "Could not find a Google Business Profile location for the given store code. Double-check the store code in Advanced settings.",
      "The workspace owner can check the store code for Google Business Profile; then retry.",
    ],
    [LINKEDIN_NOT_SUPER_ADMIN, linkedinNotSuperAdminMember],
    [
      "The Pinterest board this connection posts to no longer exists. Reconnect Pinterest in Settings and choose a board.",
      `The Pinterest board this connection posts to no longer exists. ${chooseBoard}`,
    ],
    [
      "No Pinterest board is chosen for this connection. Reconnect Pinterest in Settings and choose a board.",
      `No Pinterest board is chosen for this connection. ${chooseBoard}`,
    ],
  ]);
}

/** linkedinClient's sentence for an account that is not a Super admin of the page. */
const LINKEDIN_NOT_SUPER_ADMIN =
  "LinkedIn refused the post because the LinkedIn account you connected is not a Super admin of this company page. Ask a Super admin of the page to add that account as a Super admin (Page admin tools > Manage admins), then reconnect LinkedIn in Settings.";

/**
 * Sentences posts that failed earlier still carry, and the sentence written
 * for the same failure now, for every reader (R11-pages L1, R12-pages L5): a
 * Content admin can't be picked on reconnect, so the old advice misleads.
 */
const SUPERSEDED: ReadonlyMap<string, string> = new Map([
  [
    "LinkedIn refused the post because the LinkedIn account you connected is not an admin of this company page. Ask a page admin to add that account as a Super admin or Content admin (Page admin tools > Manage admins), then reconnect LinkedIn in Settings.",
    LINKEDIN_NOT_SUPER_ADMIN,
  ],
]);

/** The clients' "Your <Platform> connection has expired / is no longer valid" sentences. */
const CONNECTION_STATE = /^Your (.+?) connection (has expired|is no longer valid)\b/;

/**
 * A step only an owner can take: connect or reconnect (with or without
 * "Settings"), or anything in Settings. Choices on the post itself ("Choose
 * Feed", TikTok privacy) are the member's own and don't match.
 */
const OWNER_STEP = /\b(?:re)?connect\b|\bSettings\b/i;

/**
 * A stored result sentence as its reader should see it (R9-client-journey L4).
 * Only an owner can connect or reconnect, so a member gets the member variant
 * of any sentence that asks for such a step ({@link OWNER_STEP}): the exact one
 * above, or one of the client sentences below, each keeping its reason. A
 * sentence nobody wrote one for says the owner can fix the connection, not
 * "reconnect", since reconnecting may not be the step (R10-new-customer L2).
 * Owners, and every other sentence, read it as stored, except a superseded
 * sentence, which everyone reads in its current wording.
 */
export function sentenceForRecipient(
  message: string | null,
  platform: Platform,
  role: "owner" | "member",
): string | null {
  if (message !== null) message = SUPERSEDED.get(message.trim()) ?? message;
  if (role !== "member" || message === null || !OWNER_STEP.test(message)) return message;
  const exact = memberVariants(platform).get(message.trim());
  if (exact) return exact;
  // linkedinClient's no-organization help is several lines; its reason is kept.
  if (message.startsWith("No LinkedIn company pages configured")) {
    return "The connected LinkedIn account manages no company page. The workspace owner can reconnect with an account that manages one; then retry.";
  }
  const state = CONNECTION_STATE.exec(message);
  if (state) return `The ${state[1]} connection ${state[2]}. The workspace owner can reconnect ${state[1]}; then retry.`;
  // pinterestClient's renewal refusal carries the HTTP status.
  if (message.startsWith("Pinterest did not renew this connection")) {
    return "Pinterest did not renew this connection. If this keeps happening, the workspace owner can reconnect Pinterest.";
  }
  return `The workspace owner can fix ${platformLabel(platform)}'s connection; then retry.`;
}

/** A chosen platform with no connection at all when the post is sent (H1). */
export function connectionGoneMessage(platform: Platform): string {
  return `${platformLabel(platform)} is no longer connected. Connect it in Settings, then retry.`;
}

/** Why "Post now" could not send to a platform when the post was created (G1). */
export type NotSentReason = "RECONNECT_REQUIRED" | "CONNECTION_GONE";

export interface NotSentPlatform {
  platform: Platform;
  reason: NotSentReason;
}

/**
 * The platforms a new "Post now" failed up front (its connection needs
 * reconnecting, or is gone), once each across the feed and Story jobs, and
 * whether nothing at all is left to send. No rows (a scheduled post or a
 * draft) is not "all failed": nothing has been tried yet.
 */
export function notSentAtCreation(
  rows: readonly { platform: Platform; status: string; errorCode: string | null }[],
): { allFailed: boolean; notSent: NotSentPlatform[] } {
  const notSent: NotSentPlatform[] = [];
  for (const row of rows) {
    if (row.status !== "failed") continue;
    if (row.errorCode !== "RECONNECT_REQUIRED" && row.errorCode !== "CONNECTION_GONE") continue;
    if (notSent.some((entry) => entry.platform === row.platform)) continue;
    notSent.push({ platform: row.platform, reason: row.errorCode });
  }
  const allFailed = rows.length > 0 && rows.every((row) => row.status === "failed") && notSent.length > 0;
  return { allFailed, notSent };
}

function joinWithAnd(words: readonly string[]): string {
  return words.length <= 1 ? words.join("") : `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}

/**
 * What the composer says about them: "Nothing was sent: Reconnect X in
 * Settings, then use Retry in Activity." when nothing went out, "Not sent to
 * X: ..." beside the usual confirmation when the others did. A member can't
 * reconnect, so theirs names the owner instead (R10-client-journey L1).
 */
export function notSentSentence(
  notSent: readonly NotSentPlatform[],
  allFailed: boolean,
  role: "owner" | "member" = "owner",
): string {
  const labelsFor = (reason: NotSentReason) =>
    notSent.filter((entry) => entry.reason === reason).map((entry) => platformLabel(entry.platform));
  const reconnect = labelsFor("RECONNECT_REQUIRED");
  const connect = labelsFor("CONNECTION_GONE");
  const steps = [
    ...(reconnect.length > 0 ? [`reconnect ${joinWithAnd(reconnect)}`] : []),
    ...(connect.length > 0 ? [`connect ${joinWithAnd(connect)}`] : []),
  ];
  const what = steps.length > 1 ? `${steps.join(", and ")}, in Settings` : `${steps[0] ?? ""} in Settings`;
  const action =
    role === "member"
      ? `The workspace owner can ${steps.join(", and ")}; then use Retry in Activity.`
      : `${what.charAt(0).toUpperCase()}${what.slice(1)}, then use Retry in Activity.`;
  const lead = allFailed ? "Nothing was sent" : `Not sent to ${joinWithAnd(notSent.map((entry) => platformLabel(entry.platform)))}`;
  return `${lead}: ${action}`;
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

/**
 * A single photo or video our storage did not give back (R19 publishing L2):
 * nothing reached the platform, so its rules are not the cause. The words of
 * the several-photos sentence ("Photo 2 of 3 couldn't be read from storage").
 */
export function storageReadFailedMessage(kind: "photo" | "video"): string {
  return `The ${kind} couldn't be read from storage, so nothing was posted. Try again; if it fails again, create the post again with the ${kind}.`;
}

/**
 * assertOk's storage-download error with {@link storageReadFailedMessage} as
 * its text; the code and the status (retry classification) stay as they are.
 */
export function asStorageReadFailure(error: unknown, kind: "photo" | "video"): unknown {
  if (error instanceof Error) error.message = storageReadFailedMessage(kind);
  return error;
}

/** The platform answered 5xx, still after the in-step retries (review round 2, item 3). */
export function platformDownMessage(platform: Platform): string {
  return `${platformLabel(platform)} had a problem on its side. Try again later.`;
}

/**
 * No answer from the platform to judge: a network failure, our database, or an
 * error nobody wrote for the user. Not a refusal, so no rules advice.
 */
/**
 * A token refresh refused with a 4xx the refresher did not flag: our own app
 * setup (invalid_client) or a refusal it could not classify (e.g. TikTok 403).
 * Waiting fixes the first, reconnecting the second, so say both.
 */
export function renewalRefusedMessage(platform: Platform): string {
  const name = platformLabel(platform);
  return `${name} didn't renew the connection. Try again later; if it keeps happening, reconnect ${name} in Settings.`;
}

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
// The connection must be renewed: no refresh or access token stored, or a
// client's own reconnect code.
const RENEW_CODE = /(?:_NO_REFRESH_TOKEN|_NO_ACCESS_TOKEN|RECONNECT_REQUIRED)$/;
// A token refresh failed: renewal only if it was refused for good (below).
const REFRESH_FAILED_CODE = /_TOKEN_REFRESH_FAILED$/;
// Database, network and host details that must never reach the user.
const INTERNALS =
  /prisma|database|can't reach|ECONN|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|getaddrinfo|socket|fetch failed|localhost|\b\d{1,3}(?:\.\d{1,3}){3}\b|\b[a-z0-9-]+(?:\.[a-z0-9-]+)+:\d{2,5}\b/i;

/** Would publishErrorMessage hide this text as an internal detail? A client checks before adding a platform's word. */
export function hasInternalDetail(text: string): boolean {
  return INTERNALS.test(text);
}

/**
 * The errorMessage stored for a platform error (L7; review round 2, item 3). In
 * order: a token refresh failure reads the reconnect sentence only when it was
 * refused for good, that is when the refresher flagged the connection
 * (`connectionNeedsReconnect`; it never flags a 429, a 5xx or our own
 * invalid_client), or, when the caller cannot tell, on a 400/401; otherwise
 * "try again later" (second review, item 2). Then a connection that must be
 * renewed (its code, or a 401) reads the reconnect sentence, a removed one the
 * connection-gone sentence; a 5xx (the
 * in-step retries are over by now) is the platform's own problem; then the
 * client's own sentence, when it wrote one for the user; a 4xx is a refusal of
 * the post (the rules sentence); anything else did not reach the platform. The
 * raw text belongs in the server log only.
 */
export function publishErrorMessage(
  platform: Platform,
  error: { message?: unknown; code?: unknown; status?: unknown; connectionNeedsReconnect?: boolean },
): string {
  const message = typeof error.message === "string" ? error.message.trim() : "";
  const code = typeof error.code === "string" ? error.code : "";
  const statusLine = HTTP_STATUS_LINE.exec(message);
  const status =
    typeof error.status === "number" ? error.status : statusLine ? Number(statusLine[1]) : null;

  if (REFRESH_FAILED_CODE.test(code)) {
    const refusedForGood = error.connectionNeedsReconnect ?? (status === 400 || status === 401);
    if (refusedForGood) return reconnectRequiredMessage(platform);
    if (status !== null && status >= 400 && status < 500 && status !== 429) return renewalRefusedMessage(platform);
    return platformDownMessage(platform);
  }
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
