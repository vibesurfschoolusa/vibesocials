import { describe, expect, it } from "vitest";

import {
  postDestination,
  COMPOSER_DISPATCH_FAILED_MESSAGE,
  COMPOSER_DISPATCH_UNMARKED_MESSAGE,
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

  // KK4: the route could not mark the results failed, so Activity shows the
  // post as publishing until the stuck-job reconciler fails it.
  it("503 DISPATCH_FAILED with resultsMarked false: the post shows as publishing first", () => {
    expect(
      composerSubmitOutcome({ ok: false, mode: "now", body: { ...DISPATCH_FAILED_BODY, resultsMarked: false } }),
    ).toEqual({ kind: "dispatch_failed", resetForm: true, toast: COMPOSER_DISPATCH_UNMARKED_MESSAGE });
    expect(COMPOSER_DISPATCH_UNMARKED_MESSAGE).toBe(
      "The post was saved but didn't start. In Activity it can show as publishing for about two hours, sometimes a little longer, before it shows as failed; then retry it there. Don't press Post again.",
    );
  });

  // KK4: a created post whose rows couldn't be read back still says nothing
  // was sent, from the route's sentence, without a per-platform list.
  it("a 200 with allFailed and notSentText but no list: the not-posted warning", () => {
    const text = "The post was saved, but none of its platforms could be sent. Open Activity to see why.";
    expect(
      composerSubmitOutcome({ ok: true, mode: "now", body: { postJobId: "job-1", allFailed: true, notSentText: text } }),
    ).toEqual({ ...success(text), notSent: { allFailed: true, text } });
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

describe("composerSubmitOutcome — daily post limit (usage limits)", () => {
  it("shows the server's limit sentence and keeps the form", () => {
    const sentence =
      "This workspace has reached its limit of 20 posts for today. Schedule this post for another day, or try again tomorrow.";
    expect(
      composerSubmitOutcome({
        ok: false,
        body: { error: sentence, code: "WORKSPACE_DAILY_POST_LIMIT" },
        mode: "now",
      }),
    ).toEqual({ kind: "error", resetForm: false, toast: sentence });
  });
});

// G1 review: a "Post now" whose chosen platforms failed up front says so
// instead of the green "Post queued".
describe("composerSubmitOutcome - platforms not sent", () => {
  const now = (body: unknown) => composerSubmitOutcome({ ok: true, mode: "now", body });

  it("every platform dead: a warning naming each, not Post queued", () => {
    const outcome = now({
      allFailed: true,
      notSent: [{ platform: "x", reason: "RECONNECT_REQUIRED", message: "Reconnect X in Settings, then retry." }],
    });
    expect(outcome).toEqual({
      kind: "success",
      resetForm: true,
      heldForApproval: false,
      toast: "Nothing was sent: Reconnect X in Settings, then use Retry in Activity.",
      notSent: { allFailed: true, text: "Nothing was sent: Reconnect X in Settings, then use Retry in Activity." },
    });
  });

  it("one dead, one healthy: the usual success plus a line naming the dead one", () => {
    const outcome = now({ notSent: [{ platform: "x", reason: "RECONNECT_REQUIRED" }] });
    expect(outcome).toMatchObject({
      kind: "success",
      toast: "Post queued — track it in Activity",
      notSent: { allFailed: false, text: "Not sent to X: Reconnect X in Settings, then use Retry in Activity." },
    });
  });

  // R10-client-journey L1: the server words the not-sent text for its reader (a member names the owner).
  it("a member's answer: the server's not-sent text, not the owner's Settings step", () => {
    const text = "Not sent to X: The workspace owner can reconnect X; then use Retry in Activity.";
    const outcome = now({ notSent: [{ platform: "x", reason: "RECONNECT_REQUIRED" }], notSentText: text });
    expect(outcome).toMatchObject({ kind: "success", toast: "Post queued — track it in Activity", notSent: { allFailed: false, text } });
    const nothing = "Nothing was sent: The workspace owner can reconnect X; then use Retry in Activity.";
    expect(now({ allFailed: true, notSent: [{ platform: "x", reason: "RECONNECT_REQUIRED" }], notSentText: nothing })).toMatchObject({
      toast: nothing,
      notSent: { allFailed: true, text: nothing },
    });
  });

  it("healthy, or entries it cannot read: unchanged", () => {
    expect(now({ postJob: { id: "j" } })).not.toHaveProperty("notSent");
    expect(now({ notSent: [] })).not.toHaveProperty("notSent");
    expect(now({ notSent: [{ platform: 7 }, "x", null], allFailed: true })).toEqual({
      kind: "success",
      resetForm: true,
      heldForApproval: false,
      toast: "Post queued — track it in Activity",
    });
  });
});

// R24 JJ2 review: one rule says where a post lands, for the success text, the
// success banner's link and the lost-connection sentence.
describe("postDestination", () => {
  it.each([
    ["Post now by an owner", "now", false, "activity"],
    ["Schedule", "schedule", false, "queue"],
    ["Draft", "draft", false, "queue"],
    ["a member's Post now held for approval", "now", true, "queue"],
    ["a member's Schedule held for approval", "schedule", true, "queue"],
  ] as const)("%s (%s, held %s) -> %s", (_name, mode, held, page) => {
    expect(postDestination(mode, held)).toBe(page);
  });
});
