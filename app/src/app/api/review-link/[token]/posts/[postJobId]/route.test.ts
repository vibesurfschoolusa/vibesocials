import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  findActiveReviewLinkMock,
  notifyOwnersOfClientChangeMock,
  checkRateLimitMock,
  postUpdateManyMock,
  postFindFirstMock,
  linkUpdateMock,
  afterMock,
} = vi.hoisted(() => ({
  postFindFirstMock: vi.fn(),
  findActiveReviewLinkMock: vi.fn(),
  notifyOwnersOfClientChangeMock: vi.fn(),
  checkRateLimitMock: vi.fn(),
  postUpdateManyMock: vi.fn(),
  linkUpdateMock: vi.fn(),
  afterMock: vi.fn(),
}));

vi.mock("@/server/reviewLink", () => ({
  findActiveReviewLink: findActiveReviewLinkMock,
  notifyOwnersOfClientChange: notifyOwnersOfClientChangeMock,
}));
vi.mock("@/lib/rateLimit", () => ({ checkRateLimit: checkRateLimitMock }));
// Only these calls exist: any other prisma call would throw here.
vi.mock("@/lib/db", () => ({
  prisma: {
    postJob: { updateMany: postUpdateManyMock, findFirst: postFindFirstMock },
    workspaceReviewLink: { update: linkUpdateMock },
  },
}));
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: afterMock,
}));

import {
  REVIEW_DECISION_INVALID_MESSAGE,
  REVIEW_LINK_INACTIVE_MESSAGE,
  REVIEW_NOTE_MISSING_MESSAGE,
  REVIEW_NOTE_TOO_LONG_MESSAGE,
  REVIEW_POST_CHANGED_MESSAGE,
  REVIEW_POST_LOCKED_MESSAGE,
  REVIEW_VERSION_MISSING_MESSAGE,
} from "@/lib/reviewLink";
import {
  editApprovalEffect,
  isHeldForApproval,
  publishApprovalAction,
  type ApprovalFacts,
} from "@/lib/approval";

import { POST } from "./route";

const TOKEN = "T".repeat(43);
const LINK = { id: "link-1", workspaceId: "ws-1", workspaceName: "Surf Co" };
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
/** The post's updatedAt as the page received it. */
const VERSION = "2026-11-10T10:00:00.123Z";

function call(body: unknown, { token = TOKEN, postJobId = "post-1", raw = false } = {}) {
  return POST(
    new Request(`http://localhost/api/review-link/${token}/posts/${postJobId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-forwarded-for": "203.0.113.7" },
      body: raw ? (body as string) : JSON.stringify(body),
    }),
    { params: Promise.resolve({ token, postJobId }) },
  );
}

beforeEach(() => {
  for (const mock of [
    findActiveReviewLinkMock,
    notifyOwnersOfClientChangeMock,
    checkRateLimitMock,
    postUpdateManyMock,
    postFindFirstMock,
    linkUpdateMock,
    afterMock,
  ]) {
    mock.mockReset();
  }
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});

  checkRateLimitMock.mockResolvedValue({ allowed: true });
  findActiveReviewLinkMock.mockResolvedValue(LINK);
  postUpdateManyMock.mockResolvedValue({ count: 1 });
  postFindFirstMock.mockResolvedValue(null);
  linkUpdateMock.mockResolvedValue({});
  notifyOwnersOfClientChangeMock.mockResolvedValue(undefined);
});

/** The post the update may touch: the link's workspace, still scheduled, inside the page's 60 days. */
function expectedWhere() {
  return {
    id: "post-1",
    workspaceId: "ws-1",
    status: "scheduled",
    scheduledFor: { lte: expect.any(Date) },
  };
}

describe("approve", () => {
  it("records the approval, clears an earlier change request, and leaves the post scheduled", async () => {
    const before = Date.now();
    const response = await call({ decision: "approve", version: VERSION });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(postUpdateManyMock).toHaveBeenCalledTimes(1);
    const { where, data } = postUpdateManyMock.mock.calls[0][0];
    // The version written is the one the answer carries.
    expect(body).toEqual({ ok: true, state: "approved", version: data.updatedAt.toISOString() });
    // Pinned to the version the client looked at.
    expect(where).toEqual({ ...expectedWhere(), updatedAt: new Date(VERSION) });
    // Exactly these fields: no status, no time, no member-approval columns.
    expect(data).toEqual({
      clientApprovedAt: expect.any(Date),
      clientChangeRequestedAt: null,
      clientNote: null,
      // Set by hand, to the same instant, so the new version is known without a read.
      updatedAt: data.clientApprovedAt,
    });
    const limit = (where.scheduledFor.lte as Date).getTime();
    expect(limit).toBeGreaterThanOrEqual(before + 60 * DAY);
    expect(limit).toBeLessThanOrEqual(Date.now() + 60 * DAY);
  });

  it("answers the version the next approve must send, and that approve lands on it", async () => {
    const first = await (await call({ decision: "approve", version: VERSION })).json();
    const written = postUpdateManyMock.mock.calls[0][0].data.updatedAt as Date;

    await call({ decision: "approve", version: first.version });

    expect(postUpdateManyMock.mock.calls[1][0].where.updatedAt).toEqual(written);
  });

  it("sends no email", async () => {
    await call({ decision: "approve", version: VERSION });
    expect(afterMock).not.toHaveBeenCalled();
    expect(notifyOwnersOfClientChangeMock).not.toHaveBeenCalled();
  });

  it("stamps the link's last use", async () => {
    await call({ decision: "approve", version: VERSION });
    expect(linkUpdateMock).toHaveBeenCalledWith({
      where: { id: "link-1" },
      data: { lastUsedAt: expect.any(Date) },
    });
  });
});

describe("ask for a change", () => {
  it("turns the post into a draft with the note, in one conditional update, keeping its time", async () => {
    const response = await call({ decision: "change", note: "  Use the other photo  " });

    expect(response.status).toBe(200);
    // The note as stored, so the card shows exactly what the owners will read.
    await expect(response.json()).resolves.toEqual({
      ok: true,
      state: "change_requested",
      note: "Use the other photo",
    });
    expect(postUpdateManyMock).toHaveBeenCalledTimes(1);
    const { where, data } = postUpdateManyMock.mock.calls[0][0];
    expect(where).toEqual(expectedWhere());
    expect(data).toEqual({
      status: "draft",
      clientChangeRequestedAt: expect.any(Date),
      clientNote: "Use the other photo",
      clientApprovedAt: null,
      // A plain draft again: the owner's approval was for the post as it was.
      submittedForApprovalAt: null,
      approvedAt: null,
      approvedByUserId: null,
    });
    expect(data).not.toHaveProperty("scheduledFor");
    // Stopping a post on an old view is harmless, so a change request is not pinned.
    expect(where).not.toHaveProperty("updatedAt");
  });

  it("sends the post back through owner approval: a member cannot schedule edited text unreviewed", async () => {
    // A member's post the owner approved, scheduled, in a workspace that requires approval.
    let post: ApprovalFacts & { baseCaption: string } = {
      status: "scheduled",
      submittedForApprovalAt: new Date("2026-11-09T09:00:00Z"),
      approvedAt: new Date("2026-11-09T10:00:00Z"),
      baseCaption: "Reviewed text",
    };
    const member = { requireApproval: true, role: "member" as const };

    // The client asks for a change: apply the route's write to the post.
    await call({ decision: "change", note: "Use the other photo" });
    post = { ...post, ...postUpdateManyMock.mock.calls[0][0].data };
    expect(post.status).toBe("draft");
    expect(isHeldForApproval(post)).toBe(false);

    // The member edits the caption: a plain draft takes the edit as is.
    expect(editApprovalEffect({ ...member, job: post })).toBe("none");
    post = { ...post, baseCaption: "Unreviewed text" };

    // The member schedules it: the publish route must submit it for approval, not schedule it.
    expect(publishApprovalAction({ ...member, job: post })).toBe("submit");
  });

  it("stores a note with markup as the text it is", async () => {
    const note = '<script>alert("x")</script> & more';
    await call({ decision: "change", note });
    expect(postUpdateManyMock.mock.calls[0][0].data.clientNote).toBe(note);
  });

  it("emails the owners after the response, with the link's workspace", async () => {
    const response = await call({ decision: "change", note: "Use the other photo" });

    expect(response.status).toBe(200);
    expect(notifyOwnersOfClientChangeMock).not.toHaveBeenCalled();
    expect(afterMock).toHaveBeenCalledTimes(1);

    await afterMock.mock.calls[0][0]();
    const requestedAt = postUpdateManyMock.mock.calls[0][0].data.clientChangeRequestedAt;
    expect(notifyOwnersOfClientChangeMock).toHaveBeenCalledWith({
      postJobId: "post-1",
      workspaceId: "ws-1",
      workspaceName: "Surf Co",
      note: "Use the other photo",
      requestedAt,
    });
  });

  it("does not fail when the email fails", async () => {
    notifyOwnersOfClientChangeMock.mockRejectedValue(new Error("resend down"));
    const response = await call({ decision: "change", note: "x" });

    expect(response.status).toBe(200);
    await expect(afterMock.mock.calls[0][0]()).resolves.toBeUndefined();
  });

  it("refuses a missing, blank or over-long note before counting or writing anything", async () => {
    for (const [note, message] of [
      [undefined, REVIEW_NOTE_MISSING_MESSAGE],
      ["   ", REVIEW_NOTE_MISSING_MESSAGE],
      ["a".repeat(501), REVIEW_NOTE_TOO_LONG_MESSAGE],
    ] as const) {
      const response = await call({ decision: "change", note });
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({ error: message });
    }
    expect(checkRateLimitMock).not.toHaveBeenCalled();
    expect(postUpdateManyMock).not.toHaveBeenCalled();
  });
});

describe("a post that can no longer be changed here", () => {
  it("answers 409 and writes nothing else when the update matches no row", async () => {
    // Already published, cancelled, a draft, outside the 60 days, or not this workspace's.
    postUpdateManyMock.mockResolvedValue({ count: 0 });

    for (const body of [{ decision: "approve", version: VERSION }, { decision: "change", note: "x" }]) {
      const response = await call(body);
      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toEqual({ error: REVIEW_POST_LOCKED_MESSAGE });
    }
    expect(afterMock).not.toHaveBeenCalled();
    expect(linkUpdateMock).not.toHaveBeenCalled();
  });

  it("loses cleanly to the scheduler claiming the post at the same moment", async () => {
    // The scanner's claim committed first: the post is in_progress, so the
    // status-guarded update finds no row. One statement, so nothing half-applies.
    postUpdateManyMock.mockResolvedValue({ count: 0 });

    const response = await call({ decision: "change", note: "Stop this one" });

    expect(response.status).toBe(409);
    expect(postUpdateManyMock).toHaveBeenCalledTimes(1);
    expect(postUpdateManyMock.mock.calls[0][0].where.status).toBe("scheduled");
    expect(afterMock).not.toHaveBeenCalled();
  });

  it("takes the workspace only from the link, never from the body", async () => {
    postUpdateManyMock.mockResolvedValue({ count: 0 });
    await call({ decision: "approve", version: VERSION, workspaceId: "ws-other" }, { postJobId: "post-of-ws-other" });

    expect(postUpdateManyMock.mock.calls[0][0].where).toMatchObject({
      id: "post-of-ws-other",
      workspaceId: "ws-1",
    });
  });
});

describe("approving a version the client did not see", () => {
  it("answers 409 with the changed sentence when the post is still there but was edited", async () => {
    postUpdateManyMock.mockResolvedValue({ count: 0 });
    postFindFirstMock.mockResolvedValue({ updatedAt: new Date(), clientApprovedAt: null });

    const response = await call({ decision: "approve", version: VERSION });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: REVIEW_POST_CHANGED_MESSAGE });
    expect(REVIEW_POST_CHANGED_MESSAGE).toBe(
      "This post was changed after you opened this page. Have a look at the new version.",
    );
    // The same scope as the write, without the version: only a read, nothing written.
    const { where } = postFindFirstMock.mock.calls[0][0];
    expect(where).toEqual(expectedWhere());
    expect(postUpdateManyMock).toHaveBeenCalledTimes(1);
    expect(linkUpdateMock).not.toHaveBeenCalled();
  });

  it("lets a repeated approval stand: 200 with the current version, nothing written", async () => {
    // Two phones, or a retry after a lost answer: the only change was the client's own approval.
    postUpdateManyMock.mockResolvedValue({ count: 0 });
    postFindFirstMock.mockResolvedValue({
      updatedAt: new Date("2026-11-10T11:00:00.500Z"),
      clientApprovedAt: new Date("2026-11-10T11:00:00.500Z"),
    });

    const response = await call({ decision: "approve", version: VERSION });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      state: "approved",
      version: "2026-11-10T11:00:00.500Z",
    });
    // Scoped exactly like the write, minus the version.
    expect(postFindFirstMock).toHaveBeenCalledWith({
      where: expectedWhere(),
      select: { updatedAt: true, clientApprovedAt: true },
    });
    expect(postUpdateManyMock).toHaveBeenCalledTimes(1);
    expect(linkUpdateMock).not.toHaveBeenCalled();
  });

  it("answers the changed 409 when the post is in reach but not approved (an owner's edit cleared it)", async () => {
    postUpdateManyMock.mockResolvedValue({ count: 0 });
    postFindFirstMock.mockResolvedValue({ updatedAt: new Date(), clientApprovedAt: null });
    const response = await call({ decision: "approve", version: VERSION });
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: REVIEW_POST_CHANGED_MESSAGE });
  });

  it("answers the plain 409 when the post is gone from the client's reach", async () => {
    postUpdateManyMock.mockResolvedValue({ count: 0 });
    postFindFirstMock.mockResolvedValue(null);
    const response = await call({ decision: "approve", version: VERSION });
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: REVIEW_POST_LOCKED_MESSAGE });
  });

  it("refuses an approval without a readable version, before counting or writing", async () => {
    for (const version of [undefined, "", "yesterday", 12]) {
      const response = await call({ decision: "approve", version });
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({ error: REVIEW_VERSION_MISSING_MESSAGE });
    }
    expect(checkRateLimitMock).not.toHaveBeenCalled();
    expect(postUpdateManyMock).not.toHaveBeenCalled();
  });
});

describe("the link", () => {
  it("answers an unknown and a revoked link identically, and writes nothing", async () => {
    findActiveReviewLinkMock.mockResolvedValue(null);
    const unknown = await call({ decision: "approve", version: VERSION }, { token: "unknown" });
    const revoked = await call({ decision: "approve", version: VERSION });

    expect(unknown.status).toBe(404);
    expect(revoked.status).toBe(404);
    const [a, b] = [await unknown.json(), await revoked.json()];
    expect(a).toEqual({ error: REVIEW_LINK_INACTIVE_MESSAGE });
    expect(b).toEqual(a);
    expect(postUpdateManyMock).not.toHaveBeenCalled();
  });
});

describe("the request", () => {
  it("refuses an unknown decision or a body that is not JSON", async () => {
    const unknown = await call({ decision: "publish" });
    expect(unknown.status).toBe(400);
    await expect(unknown.json()).resolves.toEqual({ error: REVIEW_DECISION_INVALID_MESSAGE });

    expect((await call("not json", { raw: true })).status).toBe(400);
    expect(postUpdateManyMock).not.toHaveBeenCalled();
  });

  it("answers 500 when the write fails", async () => {
    postUpdateManyMock.mockRejectedValue(new Error("db down"));
    expect((await call({ decision: "approve", version: VERSION })).status).toBe(500);
  });
});

describe("limits", () => {
  it("counts the address in the bucket the list route uses, before the lookup", async () => {
    checkRateLimitMock.mockResolvedValueOnce({ allowed: false, retryAfterSeconds: 90 });

    const response = await call({ decision: "approve", version: VERSION });

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("90");
    expect(checkRateLimitMock).toHaveBeenCalledWith({
      userId: "ip:203.0.113.7",
      route: "review-link/ip",
      limit: 120,
      windowMs: HOUR,
      failClosed: true,
    });
    expect(findActiveReviewLinkMock).not.toHaveBeenCalled();
    expect(postUpdateManyMock).not.toHaveBeenCalled();
  });

  it("allows 300 decisions a day per link, failing closed", async () => {
    checkRateLimitMock
      .mockResolvedValueOnce({ allowed: true })
      .mockResolvedValueOnce({ allowed: false, retryAfterSeconds: 3600 });

    const response = await call({ decision: "change", note: "x" });

    expect(response.status).toBe(429);
    expect(checkRateLimitMock).toHaveBeenLastCalledWith({
      userId: "review-link:link-1",
      route: "review-link/decision-day",
      limit: 300,
      windowMs: DAY,
      failClosed: true,
    });
    expect(postUpdateManyMock).not.toHaveBeenCalled();
  });
});
