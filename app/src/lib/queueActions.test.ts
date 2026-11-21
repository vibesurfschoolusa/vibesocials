import { describe, expect, it, vi } from "vitest";

import { otherHalfPatch } from "@/app/queue/pairActions";

import {
  applyJobPatch,
  approveHint,
  checkScheduleTime,
  captionChanged,
  decisionOutcome,
  editDialogModel,
  editTimeToSend,
  editOutcome,
  editSaveLabel,
  editSendsBackForApproval,
  getQueueCardActions,
  publishConfirmCopy,
  publishNeedsApproval,
  publishOutcome,
  decisionButtonState,
  queueFailureText,
  queueMayHaveGoneThroughText,
  queueNotSentText,
  sendActionRequest,
  queueStatusBadge,
  postActionRefusal,
  type QueueViewer,
} from "./queueActions";
import { answerLostText } from "./answerLost";
import { toDateTimeLocalValue } from "./scheduling";

const MAY_HAVE_CLAUSE = {
  approve: "the post may have been approved",
  reject: "the post may have been rejected",
  publish: "the post may have started publishing",
  submit: "the post may have been sent for approval",
  schedule: "the post may have been scheduled",
  edit: "your changes may have been saved",
} as const;
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
  // R58 publishing-flow L3: a draft can target some platforms only.
  it("publish kind with target platforms names them", () => {
    expect(publishConfirmCopy("publish", ["instagram"]).description).toBe(
      "It will be sent to Instagram right away instead of waiting.",
    );
    expect(publishConfirmCopy("publish", ["instagram", "facebook_page", "linkedin"]).description).toBe(
      "It will be sent to Instagram, Facebook Page and LinkedIn right away instead of waiting.",
    );
  });
  it("publish kind with no target platforms keeps connected", () => {
    for (const targets of [null, []]) {
      expect(publishConfirmCopy("publish", targets).description).toBe(
        "It will be sent to your connected platforms right away instead of waiting.",
      );
    }
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
  const REJECTED = { ok: true, status: "cancelled", approvalState: "rejected", scheduledFor: null };
  // R23-client-journey L4: "notified" only when the route says the email went out.
  it("reject removes the card and says the author was notified when the email went out", () => {
    expect(decisionOutcome("reject", { ...REJECTED, authorEmail: "sent" })).toEqual({
      kind: "remove",
      message: "Post rejected — the author has been notified.",
    });
  });
  it("reject of a removed author says no email was sent", () => {
    expect(decisionOutcome("reject", { ...REJECTED, authorEmail: "removed" })).toEqual({
      kind: "remove",
      message: "Post rejected. The author is no longer in this workspace, so no email was sent.",
    });
  });
  it("reject whose email failed asks the owner to tell the author", () => {
    expect(decisionOutcome("reject", { ...REJECTED, authorEmail: "failed" })).toEqual({
      kind: "remove",
      message: "Post rejected. We couldn't email the author; let them know yourself.",
    });
  });
  it("reject with no word on the email claims nothing about it", () => {
    for (const data of [REJECTED, null]) {
      expect(decisionOutcome("reject", data)).toEqual({ kind: "remove", message: "Post rejected." });
    }
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

// R56 client-journey-2 L1: an edit or a drag that changed the approved text or
// time withdrew the client's approval on the server; the card drops its badge.
describe("editOutcome: a withdrawn client approval", () => {
  const approved = {
    id: "job-1",
    status: "scheduled",
    scheduledFor: "2026-11-25T15:00:00.000Z",
    caption: "Dawn patrol",
    approvalState: "none",
    clientApprovedAt: "2026-11-19T10:00:00.000Z",
  } as unknown as PostJobDTO;

  it("an edit of the text: the patch carries clientApprovedAt null, and the card loses it", () => {
    const outcome = editOutcome({ ok: true, clientApprovedAt: null });
    expect(outcome).toEqual({ patch: { clientApprovedAt: null }, message: "Changes saved." });
    expect(applyJobPatch(approved, { caption: "Sunset session", ...outcome.patch }).clientApprovedAt).toBeNull();
  });

  it("a drag to another time: the calendar's patch withdraws it too", () => {
    const outcome = editOutcome({ ok: true, clientApprovedAt: null });
    const moved = applyJobPatch(approved, { scheduledFor: "2026-11-26T15:00:00.000Z", ...outcome.patch });
    expect(moved.clientApprovedAt).toBeNull();
    expect(moved.scheduledFor).toBe("2026-11-26T15:00:00.000Z");
  });

  it("a re-held edit withdraws it as well", () => {
    expect(editOutcome({ ok: true, status: "draft", approvalState: "pending", clientApprovedAt: null }).patch).toEqual({
      status: "draft",
      approvalState: "pending",
      clientApprovedAt: null,
    });
  });

  it("an edit that leaves the approved text and time: no clientApprovedAt in the answer, so the card keeps it", () => {
    const outcome = editOutcome({ ok: true });
    expect(outcome.patch).not.toHaveProperty("clientApprovedAt");
    expect(applyJobPatch(approved, { caption: "Dawn patrol", ...outcome.patch }).clientApprovedAt).toBe(
      "2026-11-19T10:00:00.000Z",
    );
  });

  it("a post with no client approval is unchanged", () => {
    const plain = { ...approved, clientApprovedAt: null } as PostJobDTO;
    expect(applyJobPatch(plain, editOutcome({ ok: true, clientApprovedAt: null }).patch)).toEqual(plain);
  });
});

// R31 publishing L3-L5 and pages L2: one rule for a refused post action, on
// every page (Queue's buttons, Edit, the calendar drag, Activity).
describe("postActionRefusal", () => {
  const FALLBACK = "Couldn't cancel this post.";
  const moved = (text: string) => ({ movedOn: true, reload: true, text });

  it.each([
    ["started publishing", 409, "This post has started publishing, so it can't be cancelled. Check Activity to see how it goes."],
    ["published", 409, "This post has already gone out, so it can't be cancelled. Check Activity to see it."],
    ["failed", 409, "This post failed, so it can't be cancelled. Check Activity for what to do next."],
    ["cancelled", 409, "This post was already cancelled."],
  ])("%s: a quiet reload and the route's sentence", (_label, status, error) => {
    expect(postActionRefusal(status, { error, code: "NOT_CANCELABLE" }, FALLBACK)).toEqual(moved(error));
  });

  it("deleted: a 404 says the post no longer exists, never the bare Not found", () => {
    expect(postActionRefusal(404, { error: "This post no longer exists." }, FALLBACK)).toEqual(
      moved("This post no longer exists."),
    );
    expect(postActionRefusal(404, { error: "Not found" }, FALLBACK)).toEqual(moved("This post no longer exists."));
    expect(postActionRefusal(404, null, FALLBACK)).toEqual(moved("This post no longer exists."));
  });

  it("became a draft: the 400 NOT_SCHEDULED reloads too", () => {
    const error = "This post is now a draft (a change was asked for, or it is waiting for approval).";
    expect(postActionRefusal(400, { error, code: "NOT_SCHEDULED" }, FALLBACK)).toEqual(moved(error));
  });

  it("another workspace, or a page from before the release: the sentence, and no reload into another workspace", () => {
    const changed = "You switched workspace in another tab. Reload this page, then try again.";
    expect(postActionRefusal(409, { error: changed, code: "WORKSPACE_CHANGED" }, FALLBACK)).toEqual({
      movedOn: true,
      reload: false,
      text: changed,
    });
    const missing = "This page is out of date. Reload it, then try again.";
    expect(postActionRefusal(400, { error: missing, code: "MISSING_WORKSPACE_ID" }, FALLBACK)).toEqual({
      movedOn: true,
      reload: false,
      text: missing,
    });
  });

  it("publishing couldn't start (503 DISPATCH_FAILED): reload, with Create's sentence", () => {
    const data = { code: "DISPATCH_FAILED", error: "x", resultsMarked: true };
    expect(postActionRefusal(503, data, "Couldn't publish this post.", "Publish")).toEqual(
      moved("Saved, but publishing couldn't start — retry it from Activity."),
    );
  });

  it.each([400, 401, 403, 429, 500])("HTTP %i otherwise: the card stays as it is, with the route's sentence", (status) => {
    expect(postActionRefusal(status, { error: "Refused." }, FALLBACK)).toEqual({ movedOn: false, reload: false, text: "Refused." });
    expect(postActionRefusal(status, null, FALLBACK)).toEqual({ movedOn: false, reload: false, text: FALLBACK });
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
    // R47 review: the Queue's move says the server's sentence (lib/scheduling).
    const tooSoon = { ok: false, error: "The scheduled time has passed or is less than a minute away. Choose a later time and try again." };
    expect(checkScheduleTime(local(-60 * 60 * 1000), NOW, BUFFER)).toEqual(tooSoon);
    expect(checkScheduleTime(local(0), NOW, BUFFER)).toEqual(tooSoon);
  });
});

// R59 publishing-flow-2 L1: a scheduled post that is due but not yet picked up can
// still get a caption fix; only a changed time is sent and checked.
describe("editTimeToSend", () => {
  const NOW = Date.now();
  const BUFFER = 60_000;
  const at = (offsetMs: number) => new Date(NOW + offsetMs);
  const tooSoon = {
    ok: false,
    error: "The scheduled time has passed or is less than a minute away. Choose a later time and try again.",
  };

  it("a caption-only save on a past-due scheduled post sends no time", () => {
    const saved = at(-3 * 60_000);
    expect(
      editTimeToSend({
        scheduled: true,
        field: toDateTimeLocalValue(saved),
        savedScheduledFor: saved.toISOString(),
        nowMs: NOW,
        bufferMs: BUFFER,
      }),
    ).toEqual({ ok: true, iso: null });
  });
  it("a scheduled post's time moved into the past is refused, as now", () => {
    const saved = at(2 * 60 * 60_000);
    expect(
      editTimeToSend({
        scheduled: true,
        field: toDateTimeLocalValue(at(-60 * 60_000)),
        savedScheduledFor: saved.toISOString(),
        nowMs: NOW,
        bufferMs: BUFFER,
      }),
    ).toEqual(tooSoon);
  });
  it("a scheduled post's time moved later is sent", () => {
    const saved = at(2 * 60 * 60_000);
    const result = editTimeToSend({
      scheduled: true,
      field: toDateTimeLocalValue(at(5 * 60 * 60_000)),
      savedScheduledFor: saved.toISOString(),
      nowMs: NOW,
      bufferMs: BUFFER,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.iso).not.toBeNull();
  });
  it("a scheduled post's cleared time is refused, as now", () => {
    expect(
      editTimeToSend({ scheduled: true, field: "", savedScheduledFor: at(60 * 60_000).toISOString(), nowMs: NOW, bufferMs: BUFFER }),
    ).toEqual({ ok: false, error: "Choose a valid date and time." });
  });
  it("a draft with a new time is checked and sent, as now", () => {
    const result = editTimeToSend({
      scheduled: false,
      field: toDateTimeLocalValue(at(3 * 60 * 60_000)),
      savedScheduledFor: null,
      nowMs: NOW,
      bufferMs: BUFFER,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.iso).not.toBeNull();
    expect(
      editTimeToSend({ scheduled: false, field: toDateTimeLocalValue(at(-60_000)), savedScheduledFor: null, nowMs: NOW, bufferMs: BUFFER }),
    ).toEqual(tooSoon);
  });
  it("a draft given the time it had before is still sent: choosing a time schedules it", () => {
    const saved = at(3 * 60 * 60_000);
    const result = editTimeToSend({
      scheduled: false,
      field: toDateTimeLocalValue(saved),
      savedScheduledFor: saved.toISOString(),
      nowMs: NOW,
      bufferMs: BUFFER,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.iso).not.toBeNull();
  });
  it("a draft with no time sends none, as now", () => {
    expect(editTimeToSend({ scheduled: false, field: "", savedScheduledFor: null, nowMs: NOW, bufferMs: BUFFER })).toEqual({
      ok: true,
      iso: null,
    });
  });
});

// R26 LL3 item 1: Queue's Publish now and Approve say Create's two sentences
// (composerSubmitOutcome's rule) when publishing couldn't start.
describe("queueFailureText", () => {
  const DISPATCH = { code: "DISPATCH_FAILED", error: "Couldn't start publishing. Please try again.", postJobId: "job-1" };

  it("marked: retry it from Activity", () => {
    expect(queueFailureText({ ...DISPATCH, resultsMarked: true }, "Couldn't publish this post.", "Publish")).toBe(
      "Saved, but publishing couldn't start — retry it from Activity.",
    );
  });

  it("not marked: it can show as publishing for about two hours; don't press the button again", () => {
    expect(queueFailureText({ ...DISPATCH, resultsMarked: false }, "Couldn't publish this post.", "Publish")).toBe(
      "The post was saved but didn't start. In Activity it can show as publishing for about two hours, sometimes a little longer, before it shows as failed; then retry it there. Don't press Publish again.",
    );
    expect(queueFailureText({ ...DISPATCH, resultsMarked: false }, "Couldn't approve this post.", "Approve")).toBe(
      "The post was approved but didn't start. In Activity it can show as publishing for about two hours, sometimes a little longer, before it shows as failed; then retry it there. Don't press Approve again.",
    );
  });

  // R26 LL3 follow-up: Approve says "Approved", Publish and Create keep "Saved".
  it("Approve, marked: Approved, but publishing couldn't start", () => {
    expect(queueFailureText({ ...DISPATCH, resultsMarked: true }, "Couldn't approve this post.", "Approve")).toBe(
      "Approved, but publishing couldn't start — retry it from Activity.",
    );
  });

  // R28 publishing L2: the post was left with no results, so Activity offers
  // Send again on its card, never a Retry.
  it("left without results: press Send again on its card in Activity", () => {
    const bare = { ...DISPATCH, withoutResults: true };
    expect(queueFailureText({ ...bare, resultsMarked: true }, "Couldn't publish this post.", "Publish")).toBe(
      "Saved, but publishing couldn't start — press Send again on its card in Activity.",
    );
    expect(queueFailureText({ ...bare, resultsMarked: true }, "Couldn't approve this post.", "Approve")).toBe(
      "Approved, but publishing couldn't start — press Send again on its card in Activity.",
    );
    expect(queueFailureText({ ...bare, resultsMarked: false }, "Couldn't approve this post.", "Approve")).toBe(
      "The post was approved but didn't start. It will be tried again on its own within about 20 minutes; if that fails too, it shows as failed in Activity, with what to do next on its card. Don't press Approve again.",
    );
    for (const text of [
      queueFailureText({ ...bare, resultsMarked: true }, "x", "Publish"),
      queueFailureText({ ...bare, resultsMarked: false }, "x", "Publish"),
    ]) {
      expect(text).not.toMatch(/retry/i);
    }
  });

  it("any other refusal: the route's sentence, else the fallback", () => {
    expect(queueFailureText({ error: "Refused." }, "Couldn't publish this post.", "Publish")).toBe("Refused.");
    expect(queueFailureText(null, "Couldn't approve this post.", "Approve")).toBe("Couldn't approve this post.");
    expect(queueFailureText({ error: "" }, "Couldn't publish this post.", "Publish")).toBe("Couldn't publish this post.");
  });
});

// R27 publishing-flow L3 = pages L10: a Queue action whose answer was lost may
// have gone through; one that never left says to check the connection.
describe("sendActionRequest", () => {
  const init = { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" };
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

  it("offline: sends nothing and says so", async () => {
    const fetchImpl = vi.fn();
    await expect(sendActionRequest("/api/x", init, { fetchImpl, online: () => false })).resolves.toEqual({ kind: "not_sent" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("a rejected fetch: no answer, it may have gone through", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
    await expect(sendActionRequest("/api/x", init, { fetchImpl, online: () => true })).resolves.toEqual({ kind: "no_answer" });
  });

  it("a gateway's 502 or 504 page: no answer", async () => {
    for (const status of [502, 504]) {
      const fetchImpl = vi.fn().mockResolvedValue(new Response("<html>Gateway</html>", { status }));
      await expect(sendActionRequest("/api/x", init, { fetchImpl, online: () => true })).resolves.toEqual({ kind: "no_answer" });
    }
  });

  it("the route's own 5xx and every other answer come back to be read", async () => {
    const dispatch = json(503, { code: "DISPATCH_FAILED", error: "Couldn't start publishing." });
    const fetchImpl = vi.fn().mockResolvedValueOnce(dispatch).mockResolvedValueOnce(json(409, { error: "Changed." }));
    const first = await sendActionRequest("/api/x", init, { fetchImpl, online: () => true });
    expect(first.kind).toBe("answer");
    if (first.kind === "answer") await expect(first.response.json()).resolves.toMatchObject({ code: "DISPATCH_FAILED" });
    const second = await sendActionRequest("/api/x", init, { fetchImpl, online: () => true });
    expect(second.kind === "answer" && second.response.status).toBe(409);
    expect(fetchImpl).toHaveBeenCalledWith("/api/x", init);
  });
});

describe("queueNotSentText and queueMayHaveGoneThroughText", () => {
  it("nothing was sent: the connection sentence, naming the button", () => {
    expect(queueNotSentText("approve")).toBe(
      "We couldn't reach Vibe Socials, so the post wasn't approved. Check your connection and press Approve again.",
    );
    expect(queueNotSentText("reject")).toBe(
      "We couldn't reach Vibe Socials, so the post wasn't rejected. Check your connection and press Reject again.",
    );
    expect(queueNotSentText("publish")).toBe(
      "We couldn't reach Vibe Socials, so the post wasn't published. Check your connection and press Publish now again.",
    );
    expect(queueNotSentText("submit")).toBe(
      "We couldn't reach Vibe Socials, so the post wasn't sent for approval. Check your connection and press Submit for approval again.",
    );
    expect(queueNotSentText("schedule")).toBe(
      "We couldn't reach Vibe Socials, so the post wasn't scheduled. Check your connection and press Save and schedule again.",
    );
    expect(queueNotSentText("edit")).toBe(
      "We couldn't reach Vibe Socials, so your changes weren't saved. Check your connection and save again.",
    );
  });

  it("no answer: the shared lead-in, what may have happened, the Queue is being reloaded, check before pressing again", () => {
    const lead = "Vibe Socials' answer didn't reach you, so ";
    const reconnect = " If your connection dropped, reconnect first. ";
    expect(queueMayHaveGoneThroughText("approve")).toBe(
      `${lead}the post may have been approved.${reconnect}We're reloading the Queue: check it and Activity before you press Approve again.`,
    );
    expect(queueMayHaveGoneThroughText("reject")).toBe(
      `${lead}the post may have been rejected.${reconnect}We're reloading the Queue: check it before you press Reject again.`,
    );
    expect(queueMayHaveGoneThroughText("publish")).toBe(
      `${lead}the post may have started publishing.${reconnect}We're reloading the Queue: check Activity before you press Publish now again.`,
    );
    expect(queueMayHaveGoneThroughText("submit")).toBe(
      `${lead}the post may have been sent for approval.${reconnect}We're reloading the Queue: check it before you press Submit for approval again.`,
    );
    expect(queueMayHaveGoneThroughText("schedule")).toBe(
      `${lead}the post may have been scheduled.${reconnect}We're reloading the Queue: check it before you press Save and schedule again.`,
    );
    expect(queueMayHaveGoneThroughText("edit")).toBe(
      `${lead}your changes may have been saved.${reconnect}We're reloading the Queue: check the post before you save again.`,
    );
    for (const action of ["approve", "reject", "publish", "submit", "schedule", "edit"] as const) {
      expect(queueMayHaveGoneThroughText(action)).toBe(
        answerLostText(MAY_HAVE_CLAUSE[action], queueMayHaveGoneThroughText(action).split("reconnect first. ")[1]),
      );
      expect(queueMayHaveGoneThroughText(action)).not.toMatch(/nothing changed|has been reloaded/i);
    }
  });
});

// R27 publishing-flow L2 = pages L2: Reject no longer spins Approve.
describe("decisionButtonState", () => {
  it("the pressed button spins; the other is aria-disabled, never disabled", () => {
    expect(decisionButtonState("reject", "reject")).toEqual({ loading: true, "aria-disabled": true });
    expect(decisionButtonState("reject", "approve")).toEqual({ loading: false, "aria-disabled": true });
    expect(decisionButtonState("approve", "approve")).toEqual({ loading: true, "aria-disabled": true });
    expect(decisionButtonState("approve", "reject")).toEqual({ loading: false, "aria-disabled": true });
  });

  it("nothing in flight: neither", () => {
    expect(decisionButtonState(null, "approve")).toEqual({ loading: false, "aria-disabled": undefined });
    expect(decisionButtonState(null, "reject")).toEqual({ loading: false, "aria-disabled": undefined });
  });
});

// R57 client-journey L1 / publishing-flow L1: Approve and Schedule clear the
// client's approval as they schedule the post; the answer says so, and the card
// (both halves of a Feed and Story card) drops its "Client approved" badge.
describe("decisionOutcome and publishOutcome: a client approval the schedule withdrew", () => {
  const held = {
    id: "job-1",
    status: "draft",
    scheduledFor: "2026-11-25T15:00:00.000Z",
    caption: "Dawn patrol",
    approvalState: "pending",
    clientApprovedAt: "2026-11-19T10:00:00.000Z",
  } as unknown as PostJobDTO;
  const approveAnswer = {
    ok: true,
    decision: "approve",
    status: "scheduled",
    approvalState: "approved",
    scheduledFor: "2026-11-25T15:00:00.000Z",
    clientApprovedAt: null,
  };
  const patchOf = (outcome: ReturnType<typeof decisionOutcome>) => (outcome.kind === "update" ? outcome.patch : {});

  it("Approve on a held post that kept a client approval: no badge", () => {
    const patch = patchOf(decisionOutcome("approve", approveAnswer));
    expect(patch).toHaveProperty("clientApprovedAt", null);
    const after = applyJobPatch(held, patch);
    expect(after.status).toBe("scheduled");
    expect(after.clientApprovedAt).toBeNull();
  });

  it("scheduling a draft that kept one: no badge", () => {
    const draft = { ...held, approvalState: "none" } as PostJobDTO;
    const patch = patchOf(
      publishOutcome({ ok: true, status: "scheduled", scheduledFor: "2026-11-26T15:00:00.000Z", clientApprovedAt: null }),
    );
    expect(patch).toHaveProperty("clientApprovedAt", null);
    const after = applyJobPatch(draft, patch);
    expect(after.status).toBe("scheduled");
    expect(after.clientApprovedAt).toBeNull();
  });

  it("a post with no client approval: unchanged but for the schedule", () => {
    const plain = { ...held, clientApprovedAt: null } as PostJobDTO;
    expect(applyJobPatch(plain, patchOf(decisionOutcome("approve", approveAnswer)))).toEqual({
      ...plain,
      status: "scheduled",
      approvalState: "approved",
    });
  });

  it("an answer that says nothing about it (an older server) leaves the badge as it is", () => {
    const older: Record<string, unknown> = { ...approveAnswer };
    delete older.clientApprovedAt;
    expect(patchOf(decisionOutcome("approve", older))).not.toHaveProperty("clientApprovedAt");
    expect(publishOutcome({ ok: true, status: "scheduled" })).toEqual({
      kind: "update",
      patch: { status: "scheduled" },
      message: "Post scheduled.",
    });
  });

  it("a pair: the other half's patch withdraws it too", () => {
    for (const outcome of [
      decisionOutcome("approve", approveAnswer),
      publishOutcome({ ok: true, status: "scheduled", clientApprovedAt: null }),
    ]) {
      expect(otherHalfPatch(patchOf(outcome))).toHaveProperty("clientApprovedAt", null);
    }
  });
});
