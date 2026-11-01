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
 *   is sent to Activity to retry the job that exists.
 * - `error` — nothing was created: keep the form so the user can fix and resend.
 */

/** How the composer was asked to publish (mirrors create-post-form.tsx). */
export type ComposerPublishMode = "now" | "schedule" | "draft";

export type ComposerSubmitOutcome =
  | { kind: "success"; resetForm: true; heldForApproval: boolean; toast: string }
  | { kind: "dispatch_failed"; resetForm: true; toast: string }
  | { kind: "error"; resetForm: false; toast: string };

export const COMPOSER_DISPATCH_FAILED_MESSAGE =
  "Saved, but publishing couldn't start — retry it from Activity.";

const FALLBACK_ERROR = "Failed to create post.";

function field(body: unknown, key: string): unknown {
  return typeof body === "object" && body !== null ? (body as Record<string, unknown>)[key] : undefined;
}

function successToast(mode: ComposerPublishMode, heldForApproval: boolean): string {
  if (heldForApproval) return "Sent for approval — an owner will review it before it publishes";
  if (mode === "draft") return "Draft saved — find it in your Queue";
  if (mode === "schedule") return "Post scheduled — see it in your Queue";
  return "Post queued — track it in Activity";
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
    return { kind: "success", resetForm: true, heldForApproval, toast: successToast(mode, heldForApproval) };
  }

  if (field(body, "code") === "DISPATCH_FAILED") {
    return { kind: "dispatch_failed", resetForm: true, toast: COMPOSER_DISPATCH_FAILED_MESSAGE };
  }

  const message = field(body, "message");
  const error = field(body, "error");
  return {
    kind: "error",
    resetForm: false,
    toast:
      typeof message === "string" && message
        ? message
        : typeof error === "string" && error
          ? error
          : FALLBACK_ERROR,
  };
}
