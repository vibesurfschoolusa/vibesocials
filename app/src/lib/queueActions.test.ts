import { describe, expect, it } from "vitest";

import {
  applyJobPatch,
  approveHint,
  checkScheduleTime,
  captionChanged,
  decisionOutcome,
  editDialogModel,
  editOutcome,
  editSaveLabel,
  editSendsBackForApproval,
  getQueueCardActions,
  publishConfirmCopy,
  publishNeedsApproval,
  publishOutcome,
  queueStatusBadge,
  shouldRefetchAfterError,
  type QueueViewer,
} from "./queueActions";
import { toDateTimeLocalValue } from "./scheduling";
import type { PostJobDTO } from "./postsDto";

const OWNER: QueueViewer = { role: "owner", requireApproval: true };
const OWNER_NO_APPROVAL: QueueViewer = { role: "owner", requireApproval: false };
const MEMBER_APPROVAL: QueueViewer = { role: "member", requireApproval: true };
const MEMBER_NO_APPROVAL: QueueViewer = { role: "member", requireApproval: false };
const UNKNOWN_ROLE: QueueViewer = { role: null, requireApproval: true };

type Facts = Pick<PostJobDTO, "status" | "approvalState">;
const DRAFT: Facts = { status: "draft", approvalState: "none" };
const SCHEDULED: Facts = { status: "scheduled", approvalState: "none" };
const SCHEDULED_APPROVED: Facts = { status: "scheduled", approvalState: "approved" };
const PENDING: Facts = { status: "draft", approvalState: "pending" };

describe("publishNeedsApproval", () => {
  const rows: Array<[string, Facts, QueueViewer, boolean]> = [
    ["member + approval workspace, plain draft", DRAFT, MEMBER_APPROVAL, true],
    ["member + approval workspace, unapproved scheduled post", SCHEDULED, MEMBER_APPROVAL, true],
    ["member + approval workspace, already-approved scheduled post publishes", SCHEDULED_APPROVED, MEMBER_APPROVAL, false],
    ["member in a workspace without approval", DRAFT, MEMBER_NO_APPROVAL, false],
    ["owner (they are the approver)", DRAFT, OWNER, false],
    ["owner, approval off", DRAFT, OWNER_NO_APPROVAL, false],
    ["role not loaded yet is never treated as a held member", DRAFT, UNKNOWN_ROLE, false],
  ];
  it.each(rows)("%s", (_name, job, viewer, expected) => {
    expect(publishNeedsApproval(job, viewer)).toBe(expected);
  });
});

describe("editSendsBackForApproval", () => {
  const rows: Array<[string, Facts, QueueViewer, boolean]> = [
    ["member + approval, scheduled (unapproved)", SCHEDULED, MEMBER_APPROVAL, true],
    ["member + approval, scheduled AND approved (editing still re-holds it)", SCHEDULED_APPROVED, MEMBER_APPROVAL, true],
    ["member + approval, plain draft edits freely", DRAFT, MEMBER_APPROVAL, false],
    ["member without approval workspace", SCHEDULED, MEMBER_NO_APPROVAL, false],
    ["owner", SCHEDULED, OWNER, false],
    ["role not loaded yet", SCHEDULED, UNKNOWN_ROLE, false],
  ];
  it.each(rows)("%s", (_name, job, viewer, expected) => {
    expect(editSendsBackForApproval(job, viewer)).toBe(expected);
  });
});

describe("getQueueCardActions", () => {
  const rows: Array<[string, Facts, QueueViewer, ReturnType<typeof getQueueCardActions>]> = [
    [
      "owner sees Approve/Reject on a pending post and nothing else",
      PENDING,
      OWNER,
      { decide: true, awaitingNote: false, edit: false, primary: null, secondary: null },
    ],
    [
      "member sees only the read-only waiting note on their pending post",
      PENDING,
      MEMBER_APPROVAL,
      { decide: false, awaitingNote: true, edit: false, primary: null, secondary: null },
    ],
    [
      "member + approval, plain draft: primary reads Submit for approval",
      DRAFT,
      MEMBER_APPROVAL,
      { decide: false, awaitingNote: false, edit: true, primary: { kind: "submit", label: "Submit for approval" }, secondary: "delete" },
    ],
    [
      "member + approval, unapproved scheduled post: server would hold it, so Submit for approval",
      SCHEDULED,
      MEMBER_APPROVAL,
      { decide: false, awaitingNote: false, edit: true, primary: { kind: "submit", label: "Submit for approval" }, secondary: "cancel" },
    ],
    [
      "member + approval, approved scheduled post: Publish now still publishes",
      SCHEDULED_APPROVED,
      MEMBER_APPROVAL,
      { decide: false, awaitingNote: false, edit: true, primary: { kind: "publish", label: "Publish now" }, secondary: "cancel" },
    ],
    [
      "member in a non-approval workspace is unchanged",
      DRAFT,
      MEMBER_NO_APPROVAL,
      { decide: false, awaitingNote: false, edit: true, primary: { kind: "publish", label: "Publish now" }, secondary: "delete" },
    ],
    [
      "owner in an approval workspace is unchanged (scheduled)",
      SCHEDULED,
      OWNER,
      { decide: false, awaitingNote: false, edit: true, primary: { kind: "publish", label: "Publish now" }, secondary: "cancel" },
    ],
    [
      "owner in a non-approval workspace is unchanged (draft)",
      DRAFT,
      OWNER_NO_APPROVAL,
      { decide: false, awaitingNote: false, edit: true, primary: { kind: "publish", label: "Publish now" }, secondary: "delete" },
    ],
    [
      "a pending post is read-only for a not-yet-loaded role (never gets decide controls)",
      PENDING,
      UNKNOWN_ROLE,
      { decide: false, awaitingNote: true, edit: false, primary: null, secondary: null },
    ],
  ];
  it.each(rows)("%s", (_name, job, viewer, expected) => {
    expect(getQueueCardActions(job, viewer)).toEqual(expected);
  });
});

describe("queueStatusBadge", () => {
  const rows: Array<[string, Facts, { label: string; tone: string }]> = [
    ["pending", PENDING, { label: "Awaiting approval", tone: "warning" }],
    ["plain draft", DRAFT, { label: "Draft", tone: "neutral" }],
    ["scheduled", SCHEDULED, { label: "Scheduled", tone: "secondary" }],
    ["approved + scheduled stays visibly approved", SCHEDULED_APPROVED, { label: "Approved · Scheduled", tone: "success" }],
  ];
  it.each(rows)("%s", (_name, job, expected) => {
    expect(queueStatusBadge(job)).toEqual(expected);
  });
});

describe("publishConfirmCopy", () => {
  it("publish kind keeps the existing confirmation", () => {
    expect(publishConfirmCopy("publish")).toEqual({
      title: "Publish this post now?",
      description: "It will be sent to your connected platforms right away instead of waiting.",
      confirmText: "Publish now",
    });
  });
  it("submit kind says the post is held for review", () => {
    expect(publishConfirmCopy("submit")).toEqual({
      title: "Submit for approval?",
      description: "An owner will review this post before it publishes.",
      confirmText: "Submit for approval",
    });
  });
});

describe("approveHint", () => {
  const NOW = new Date("2026-11-01T12:00:00.000Z");
  const BUFFER = 60_000;
  const fmt = (iso: string) => `<${iso}>`;

  const rows: Array<[string, string | null, string]> = [
    ["no proposed time publishes now", null, "Approving publishes it now."],
    [
      "a comfortably future time is kept, and shown",
      "2026-11-02T12:00:00.000Z",
      "Approving keeps its scheduled time (<2026-11-02T12:00:00.000Z>).",
    ],
    [
      "exactly at now + buffer is still kept (approvalOutcome boundary)",
      "2026-11-01T12:01:00.000Z",
      "Approving keeps its scheduled time (<2026-11-01T12:01:00.000Z>).",
    ],
    [
      "inside the buffer has effectively passed",
      "2026-11-01T12:00:59.000Z",
      "Its scheduled time has passed — approving publishes it now.",
    ],
    [
      "a time in the past has passed",
      "2026-10-31T12:00:00.000Z",
      "Its scheduled time has passed — approving publishes it now.",
    ],
  ];
  it.each(rows)("%s", (_name, scheduledFor, expected) => {
    expect(approveHint({ scheduledFor }, NOW, BUFFER, fmt)).toBe(expected);
  });
});

describe("publishOutcome (publish route response)", () => {
  it("202 pending submission: card becomes a pending draft, keeping the proposed time", () => {
    expect(
      publishOutcome({ ok: true, status: "draft", approvalState: "pending", scheduledFor: "2026-12-01T10:00:00.000Z" }),
    ).toEqual({
      kind: "update",
      patch: { status: "draft", approvalState: "pending", scheduledFor: "2026-12-01T10:00:00.000Z" },
      message: "Sent for approval",
    });
  });
  it("pending submission without a time clears scheduledFor", () => {
    expect(publishOutcome({ ok: true, status: "draft", approvalState: "pending", scheduledFor: null })).toEqual({
      kind: "update",
      patch: { status: "draft", approvalState: "pending", scheduledFor: null },
      message: "Sent for approval",
    });
  });
  it("200 scheduled: card becomes scheduled at the returned time", () => {
    expect(publishOutcome({ ok: true, status: "scheduled", scheduledFor: "2026-12-01T10:00:00.000Z" })).toEqual({
      kind: "update",
      patch: { status: "scheduled", scheduledFor: "2026-12-01T10:00:00.000Z" },
      message: "Post scheduled.",
    });
  });
  it("202 in_progress: card leaves the queue", () => {
    expect(publishOutcome({ ok: true, status: "in_progress" })).toEqual({
      kind: "remove",
      message: "Publishing now — track it in Activity.",
    });
  });
  it("an unrecognised body keeps the legacy behaviour (remove)", () => {
    expect(publishOutcome(null).kind).toBe("remove");
    expect(publishOutcome("nope").kind).toBe("remove");
  });
});

describe("decisionOutcome (approval route response)", () => {
  it("reject removes the card", () => {
    expect(decisionOutcome("reject", { ok: true, status: "cancelled", approvalState: "rejected", scheduledFor: null })).toEqual({
      kind: "remove",
      message: "Post rejected — the author has been notified.",
    });
  });
  it("approve -> scheduled updates the card in place (approved, scheduled, new time)", () => {
    expect(
      decisionOutcome("approve", { ok: true, status: "scheduled", approvalState: "approved", scheduledFor: "2026-12-01T10:00:00.000Z" }),
    ).toEqual({
      kind: "update",
      patch: { status: "scheduled", approvalState: "approved", scheduledFor: "2026-12-01T10:00:00.000Z" },
      message: "Approved — it will publish at its scheduled time.",
    });
  });
  it("approve -> in_progress removes the card", () => {
    expect(decisionOutcome("approve", { ok: true, status: "in_progress", approvalState: "approved", scheduledFor: null })).toEqual({
      kind: "remove",
      message: "Approved — publishing now",
    });
  });
  it("approve with an unreadable body is treated as publishing now", () => {
    expect(decisionOutcome("approve", null)).toEqual({ kind: "remove", message: "Approved — publishing now" });
  });
});

describe("editOutcome (PATCH route response)", () => {
  it("a re-held post (member, approval workspace) becomes a pending draft", () => {
    expect(editOutcome({ ok: true, status: "draft", approvalState: "pending" })).toEqual({
      patch: { status: "draft", approvalState: "pending" },
      message: "Changes saved — sent back for approval.",
    });
  });
  it("everything else is a plain save", () => {
    expect(editOutcome({ ok: true })).toEqual({ patch: {}, message: "Changes saved." });
    expect(editOutcome(null)).toEqual({ patch: {}, message: "Changes saved." });
  });
});

describe("shouldRefetchAfterError", () => {
  const rows: Array<[number, boolean]> = [
    [409, true], // NOT_PENDING_APPROVAL / CHANGED_SINCE_REVIEW / NO_CONNECTIONS / AWAITING_APPROVAL
    [503, true], // DISPATCH_FAILED — approval stands, job is now failed
    [404, true], // post is gone
    [400, false],
    [401, false],
    [403, false],
    [429, false],
    [500, false],
  ];
  it.each(rows)("HTTP %i -> %s", (status, expected) => {
    expect(shouldRefetchAfterError(status)).toBe(expected);
  });
});

describe("applyJobPatch", () => {
  const job = {
    id: "j1",
    status: "draft",
    approvalState: "none",
    scheduledFor: null,
    caption: "old",
  } as unknown as PostJobDTO;

  it("applies defined fields", () => {
    expect(applyJobPatch(job, { status: "scheduled", scheduledFor: "2026-12-01T10:00:00.000Z" })).toMatchObject({
      id: "j1",
      status: "scheduled",
      approvalState: "none",
      scheduledFor: "2026-12-01T10:00:00.000Z",
      caption: "old",
    });
  });
  it("applies an explicit null (clearing the time) but never an undefined", () => {
    const scheduled = { ...job, status: "scheduled", scheduledFor: "2026-12-01T10:00:00.000Z" } as PostJobDTO;
    expect(applyJobPatch(scheduled, { scheduledFor: null }).scheduledFor).toBeNull();
    expect(applyJobPatch(scheduled, { scheduledFor: undefined, caption: "new" })).toMatchObject({
      scheduledFor: "2026-12-01T10:00:00.000Z",
      caption: "new",
    });
  });
});

describe("editDialogModel", () => {
  it("scheduled post: required time field, notice only for a member under approval", () => {
    expect(editDialogModel(SCHEDULED, MEMBER_APPROVAL)).toEqual({
      title: "Edit scheduled post",
      scheduleLabel: "Publish at",
      scheduleRequired: true,
      notice: "Saving changes sends this post back for approval.",
    });
    expect(editDialogModel(SCHEDULED, OWNER).notice).toBeNull();
    expect(editDialogModel(SCHEDULED, MEMBER_NO_APPROVAL).notice).toBeNull();
    expect(editDialogModel(SCHEDULED_APPROVED, MEMBER_APPROVAL).notice).toBe(
      "Saving changes sends this post back for approval.",
    );
  });
  it("draft: optional Schedule for field, no notice", () => {
    expect(editDialogModel(DRAFT, MEMBER_APPROVAL)).toEqual({
      title: "Edit draft",
      scheduleLabel: "Schedule for (optional)",
      scheduleRequired: false,
      notice: null,
    });
  });
});

describe("editSaveLabel", () => {
  const rows: Array<[string, Facts, QueueViewer, boolean, string]> = [
    ["scheduled post, any viewer", SCHEDULED, MEMBER_APPROVAL, true, "Save changes"],
    ["draft, no time chosen", DRAFT, MEMBER_APPROVAL, false, "Save changes"],
    ["draft + time, member under approval", DRAFT, MEMBER_APPROVAL, true, "Submit for approval"],
    ["draft + time, member without approval", DRAFT, MEMBER_NO_APPROVAL, true, "Save and schedule"],
    ["draft + time, owner", DRAFT, OWNER, true, "Save and schedule"],
  ];
  it.each(rows)("%s", (_name, job, viewer, hasTime, expected) => {
    expect(editSaveLabel(job, viewer, hasTime)).toBe(expected);
  });
});

describe("captionChanged", () => {
  const rows: Array<[string | null, string, boolean]> = [
    ["hello", "hello", false],
    ["hello", "  hello  ", false],
    ["hello", "hello!", true],
    [null, "", false],
    [null, "hi", true],
    ["  hi ", "hi", false],
  ];
  it.each(rows)("%j -> %j changed=%s", (original, next, expected) => {
    expect(captionChanged(original, next)).toBe(expected);
  });
});

describe("checkScheduleTime", () => {
  const NOW = Date.now();
  const BUFFER = 60_000;
  const local = (offsetMs: number) => toDateTimeLocalValue(new Date(NOW + offsetMs));

  it("accepts a time well in the future and returns its UTC ISO", () => {
    const result = checkScheduleTime(local(2 * 60 * 60 * 1000), NOW, BUFFER);
    expect(result.ok).toBe(true);
    if (result.ok) expect(Number.isNaN(new Date(result.iso).getTime())).toBe(false);
  });
  it("rejects an empty or unparseable value", () => {
    expect(checkScheduleTime("", NOW, BUFFER)).toEqual({ ok: false, error: "Choose a valid date and time." });
    expect(checkScheduleTime("not a date", NOW, BUFFER)).toEqual({ ok: false, error: "Choose a valid date and time." });
  });
  it("rejects a time inside the buffer or in the past", () => {
    const tooSoon = { ok: false, error: "Scheduled time must be at least a minute in the future." };
    expect(checkScheduleTime(local(-60 * 60 * 1000), NOW, BUFFER)).toEqual(tooSoon);
    expect(checkScheduleTime(local(0), NOW, BUFFER)).toEqual(tooSoon);
  });
});
