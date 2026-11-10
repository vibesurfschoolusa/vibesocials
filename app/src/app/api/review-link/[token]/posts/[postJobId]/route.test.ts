import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  findActiveReviewLinkMock,
  notifyOwnersOfClientChangeMock,
  checkRateLimitMock,
  postUpdateManyMock,
  linkUpdateMock,
  afterMock,
} = vi.hoisted(() => ({
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
// Only these two writes exist: any other prisma call would throw here.
vi.mock("@/lib/db", () => ({
  prisma: {
    postJob: { updateMany: postUpdateManyMock },
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
  REVIEW_POST_LOCKED_MESSAGE,
} from "@/lib/reviewLink";

import { POST } from "./route";

const TOKEN = "T".repeat(43);
const LINK = { id: "link-1", workspaceId: "ws-1", workspaceName: "Surf Co" };
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

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
    const response = await call({ decision: "approve" });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, state: "approved" });
    expect(postUpdateManyMock).toHaveBeenCalledTimes(1);
    const { where, data } = postUpdateManyMock.mock.calls[0][0];
    expect(where).toEqual(expectedWhere());
    // Exactly these fields: no status, no time, no member-approval columns.
    expect(data).toEqual({
      clientApprovedAt: expect.any(Date),
      clientChangeRequestedAt: null,
      clientNote: null,
    });
    const limit = (where.scheduledFor.lte as Date).getTime();
    expect(limit).toBeGreaterThanOrEqual(before + 60 * DAY);
    expect(limit).toBeLessThanOrEqual(Date.now() + 60 * DAY);
  });

  it("sends no email", async () => {
    await call({ decision: "approve" });
    expect(afterMock).not.toHaveBeenCalled();
    expect(notifyOwnersOfClientChangeMock).not.toHaveBeenCalled();
  });

  it("stamps the link's last use", async () => {
    await call({ decision: "approve" });
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
    await expect(response.json()).resolves.toEqual({ ok: true, state: "change_requested" });
    expect(postUpdateManyMock).toHaveBeenCalledTimes(1);
    const { where, data } = postUpdateManyMock.mock.calls[0][0];
    expect(where).toEqual(expectedWhere());
    expect(data).toEqual({
      status: "draft",
      clientChangeRequestedAt: expect.any(Date),
      clientNote: "Use the other photo",
      clientApprovedAt: null,
    });
    expect(data).not.toHaveProperty("scheduledFor");
    expect(data).not.toHaveProperty("submittedForApprovalAt");
    expect(data).not.toHaveProperty("approvedAt");
    expect(data).not.toHaveProperty("approvedByUserId");
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

    for (const body of [{ decision: "approve" }, { decision: "change", note: "x" }]) {
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
    await call({ decision: "approve", workspaceId: "ws-other" }, { postJobId: "post-of-ws-other" });

    expect(postUpdateManyMock.mock.calls[0][0].where).toMatchObject({
      id: "post-of-ws-other",
      workspaceId: "ws-1",
    });
  });
});

describe("the link", () => {
  it("answers an unknown and a revoked link identically, and writes nothing", async () => {
    findActiveReviewLinkMock.mockResolvedValue(null);
    const unknown = await call({ decision: "approve" }, { token: "unknown" });
    const revoked = await call({ decision: "approve" });

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
    expect((await call({ decision: "approve" })).status).toBe(500);
  });
});

describe("limits", () => {
  it("counts the address in the bucket the list route uses, before the lookup", async () => {
    checkRateLimitMock.mockResolvedValueOnce({ allowed: false, retryAfterSeconds: 90 });

    const response = await call({ decision: "approve" });

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
