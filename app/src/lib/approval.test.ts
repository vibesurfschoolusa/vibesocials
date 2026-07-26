import { describe, expect, it } from "vitest";

import {
  approvalOutcome,
  canDecideApproval,
  deriveApprovalState,
  shouldHoldForApproval,
} from "./approval";

describe("shouldHoldForApproval", () => {
  it("holds a member's immediate or scheduled post when the flag is on", () => {
    expect(shouldHoldForApproval({ role: "member", requireApproval: true, intent: "immediate" })).toBe(true);
    expect(shouldHoldForApproval({ role: "member", requireApproval: true, intent: "scheduled" })).toBe(true);
  });

  it("never holds a member's own draft — a draft publishes nothing", () => {
    expect(shouldHoldForApproval({ role: "member", requireApproval: true, intent: "draft" })).toBe(false);
  });

  it("never holds an owner's post — owners are the approvers", () => {
    expect(shouldHoldForApproval({ role: "owner", requireApproval: true, intent: "immediate" })).toBe(false);
  });

  it("never holds anything when the workspace hasn't enabled approval", () => {
    expect(shouldHoldForApproval({ role: "member", requireApproval: false, intent: "immediate" })).toBe(false);
  });
});

describe("deriveApprovalState", () => {
  const D = new Date("2026-07-26T10:00:00Z");

  it("is none for a post that was never submitted", () => {
    expect(deriveApprovalState({ submittedForApprovalAt: null, approvedAt: null, status: "draft" })).toBe("none");
  });

  it("is pending while submitted, undecided, and still a draft", () => {
    expect(deriveApprovalState({ submittedForApprovalAt: D, approvedAt: null, status: "draft" })).toBe("pending");
  });

  it("is approved once approvedAt is set", () => {
    expect(deriveApprovalState({ submittedForApprovalAt: D, approvedAt: D, status: "scheduled" })).toBe("approved");
  });

  it("is rejected when a submitted, unapproved post was cancelled", () => {
    expect(deriveApprovalState({ submittedForApprovalAt: D, approvedAt: null, status: "cancelled" })).toBe("rejected");
  });

  it("accepts ISO strings (DTO/step.run serialization)", () => {
    expect(
      deriveApprovalState({
        submittedForApprovalAt: "2026-07-26T10:00:00.000Z",
        approvedAt: null,
        status: "draft",
      }),
    ).toBe("pending");
  });
});

describe("canDecideApproval", () => {
  it("lets an owner decide a pending submission", () => {
    expect(canDecideApproval({ role: "owner", state: "pending" })).toBe(true);
  });

  it("never lets a member decide", () => {
    expect(canDecideApproval({ role: "member", state: "pending" })).toBe(false);
  });

  it("refuses to re-decide something already decided or never submitted", () => {
    expect(canDecideApproval({ role: "owner", state: "approved" })).toBe(false);
    expect(canDecideApproval({ role: "owner", state: "rejected" })).toBe(false);
    expect(canDecideApproval({ role: "owner", state: "none" })).toBe(false);
  });
});

describe("approvalOutcome", () => {
  const NOW = new Date("2026-07-26T12:00:00Z");
  const BUFFER = 60_000;

  it("schedules when the member's chosen time is still comfortably ahead", () => {
    expect(approvalOutcome({ scheduledFor: "2026-07-28T09:00:00Z" }, NOW, BUFFER)).toBe("schedule");
  });

  it("publishes now when the post had no chosen time", () => {
    expect(approvalOutcome({ scheduledFor: null }, NOW, BUFFER)).toBe("publish_now");
  });

  it("publishes now when the chosen time passed while awaiting approval", () => {
    expect(approvalOutcome({ scheduledFor: "2026-07-26T11:00:00Z" }, NOW, BUFFER)).toBe("publish_now");
  });

  it("publishes now when the chosen time is inside the scheduling buffer", () => {
    expect(approvalOutcome({ scheduledFor: "2026-07-26T12:00:30Z" }, NOW, BUFFER)).toBe("publish_now");
  });
});
