/**
 * What the composer does with a `POST /api/posts` response.
 *
 * - `success` — the post was created: reset the form and show the success
 *   banner (copy depends on the mode and on whether it was held for approval).
 * - `dispatch_failed` — 503 `{ code: "DISPATCH_FAILED", postJobId }`
 *   (2026-11-01 audit, final review M3): the job WAS created, but its publish
 *   event couldn't be handed off, so the job is already `failed` in Activity.
 *   Keeping the form filled and saying "Please try again." invited a second
 *   Post press → a second job, and retrying the first one later published the
 *   same content twice. So the form resets exactly like a success and the user
 *   is sent to Activity to retry the job that exists. With `resultsMarked:
 *   false` the job may show as publishing first (KK4), and the toast says so.
 * - `workspace_changed` — 409 `{ code: "WORKSPACE_CHANGED" }` (2026-11-01 audit,
 *   M3): the workspace cookie changed in another tab, so the server refused
 *   before writing anything. Nothing was created and the form is kept (the
 *   user's file and caption survive), but resending can never succeed until the
 *   page is reloaded, so the composer pins the message instead of only toasting.
 * - `error` — nothing was created: keep the form so the user can fix and resend.
 */

import { PLATFORM_ORDER } from "./platforms";
import { notSentSentence, type NotSentPlatform } from "./publishFailureText";
import { WORKSPACE_CHANGED_CODE, WORKSPACE_CHANGED_MESSAGE } from "./workspaceChanged";

/** How the composer was asked to publish (mirrors create-post-form.tsx). */
export type ComposerPublishMode = "now" | "schedule" | "draft";

export type ComposerSubmitOutcome =
  | {
      kind: "success";
      resetForm: true;
      heldForApproval: boolean;
      toast: string;
      /**
       * G1: a "Post now" whose chosen platforms failed up front (reconnect, or
       * no connection). Absent when every platform was sent. `allFailed`: nothing
       * went out, so the composer warns instead of confirming.
       */
      notSent?: { allFailed: boolean; text: string };
    }
  | { kind: "dispatch_failed"; resetForm: true; toast: string }
  | { kind: "workspace_changed"; resetForm: false; toast: string }
  | { kind: "error"; resetForm: false; toast: string };

export const COMPOSER_DISPATCH_FAILED_MESSAGE =
  "Saved, but publishing couldn't start — retry it from Activity.";

/**
 * KK4: the 503 says `resultsMarked: false` when the route couldn't mark the
 * results failed. Activity then shows the post as publishing until the
 * stuck-job reconciler fails it: it takes jobs untouched for 2 hours, on a scan
 * every 10 minutes, later when a batch is waiting. Retry is offered from then on.
 */
function dispatchUnmarkedText(button: DispatchFailedButton): string {
  const done = button === "Approve" ? "approved" : "saved";
  return `The post was ${done} but didn't start. In Activity it can show as publishing for about two hours, sometimes a little longer, before it shows as failed; then retry it there. Don't press ${button} again.`;
}

export const COMPOSER_DISPATCH_UNMARKED_MESSAGE = dispatchUnmarkedText("Post");

/** The button a second press of which would only make things worse. */
export type DispatchFailedButton = "Post" | "Publish" | "Approve";

/**
 * R26 LL3: the one rule for a `DISPATCH_FAILED` 503 (Create, and the Queue's
 * Publish now and Approve): retry from Activity, or, when the results could
 * not be marked, the "about two hours" sentence naming the pressed button.
 */
export function dispatchFailedText(body: unknown, button: DispatchFailedButton = "Post"): string {
  if (field(body, "resultsMarked") === false) return dispatchUnmarkedText(button);
  // R26 LL3 follow-up: an approval is what stood, so Approve says so.
  return button === "Approve" ? "Approved, but publishing couldn't start — retry it from Activity." : COMPOSER_DISPATCH_FAILED_MESSAGE;
}

const FALLBACK_ERROR = "Failed to create post.";

function field(body: unknown, key: string): unknown {
  return typeof body === "object" && body !== null ? (body as Record<string, unknown>)[key] : undefined;
}

/** The response's `notSent` entries this client can name; anything else is ignored. */
function readNotSent(value: unknown): NotSentPlatform[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): NotSentPlatform[] => {
    const platform = field(entry, "platform");
    const reason = field(entry, "reason");
    const known = PLATFORM_ORDER.find((p) => p === platform);
    if (!known || (reason !== "RECONNECT_REQUIRED" && reason !== "CONNECTION_GONE")) return [];
    return [{ platform: known, reason }];
  });
}

/** The page a created post is listed on. */
export type PostDestination = "activity" | "queue";

/**
 * Where a post lands: a Post now goes to Activity; a schedule, a draft and a
 * post held for approval wait in the Queue. The success text, the success
 * banner's link and the lost-connection sentence (postSubmitFailure.ts) all
 * read this one rule.
 */
export function postDestination(mode: ComposerPublishMode, heldForApproval: boolean): PostDestination {
  return heldForApproval || mode !== "now" ? "queue" : "activity";
}

function successToast(mode: ComposerPublishMode, heldForApproval: boolean): string {
  if (heldForApproval) return "Sent for approval — an owner will review it before it publishes";
  if (postDestination(mode, heldForApproval) === "activity") return "Post queued — track it in Activity";
  return mode === "draft" ? "Draft saved — find it in your Queue" : "Post scheduled — see it in your Queue";
}

export function composerSubmitOutcome(input: {
  /** `response.ok`. */
  ok: boolean;
  /** The parsed JSON body, or null when it couldn't be read. */
  body: unknown;
  mode: ComposerPublishMode;
}): ComposerSubmitOutcome {
  const { ok, body, mode } = input;

  if (ok) {
    // Approval workflow: `awaitingApproval: true` means a member's post was
    // HELD, not published/scheduled — "Post scheduled" would be a lie (nothing
    // goes out until an owner approves), so the confirmation says so.
    const heldForApproval = field(body, "awaitingApproval") === true;
    const created = { kind: "success", resetForm: true, heldForApproval, toast: successToast(mode, heldForApproval) } as const;
    const notSent = readNotSent(field(body, "notSent"));
    const allFailed = field(body, "allFailed") === true;
    // R10-client-journey L1: the server words it for its reader (a member
    // names the owner); an answer without it gets the owner's sentence.
    const serverText = field(body, "notSentText");
    // KK4: nothing could be sent, but the rows naming why couldn't be read
    // back, so the route sends its sentence without the list.
    if (notSent.length === 0 && allFailed && typeof serverText === "string" && serverText) {
      return { ...created, toast: serverText, notSent: { allFailed: true, text: serverText } };
    }
    if (notSent.length === 0) return created;
    const text = typeof serverText === "string" && serverText ? serverText : notSentSentence(notSent, allFailed);
    return { ...created, ...(allFailed ? { toast: text } : {}), notSent: { allFailed, text } };
  }

  if (field(body, "code") === "DISPATCH_FAILED") {
    return { kind: "dispatch_failed", resetForm: true, toast: dispatchFailedText(body) };
  }

  const message = field(body, "message");
  const error = field(body, "error");
  const serverText =
    typeof message === "string" && message
      ? message
      : typeof error === "string" && error
        ? error
        : null;

  if (field(body, "code") === WORKSPACE_CHANGED_CODE) {
    return {
      kind: "workspace_changed",
      resetForm: false,
      toast: serverText ?? WORKSPACE_CHANGED_MESSAGE,
    };
  }

  return { kind: "error", resetForm: false, toast: serverText ?? FALLBACK_ERROR };
}
