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
    [
      "This store code matches more than one Google Business Profile location. In Settings, choose the location from the list under Google Business Profile, or paste its full resource name under Advanced, then retry.",
      "This store code matches more than one Google Business Profile location. The workspace owner can choose the location; then retry.",
    ],
    [LINKEDIN_NOT_SUPER_ADMIN, linkedinNotSuperAdminMember],
    [
      GBP_ACCESS_REFUSED_TEXT,
      "Google refused this post, so nothing was posted: the connected Google account may no longer manage this Business Profile listing. The workspace owner can sign in to Google again with the account that manages this listing; then retry.",
    ],
    [
      YOUTUBE_UPLOAD_REFUSED_TEXT,
      "YouTube refused the upload, so nothing was posted. The workspace owner can check in YouTube Studio that this channel can upload videos; then retry.",
    ],
    [
      YOUTUBE_UPLOAD_NOT_ALLOWED_TEXT,
      "YouTube refused the upload, so nothing was posted: the upload permission wasn't granted when YouTube was connected. The workspace owner can reconnect YouTube and allow uploads; then retry.",
    ],
    // R19 publishing L6: the Business Profile location is chosen on an owner-only page.
    [GBP_NO_LOCATION, "Google Business Profile location is not configured. The workspace owner can choose the Business Profile location; then retry."],
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
 * R26 platform-clients L4: a Google 403 on a post that is not quota or our own
 * API setup is access, not the post breaking the platform's rules. Written by
 * googleBusinessProfileClient and youtubeClient; the member wording is above.
 */
export const GBP_ACCESS_REFUSED_TEXT =
  "Google refused this post, so nothing was posted: the connected Google account may no longer manage this Business Profile listing. Sign in to Google again on the Google Business Profile card in Settings, with the account that manages this listing, then retry.";
/** A Google 403 for our own API setup or quota (googleFailure.ts googlePublish403 "setup"): try later. */
export function googleSetupRefusedMessage(platform: Platform): string {
  return `${platformLabel(platform)} isn't answering for Vibe Socials right now, so nothing was posted. Try again later.`;
}
/** YouTube, a 403 for the missing upload scope: the row is flagged too, so the card shows Reconnect. */
export const YOUTUBE_UPLOAD_NOT_ALLOWED_TEXT =
  "YouTube refused the upload, so nothing was posted: the upload permission wasn't granted when YouTube was connected. Reconnect YouTube in Settings and allow uploads, then retry.";
/**
 * YouTube, any other 403 that is not quota: nothing is flagged, so no Settings
 * step is named. R28 publishing addendum L5: the row offers "Retry YouTube".
 */
export const YOUTUBE_UPLOAD_REFUSED_TEXT =
  "YouTube refused the upload, so nothing was posted. Check in YouTube Studio that this channel can upload videos, then retry.";

/** googleBusinessProfileClient's sentence for a connection with no location chosen. */
const GBP_NO_LOCATION = "Google Business Profile location is not configured. Choose the Business Profile location in Settings, then retry.";

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
  // R19 publishing L6: "Connections page" named no page a member (or anyone) can find.
  ["Google Business Profile location is not configured. Set it from the Connections page.", GBP_NO_LOCATION],
  // R20 publishing L2: Meta's 2xx without a container id, in the words used before R20.
  ["Instagram container creation failed (no container id in the answer)", "Instagram didn't answer as expected, so nothing was posted. Try again."],
  // R28 publishing addendum L5: the failed row has Retry, no "send it again".
  [
    "YouTube refused the upload, so nothing was posted. Check in YouTube Studio that this channel can upload videos, then send it again.",
    YOUTUBE_UPLOAD_REFUSED_TEXT,
  ],
]);

/** The clients' "Your <Platform> connection has expired / is no longer valid" sentences. */
const CONNECTION_STATE = /^Your (.+?) connection (has expired|is no longer valid)\b/;

/**
 * A step only an owner can take: connect or reconnect (with or without
 * "Settings"), signing in to Google again (the owner's in-place sign-in),
 * checking the channel in YouTube Studio, or anything in Settings. Choices on the post itself ("Choose Feed", TikTok
 * privacy) are the member's own and don't match.
 */
const OWNER_STEP = /\b(?:re)?connect\b|\bSettings\b|\bsign in to Google again\b|\bin YouTube Studio\b/i;

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
    return "The connected LinkedIn account is not a Super admin of any company page. The workspace owner can reconnect with an account that is a Super admin of one; then retry.";
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
export function storageReadFailedMessage(kind: "photo" | "video" | "file"): string {
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

/**
 * The codes the clients and largeUpload.ts give a failure to read the post's
 * own stored file. Storage, not the platform, answered, so the text never
 * depends on its status (R19 publishing L2 follow-up). Literals: this module
 * imports nothing from the server; its test checks the clients against it.
 */
export const STORAGE_READ_CODES: ReadonlySet<string> = new Set([
  "X_MEDIA_DOWNLOAD_FAILED",
  "TIKTOK_FETCH_VIDEO_FAILED",
  "LINKEDIN_IMAGE_DOWNLOAD_FAILED",
  "LINKEDIN_VIDEO_DOWNLOAD_FAILED",
  "YOUTUBE_FETCH_MEDIA_FAILED",
  "PINTEREST_VIDEO_DOWNLOAD_FAILED",
  "BLOB_READ_FAILED",
]);

/** The platform answered 5xx, still after the in-step retries (review round 2, item 3). */
export function platformDownMessage(platform: Platform): string {
  return `${platformLabel(platform)} had a problem on its side. Try again later.`;
}

/** Our own time limit ended a call before the post was sent (FETCH_TIMEOUT). */
export function notAnsweredInTimeMessage(platform: Platform): string {
  return `${platformLabel(platform)} didn't answer in time, so nothing was posted. Try again later.`;
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
// Database, network and host details that must never reach the user. ECONN is
// matched at a word start only: "Reconnect" holds the same letters (R26).
// R38: fetchWithTimeout's "Request timed out after 30000ms" too.
// R47 publishing "Text cost": a host and port is found by its last dotted part
// and the port ("x.example.com:443" by "e.com:443"), with no repeat inside a
// repeat. The old whole-name form rescanned to the end from every dot, so its
// cost grew with the square of the text (100,000 crafted characters: 13.5 s).
const INTERNALS =
  /timed out after \d+\s*ms|prisma|database|can't reach|\bECONN|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|getaddrinfo|socket|fetch failed|localhost|\b\d{1,3}(?:\.\d{1,3}){3}\b|[a-z0-9-]\.[a-z0-9-]+:\d{2,5}\b/i;

/** Would publishErrorMessage hide this text as an internal detail? A client checks before adding a platform's word. */
export function hasInternalDetail(text: string): boolean {
  return INTERNALS.test(text);
}

/**
 * The errorMessage stored for a platform error (L7; review round 2, item 3). In
 * order: a failure to read our own stored file reads its storage sentence,
 * whatever its status ({@link STORAGE_READ_CODES}); a token refresh failure reads the reconnect sentence only when it was
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

  // Our storage, not the platform, failed: its own sentence whatever the
  // status (a 401 or a 5xx from storage says nothing about the platform).
  if (STORAGE_READ_CODES.has(code)) {
    return message !== "" && statusLine === null && !INTERNALS.test(message) ? message : storageReadFailedMessage("file");
  }

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
  // R38 publishing L2: our own limit ended a call before the post (a commit
  // call's timeout is PUBLISH_UNCONFIRMED by then, commitCall.ts), and no
  // client wrote a sentence for it (fetchWithTimeout's own text is INTERNALS).
  // The code is fetchWithTimeout's FETCH_TIMEOUT_CODE, written out so this text
  // module does not load it; publishFailureText.test.ts keeps the two equal.
  if (code === "FETCH_TIMEOUT") return notAnsweredInTimeMessage(platform);
  if (status !== null && status >= 400) return platformRefusedMessage(platform);
  return notReachedMessage(platform);
}
