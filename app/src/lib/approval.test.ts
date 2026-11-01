import { describe, expect, it } from "vitest";

import {
  approvalOutcome,
  cancelData,
  canDecideApproval,
  changedSinceReview,
  decideApproval,
  deriveApprovalState,
  editApprovalEffect,
  holdForApprovalData,
  isHeldForApproval,
  needsApproval,
  publishApprovalAction,
  shouldHoldForApproval,
  submissionScheduledFor,
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

// ---------------------------------------------------------------------------
// 2026-11-01 audit — server-side approval enforcement. Every rule a route
// applies lives here so the routes only translate outcomes to HTTP.
// ---------------------------------------------------------------------------

const T = new Date("2026-11-01T10:00:00Z");

type Status = "draft" | "scheduled" | "in_progress" | "completed" | "failed" | "cancelled";

/** Approval-relevant columns of a job, defaulting to a plain draft. */
function facts(
  overrides: Partial<{ status: Status; submittedForApprovalAt: Date | null; approvedAt: Date | null }> = {},
): { status: Status; submittedForApprovalAt: Date | null; approvedAt: Date | null } {
  return { status: "draft", submittedForApprovalAt: null, approvedAt: null, ...overrides };
}

const PLAIN_DRAFT = facts();
const PENDING = facts({ submittedForApprovalAt: T });
const SCHEDULED_UNAPPROVED = facts({ status: "scheduled" });
const SCHEDULED_SUBMITTED_UNAPPROVED = facts({ status: "scheduled", submittedForApprovalAt: T });
const SCHEDULED_APPROVED = facts({ status: "scheduled", submittedForApprovalAt: T, approvedAt: T });
const COMPLETED = facts({ status: "completed" });

describe("isHeldForApproval", () => {
  it.each([
    { name: "a pending draft", job: PENDING, expected: true },
    { name: "a plain draft", job: PLAIN_DRAFT, expected: false },
    { name: "an approved post", job: SCHEDULED_APPROVED, expected: false },
    { name: "an unapproved scheduled post", job: SCHEDULED_UNAPPROVED, expected: false },
    // Reads "pending" but is NOT a held draft — an owner can't claim it as one.
    { name: "a submitted-but-unapproved scheduled row", job: SCHEDULED_SUBMITTED_UNAPPROVED, expected: false },
    { name: "a rejected post", job: facts({ status: "cancelled", submittedForApprovalAt: T }), expected: false },
  ] as const)("$name → $expected", ({ job, expected }) => {
    expect(isHeldForApproval(job)).toBe(expected);
  });
});

describe("needsApproval", () => {
  it.each([
    { requireApproval: true, role: "member", approvedAt: null, expected: true },
    { requireApproval: true, role: "member", approvedAt: T, expected: false },
    { requireApproval: true, role: "owner", approvedAt: null, expected: false },
    { requireApproval: false, role: "member", approvedAt: null, expected: false },
    { requireApproval: false, role: "owner", approvedAt: null, expected: false },
  ] as const)(
    "requireApproval=$requireApproval role=$role approvedAt=$approvedAt → $expected",
    ({ requireApproval, role, approvedAt, expected }) => {
      expect(needsApproval({ requireApproval, role, approvedAt })).toBe(expected);
    },
  );
});

describe("publishApprovalAction", () => {
  it.each([
    // Owners are never affected — whatever the job.
    { name: "owner, plain draft", role: "owner", requireApproval: true, job: PLAIN_DRAFT, expected: "proceed" },
    { name: "owner, pending", role: "owner", requireApproval: true, job: PENDING, expected: "proceed" },
    { name: "owner, scheduled unapproved", role: "owner", requireApproval: true, job: SCHEDULED_UNAPPROVED, expected: "proceed" },
    // Approval off: members publish freely.
    { name: "member, approval off", role: "member", requireApproval: false, job: PLAIN_DRAFT, expected: "proceed" },
    // Bypass (a): a member's plain draft is submitted, not published.
    { name: "member, plain draft", role: "member", requireApproval: true, job: PLAIN_DRAFT, expected: "submit" },
    // Bypass (b): publishing an already-pending post is refused.
    { name: "member, pending", role: "member", requireApproval: true, job: PENDING, expected: "awaiting_approval" },
    // A scheduled post nobody approved goes back for approval (off the cron).
    { name: "member, scheduled unapproved", role: "member", requireApproval: true, job: SCHEDULED_UNAPPROVED, expected: "submit" },
    {
      name: "member, scheduled submitted-but-unapproved (pre-fix bypass row)",
      role: "member",
      requireApproval: true,
      job: SCHEDULED_SUBMITTED_UNAPPROVED,
      expected: "submit",
    },
    // An approved post may be published now.
    { name: "member, scheduled approved", role: "member", requireApproval: true, job: SCHEDULED_APPROVED, expected: "proceed" },
    // Running/terminal jobs fall through to the route's own 409 guards.
    { name: "member, completed", role: "member", requireApproval: true, job: COMPLETED, expected: "proceed" },
  ] as const)("$name → $expected", ({ role, requireApproval, job, expected }) => {
    expect(publishApprovalAction({ role, requireApproval, job })).toBe(expected);
  });
});

describe("holdForApprovalData", () => {
  it("returns the post to a freshly-submitted draft and clears any prior decision", () => {
    expect(holdForApprovalData(T)).toEqual({
      status: "draft",
      submittedForApprovalAt: T,
      approvedAt: null,
      approvedByUserId: null,
    });
  });

  it("reads back as pending, even from an approved post", () => {
    expect(deriveApprovalState({ ...SCHEDULED_APPROVED, ...holdForApprovalData(T) })).toBe("pending");
  });
});

describe("submissionScheduledFor", () => {
  const REQUESTED = new Date("2026-11-05T09:00:00Z");
  const EXISTING = new Date("2026-11-03T09:00:00Z");

  it.each([
    { name: "a requested time wins on a draft", job: { status: "draft", scheduledFor: null }, requested: REQUESTED, expected: REQUESTED },
    { name: "a requested time wins on a scheduled job", job: { status: "scheduled", scheduledFor: EXISTING }, requested: REQUESTED, expected: REQUESTED },
    { name: "a scheduled job keeps its time", job: { status: "scheduled", scheduledFor: EXISTING }, requested: null, expected: EXISTING },
    { name: "a draft with no requested time has none", job: { status: "draft", scheduledFor: null }, requested: null, expected: null },
    { name: "a stray time on a draft is not kept", job: { status: "draft", scheduledFor: EXISTING }, requested: null, expected: null },
  ] as const)("$name", ({ job, requested, expected }) => {
    expect(submissionScheduledFor(job, requested)).toEqual(expected);
  });
});

describe("editApprovalEffect", () => {
  it.each([
    { name: "owner editing an approved scheduled post", role: "owner", requireApproval: true, job: SCHEDULED_APPROVED, expected: "none" },
    { name: "owner editing a pending post", role: "owner", requireApproval: true, job: PENDING, expected: "none" },
    { name: "member, approval off", role: "member", requireApproval: false, job: SCHEDULED_APPROVED, expected: "none" },
    // Bypass (c): editing an APPROVED scheduled post re-holds it.
    { name: "member editing an approved scheduled post", role: "member", requireApproval: true, job: SCHEDULED_APPROVED, expected: "rehold" },
    { name: "member editing an unapproved scheduled post", role: "member", requireApproval: true, job: SCHEDULED_UNAPPROVED, expected: "rehold" },
    { name: "member editing a pending post", role: "member", requireApproval: true, job: PENDING, expected: "restamp" },
    { name: "member editing a plain draft", role: "member", requireApproval: true, job: PLAIN_DRAFT, expected: "none" },
  ] as const)("$name → $expected", ({ role, requireApproval, job, expected }) => {
    expect(editApprovalEffect({ role, requireApproval, job })).toBe(expected);
  });
});

describe("changedSinceReview", () => {
  const CURRENT = new Date("2026-11-01T10:00:00.123Z");

  it.each([
    { name: "absent → not changed (older clients send none)", reviewed: undefined, expected: false },
    { name: "null → not changed", reviewed: null, expected: false },
    { name: "the same instant → not changed", reviewed: "2026-11-01T10:00:00.123Z", expected: false },
    { name: "an older version → changed", reviewed: "2026-11-01T09:59:00.000Z", expected: true },
    { name: "a different millisecond → changed", reviewed: "2026-11-01T10:00:00.124Z", expected: true },
    { name: "unparseable → changed (never decide blind)", reviewed: "not-a-date", expected: true },
  ] as const)("$name", ({ reviewed, expected }) => {
    expect(changedSinceReview(reviewed, CURRENT)).toBe(expected);
  });

  it("accepts the current updatedAt as an ISO string too", () => {
    expect(changedSinceReview("2026-11-01T10:00:00.123Z", "2026-11-01T10:00:00.123Z")).toBe(false);
  });
});

describe("decideApproval", () => {
  const NOW = new Date("2026-11-01T12:00:00Z");
  const BUFFER = 60_000;

  it.each([
    {
      name: "approve, time still ahead → scheduled",
      decision: "approve",
      scheduledFor: "2026-11-03T09:00:00Z",
      expected: { status: "scheduled", approvalState: "approved", outcome: "schedule" },
    },
    {
      name: "approve, no time → publish now",
      decision: "approve",
      scheduledFor: null,
      expected: { status: "in_progress", approvalState: "approved", outcome: "publish_now" },
    },
    {
      name: "approve, time passed during review → publish now",
      decision: "approve",
      scheduledFor: "2026-11-01T11:00:00Z",
      expected: { status: "in_progress", approvalState: "approved", outcome: "publish_now" },
    },
    {
      name: "reject → cancelled, whatever the time",
      decision: "reject",
      scheduledFor: "2026-11-03T09:00:00Z",
      expected: { status: "cancelled", approvalState: "rejected", outcome: null },
    },
  ] as const)("$name", ({ decision, scheduledFor, expected }) => {
    expect(decideApproval({ decision, scheduledFor, now: NOW, bufferMs: BUFFER })).toEqual(expected);
  });
});

describe("cancelData", () => {
  it.each([
    // A member withdrawing their pending post reads back "none", not "rejected".
    { name: "pending → withdrawal", job: PENDING, data: { status: "cancelled", submittedForApprovalAt: null }, after: "none" },
    { name: "plain draft → plain cancel", job: PLAIN_DRAFT, data: { status: "cancelled" }, after: "none" },
    { name: "approved scheduled → keeps its approval record", job: SCHEDULED_APPROVED, data: { status: "cancelled" }, after: "approved" },
    { name: "unapproved scheduled → plain cancel", job: SCHEDULED_UNAPPROVED, data: { status: "cancelled" }, after: "none" },
  ] as const)("$name", ({ job, data, after }) => {
    expect(cancelData(job)).toEqual(data);
    expect(deriveApprovalState({ ...job, ...cancelData(job) })).toBe(after);
  });
});
