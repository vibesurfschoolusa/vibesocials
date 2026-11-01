import { describe, expect, it } from "vitest";

import {
  COMPOSER_DISPATCH_FAILED_MESSAGE,
  composerSubmitOutcome,
  type ComposerSubmitOutcome,
} from "./composerSubmitOutcome";

const success = (toast: string, heldForApproval = false): ComposerSubmitOutcome => ({
  kind: "success",
  resetForm: true,
  heldForApproval,
  toast,
});
const error = (toast: string): ComposerSubmitOutcome => ({ kind: "error", resetForm: false, toast });

const DISPATCH_FAILED_BODY = {
  code: "DISPATCH_FAILED",
  error: "Couldn't start publishing. Please try again.",
  postJobId: "job-1",
};

describe("composerSubmitOutcome", () => {
  it.each<[string, Parameters<typeof composerSubmitOutcome>[0], ComposerSubmitOutcome]>([
    // --- created: reset the form, success banner ---
    ["publish now", { ok: true, mode: "now", body: { postJob: { id: "j", status: "in_progress" } } }, success("Post queued — track it in Activity")],
    ["schedule", { ok: true, mode: "schedule", body: { postJob: { id: "j", status: "scheduled" } } }, success("Post scheduled — see it in your Queue")],
    ["draft", { ok: true, mode: "draft", body: { postJob: { id: "j", status: "draft" } } }, success("Draft saved — find it in your Queue")],
    [
      "held for approval (any mode)",
      { ok: true, mode: "now", body: { postJob: { id: "j", status: "draft" }, awaitingApproval: true } },
      success("Sent for approval — an owner will review it before it publishes", true),
    ],
    ["an unreadable 2xx body still means created", { ok: true, mode: "now", body: null }, success("Post queued — track it in Activity")],

    // --- M3: the job exists (failed) but publishing never started. Reset the
    // form like a success (pressing Post again would create a SECOND job) and
    // point at Activity, where the first one can be retried. ---
    ["503 DISPATCH_FAILED", { ok: false, mode: "now", body: DISPATCH_FAILED_BODY }, {
      kind: "dispatch_failed",
      resetForm: true,
      toast: "Saved, but publishing couldn't start — retry it from Activity.",
    }],

    // --- not created: keep the form so the user can fix and resend ---
    ["a 503 without the dispatch code", { ok: false, mode: "now", body: { error: "Service unavailable" } }, error("Service unavailable")],
    ["a validation error", { ok: false, mode: "schedule", body: { error: "Caption is required." } }, error("Caption is required.")],
    ["`message` wins over `error`", { ok: false, mode: "now", body: { message: "Slow down.", error: "Too many" } }, error("Slow down.")],
    ["an unreadable error body", { ok: false, mode: "now", body: null }, error("Failed to create post.")],
    ["a non-string error field", { ok: false, mode: "now", body: { error: 42 } }, error("Failed to create post.")],
    ["a non-object body", { ok: false, mode: "now", body: "oops" }, error("Failed to create post.")],
  ])("%s", (_name, input, expected) => {
    expect(composerSubmitOutcome(input)).toEqual(expected);
  });

  it("exports the dispatch-failed copy the banner shows", () => {
    expect(COMPOSER_DISPATCH_FAILED_MESSAGE).toBe(
      "Saved, but publishing couldn't start — retry it from Activity.",
    );
  });
});
