/**
 * Client review link (2026-11-10): the pure parts shared by the owner routes,
 * the two public routes under /api/review-link/[token]/ and the /v/[token] page.
 *
 * The public routes are reachable without signing in, so the workspace always
 * comes from the link the token resolves to, and a decision can only touch a
 * post the page could have shown: that workspace's, still scheduled, inside
 * the page's window.
 */

/** Shown for an unknown AND a revoked link, so the two cannot be told apart. */
export const REVIEW_LINK_INACTIVE_MESSAGE = "This link is not active. Ask for a new one.";

/** Shown for a post that is not (or no longer) one the client may decide on. */
export const REVIEW_POST_LOCKED_MESSAGE = "This post can no longer be changed here.";

/** An approval of a version the client did not see: the post was edited since the page loaded. */
export const REVIEW_POST_CHANGED_MESSAGE =
  "This post was changed after you opened this page. Have a look at the new version.";

/** An approval that names no version (an old page, or not the page at all). */
export const REVIEW_VERSION_MISSING_MESSAGE = "Reload this page and try again.";

export const REVIEW_LINK_IP_LIMIT_MESSAGE =
  "Too many requests from this network in the last hour. Try again later.";

export const REVIEW_LINK_DAILY_LIMIT_MESSAGE =
  "This link has reached today's limit. Try again tomorrow.";

export const REVIEW_LINK_CREATE_LIMIT_MESSAGE =
  "Too many new links in the last hour. Try again later.";

export const REVIEW_DECISION_INVALID_MESSAGE = "Choose Looks good or Ask for a change.";

export const REVIEW_NOTE_MISSING_MESSAGE = "Write what you would like changed.";

export const REVIEW_NOTE_TOO_LONG_MESSAGE = "Keep the note to 500 characters or fewer.";

/** Requests one IP address makes in an hour, the list and the decisions together. */
export const REVIEW_LINK_IP_PER_HOUR = 120;
/** Decisions one link takes in a day. */
export const REVIEW_LINK_DECISIONS_PER_DAY = 300;
/** New links (create or replace) one owner makes in an hour. */
export const REVIEW_LINK_CREATES_PER_HOUR = 10;
/** Longest note, in characters. */
export const REVIEW_NOTE_MAX = 500;
/** How far ahead the page lists scheduled posts. */
export const REVIEW_WINDOW_DAYS = 60;
/** How long a change request stays on the page. */
export const REVIEW_CHANGE_SHOWN_DAYS = 30;
/** Most posts the page lists of each kind. */
export const REVIEW_LIST_MAX = 100;

export const DAY_MS = 24 * 60 * 60 * 1000;

/** The latest time the page lists, and so the latest a decision may touch. */
export function reviewWindowEnd(now: Date): Date {
  return new Date(now.getTime() + REVIEW_WINDOW_DAYS * DAY_MS);
}

export function reviewLinkUrl(baseUrl: string | undefined, token: string): string {
  return `${baseUrl ?? ""}/v/${token}`;
}

/** Tokens are 32 random bytes as base64url: anything else is not worth a lookup. */
export function isReviewLinkTokenShape(token: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/.test(token);
}

export type ReviewDecision =
  | { ok: true; decision: "approve"; version: Date }
  | { ok: true; decision: "change"; note: string }
  | { ok: false; error: string };

/**
 * The client's decision from a request body. Only `decision`, `version` and
 * `note` are read. An approval must name the version the client looked at
 * (the post's `updatedAt` exactly as the list gave it), so it can only land on
 * that text; a change request needs none. The note is plain text: control characters other than line breaks and
 * tabs are dropped, it is trimmed, and over 500 characters (whole characters,
 * so an emoji counts once) it is refused rather than cut, so the client knows.
 */
export function parseReviewDecision(body: unknown): ReviewDecision {
  const record = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  if (record.decision === "approve") {
    const version = typeof record.version === "string" ? new Date(record.version) : null;
    // Exactly the form the list sends, so no other spelling names some other instant.
    if (!version || Number.isNaN(version.getTime()) || version.toISOString() !== record.version) {
      return { ok: false, error: REVIEW_VERSION_MISSING_MESSAGE };
    }
    return { ok: true, decision: "approve", version };
  }
  if (record.decision !== "change") return { ok: false, error: REVIEW_DECISION_INVALID_MESSAGE };

  if (typeof record.note !== "string") return { ok: false, error: REVIEW_NOTE_MISSING_MESSAGE };
  const note = record.note
    .replace(/\r\n?/g, "\n")
    .replace(/[^\P{Cc}\n\t]/gu, "")
    .trim();
  if (!note) return { ok: false, error: REVIEW_NOTE_MISSING_MESSAGE };
  if (Array.from(note).length > REVIEW_NOTE_MAX) {
    return { ok: false, error: REVIEW_NOTE_TOO_LONG_MESSAGE };
  }
  return { ok: true, decision: "change", note };
}

/** Where the client stands on a post, as the page shows it. */
export type ReviewPostState = "none" | "approved" | "change_requested";

/**
 * One post as the public page receives it, and nothing more: no ids but the
 * post's own, no people, no settings, no tokens.
 */
export interface ReviewPostDTO {
  id: string;
  /** ISO-8601; the page shows it in the viewer's own time zone. */
  scheduledFor: string | null;
  /** Platform names, e.g. "Instagram". */
  platforms: string[];
  /** The main caption that will be published. */
  caption: string;
  /** Platforms with their own caption, by name. */
  platformCaptions: { label: string; text: string }[];
  /** The first file (its public storage address), or null. */
  media: { url: string; mimeType: string } | null;
  mediaCount: number;
  state: ReviewPostState;
  /** The client's own note, only on a change request. */
  note: string | null;
  /** The post's updatedAt (ISO-8601): an approval sends it back and lands only on this version. */
  version: string;
}
