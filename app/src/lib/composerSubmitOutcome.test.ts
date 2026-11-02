import { describe, expect, it } from "vitest";

import {
  COMPOSER_DISPATCH_FAILED_MESSAGE,
  composerSubmitOutcome,
  type ComposerSubmitOutcome,
} from "./composerSubmitOutcome";
import { WORKSPACE_CHANGED_MESSAGE } from "./workspaceChanged";

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

// 2026-11-01 audit (M3): the page was rendered for another workspace than the
// one the cookie now names, so the server refused (409) before writing anything.
describe("composerSubmitOutcome — workspace changed in another tab (M3)", () => {
  it("shows the server's message, keeps the form, and flags the outcome so the composer can pin it", () => {
    const message = "You switched workspace in another tab. Reload this page before posting.";

    expect(
      composerSubmitOutcome({
        ok: false,
        mode: "now",
        body: { error: message, code: "WORKSPACE_CHANGED" },
      }),
    ).toEqual({ kind: "workspace_changed", resetForm: false, toast: message });
  });

  it("falls back to the canned reload message when the 409 body carries the code but no readable error", () => {
    expect(
      composerSubmitOutcome({ ok: false, mode: "draft", body: { code: "WORKSPACE_CHANGED" } }),
    ).toEqual({ kind: "workspace_changed", resetForm: false, toast: WORKSPACE_CHANGED_MESSAGE });
  });

  it("pins the reload copy the server also sends", () => {
    expect(WORKSPACE_CHANGED_MESSAGE).toBe(
      "You switched workspace in another tab. Reload this page before posting.",
    );
  });

  it("never resets the form for it, in any mode", () => {
    for (const mode of ["now", "schedule", "draft"] as const) {
      const outcome = composerSubmitOutcome({
        ok: false,
        mode,
        body: { error: "x", code: "WORKSPACE_CHANGED" },
      });
      expect(outcome.resetForm).toBe(false);
    }
  });

  it("does not treat an unrelated error body as a workspace change", () => {
    expect(
      composerSubmitOutcome({ ok: false, mode: "now", body: { error: "Nope", code: "SOMETHING_ELSE" } }),
    ).toEqual({ kind: "error", resetForm: false, toast: "Nope" });
  });
});
