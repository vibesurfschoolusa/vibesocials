import { Prisma } from "@prisma/client";
import type { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { makeWorkspaceContext } from "../../__test-helpers__/workspaceContextMock";

// vitest hoists vi.mock above imports. route.ts imports `@/lib/workspace`,
// `@/lib/db` and `@/lib/scheduling` (kept REAL — pure guards) at module
// scope; `Prisma` from `@prisma/client` is real too (the handler uses
// `Prisma.DbNull`).
const {
  getWorkspaceContextMock,
  findFirstMock,
  updateManyMock,
  deleteManyMock,
  postJobResultFindManyMock,
  notifyOwnersMock,
  checkDailyPostLimitMock,
  queueCoverMock,
  transactionMock,
} = vi.hoisted(() => ({
  transactionMock: vi.fn(),
  queueCoverMock: vi.fn(),
  getWorkspaceContextMock: vi.fn(),
  findFirstMock: vi.fn(),
  updateManyMock: vi.fn(),
  deleteManyMock: vi.fn(),
  postJobResultFindManyMock: vi.fn(),
  notifyOwnersMock: vi.fn(),
  checkDailyPostLimitMock: vi.fn(),
}));

// Team Workspaces (Task 4): getCurrentUser -> getWorkspaceContext.
vi.mock("@/lib/workspace", () => ({ getWorkspaceContext: getWorkspaceContextMock }));
vi.mock("@/lib/db", () => ({
  prisma: {
    postJob: {
      findFirst: findFirstMock,
      updateMany: updateManyMock,
      deleteMany: deleteManyMock,
    },
    postJobResult: { findMany: postJobResultFindManyMock },
    $transaction: transactionMock,
  },
}));
vi.mock("@/server/notifications/approvalRequested", () => ({
  notifyOwnersOfApprovalRequest: notifyOwnersMock,
}));
// Usage limits (2026-11-10): the count has its own suite (workspaceUsage.test.ts).
vi.mock("@/server/usage/workspaceUsage", () => ({
  checkDailyPostLimit: checkDailyPostLimitMock,
}));

// V1 fix round 1: the cover file queue has its own suite (coverBlobs.test.ts).
vi.mock("@/server/jobs/coverBlobs", () => ({ queueCoverBlobIfUnused: queueCoverMock }));

import { prisma } from "@/lib/db";

import { PATCH, DELETE, GET } from "./route";

const FUTURE = new Date(Date.now() + 60 * 60 * 1000).toISOString();

function ctx(postJobId: string) {
  // Next 16 passes `params` as a PROMISE. Resolving it is the handler's job
  // (`await Promise.resolve(context.params)` — the pattern every sibling route
  // uses). This fixture MUST be a promise: with a plain object, a handler that
  // forgets to await still reads the id fine, so the tests pass while
  // production sends `id: undefined` to Prisma — which silently matches the
  // FIRST job in the workspace instead of the requested one.
  return { params: Promise.resolve({ postJobId }) };
}
/** R31 pages L2: every request carries the page's workspace id (the context's "ws-1"). */
function withWorkspace(body: unknown): unknown {
  return body !== null && typeof body === "object" && !Array.isArray(body) ? { workspaceId: "ws-1", ...body } : body;
}
function req(body: unknown, throwOnJson = false): NextRequest {
  return {
    json: async () => {
      if (throwOnJson) throw new Error("bad json");
      return withWorkspace(body);
    },
  } as unknown as NextRequest;
}

/**
 * Full raw PostJob row, as Prisma's `findFirst` would return it — includes
 * userId/workspaceId/publishMetadata/updatedAt so the DTO-projection tests'
 * negative assertions actually exercise the drop (a minimal `{ id }` fixture
 * would pass trivially even with no projection at all).
 */
function makeJobRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "job-1",
    userId: "user-1",
    workspaceId: "ws-1",
    mediaItemId: "media-1",
    status: "completed",
    scheduledFor: null,
    baseCaption: "hello world",
    perPlatformOverrides: null,
    publishMetadata: { youtube: { privacyStatus: "public" } },
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:05:00Z"),
    ...overrides,
  };
}

/** Full raw PostJobResult row, as Prisma's `findMany` would return it. */
function makeResultRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "result-1",
    postJobId: "job-1",
    platform: "youtube",
    socialConnectionId: "conn-1",
    status: "success",
    externalPostId: "yt-123",
    errorCode: null,
    errorMessage: null,
    createdAt: new Date("2026-01-01T00:01:00Z"),
    updatedAt: new Date("2026-01-01T00:01:30Z"),
    ...overrides,
  };
}

beforeEach(() => {
  getWorkspaceContextMock.mockReset();
  findFirstMock.mockReset();
  updateManyMock.mockReset();
  deleteManyMock.mockReset();
  postJobResultFindManyMock.mockReset();
  notifyOwnersMock.mockReset();
  checkDailyPostLimitMock.mockReset();
  checkDailyPostLimitMock.mockResolvedValue(null);
  getWorkspaceContextMock.mockResolvedValue(makeWorkspaceContext());
  notifyOwnersMock.mockResolvedValue(undefined);
  updateManyMock.mockResolvedValue({ count: 1 });
  deleteManyMock.mockResolvedValue({ count: 1 });
  postJobResultFindManyMock.mockResolvedValue([]);
});

/** R32: the Queue's single-post read, from a page drawn for `workspaceId` (null sends none). */
function getReq(workspaceId: string | null = "ws-1"): NextRequest {
  const address = new URL("http://localhost/api/posts/job-1");
  if (workspaceId !== null) address.searchParams.set("workspaceId", workspaceId);
  return new Request(address) as unknown as NextRequest;
}

describe("GET /api/posts/[postJobId]", () => {
  // R32 publishing L1: the Queue's Edit reads the post for the page's workspace only.
  it("409s another workspace's id and reads nothing", async () => {
    const res = await GET(getReq("ws-2"), ctx("job-1"));
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("WORKSPACE_CHANGED");
    expect(findFirstMock).not.toHaveBeenCalled();
  });

  it("400s a page that sent no id and reads nothing", async () => {
    const res = await GET(getReq(null), ctx("job-1"));
    expect(res.status).toBe(400);
    expect(findFirstMock).not.toHaveBeenCalled();
  });

  it("401s when unauthenticated", async () => {
    getWorkspaceContextMock.mockResolvedValue(null);
    const res = await GET(getReq(), ctx("job-1"));
    expect(res.status).toBe(401);
    expect(findFirstMock).not.toHaveBeenCalled();
  });

  it("404s when the job isn't in the caller's active workspace", async () => {
    findFirstMock.mockResolvedValue(null);
    const res = await GET(getReq(), ctx("job-1"));
    expect(res.status).toBe(404);
  });

  it("scopes the ownership read to workspaceId (not userId) — cross-workspace isolation", async () => {
    findFirstMock.mockResolvedValue(makeJobRow());

    await GET(getReq(), ctx("job-1"));

    expect(findFirstMock).toHaveBeenCalledWith({
      where: { id: "job-1", workspaceId: "ws-1" },
    });
  });

  it("a job belonging to a DIFFERENT workspace 404s, not 403 (no existence oracle)", async () => {
    // The caller's active workspace is ws-1; simulate the real-DB outcome for
    // a job that actually lives in ws-2 — the where clause wouldn't match it,
    // so Prisma would return null, same as "doesn't exist".
    findFirstMock.mockResolvedValue(null);
    const res = await GET(getReq(), ctx("foreign-job"));
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ error: "This post no longer exists." });
  });
});

describe("GET /api/posts/[postJobId] — response DTO projection (SEC-1)", () => {
  it("projects the job + results to the display DTO, dropping internal fields", async () => {
    const jobRow = makeJobRow();
    const resultRow = makeResultRow();
    findFirstMock.mockResolvedValue(jobRow);
    postJobResultFindManyMock.mockResolvedValue([resultRow]);

    const res = await GET(getReq(), ctx("job-1"));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.postJob).toEqual({
      id: "job-1",
      status: "completed",
      createdAt: jobRow.createdAt.toISOString(),
      scheduledFor: null,
      baseCaption: "hello world",
      perPlatformOverrides: null,
      mediaItemId: "media-1",
    });
    expect(body.postJob.createdAt).toBe(jobRow.createdAt.toISOString());
    expect(body.results).toEqual([
      {
        platform: "youtube",
        status: "success",
        externalPostId: "yt-123",
        errorMessage: null,
      },
    ]);

    const raw = JSON.stringify(body);
    expect(raw).not.toContain("socialConnectionId");
    expect(raw).not.toContain("workspaceId");
    expect(raw).not.toContain('"userId"');
    expect(raw).not.toContain("publishMetadata");
    expect(raw).not.toContain("errorCode");
    expect(raw).not.toContain("updatedAt");
  });

  // 2026-11-01 audit, Task 5: Disconnect / Switch account SET NULL the FK
  // instead of deleting the history, so a result can have no connection.
  it("still returns a result whose connection was removed (null socialConnectionId)", async () => {
    findFirstMock.mockResolvedValue(makeJobRow());
    postJobResultFindManyMock.mockResolvedValue([
      makeResultRow({ socialConnectionId: null, status: "failed", externalPostId: null, errorMessage: "boom" }),
    ]);

    const res = await GET(getReq(), ctx("job-1"));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.results).toEqual([
      { platform: "youtube", status: "failed", externalPostId: null, errorMessage: "boom" },
    ]);
    expect(JSON.stringify(body)).not.toContain("socialConnectionId");
  });

  it("maps a scheduled job's Date scheduledFor to an ISO string, and an empty results list to []", async () => {
    const scheduledFor = new Date("2026-02-01T12:00:00Z");
    findFirstMock.mockResolvedValue(
      makeJobRow({ status: "scheduled", scheduledFor, publishMetadata: null }),
    );
    postJobResultFindManyMock.mockResolvedValue([]);

    const res = await GET(getReq(), ctx("job-1"));
    const body = await res.json();

    expect(body.postJob.status).toBe("scheduled");
    expect(body.postJob.scheduledFor).toBe(scheduledFor.toISOString());
    expect(body.results).toEqual([]);
  });
});

describe("PATCH /api/posts/[postJobId]", () => {
  it("401s when unauthenticated", async () => {
    getWorkspaceContextMock.mockResolvedValue(null);
    const res = await PATCH(req({ baseCaption: "x" }), ctx("job-1"));
    expect(res.status).toBe(401);
  });

  it("400s on invalid JSON", async () => {
    const res = await PATCH(req(undefined, true), ctx("job-1"));
    expect(res.status).toBe(400);
  });

  it("400s when baseCaption is provided but empty", async () => {
    const res = await PATCH(req({ baseCaption: "   " }), ctx("job-1"));
    expect(res.status).toBe(400);
    expect(findFirstMock).not.toHaveBeenCalled();
  });

  it("404s when the job isn't the caller's", async () => {
    findFirstMock.mockResolvedValue(null);
    const res = await PATCH(req({ baseCaption: "new" }), ctx("job-1"));
    expect(res.status).toBe(404);
  });

  it("409s NOT_EDITABLE when the job isn't scheduled/draft", async () => {
    findFirstMock.mockResolvedValue({ status: "in_progress" });
    const res = await PATCH(req({ baseCaption: "new" }), ctx("job-1"));
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("NOT_EDITABLE");
    expect(updateManyMock).not.toHaveBeenCalled();
  });

  // R47 pages-a L4: the Queue's move-time shows this 400 word for word.
  it.each([
    ["", "Choose a date and time to schedule this post."],
    ["not-a-date", "We couldn't read the scheduled time. Choose the date and time again."],
    [
      new Date(Date.now() - 60_000).toISOString(),
      "The scheduled time has passed or is less than a minute away. Choose a later time and try again.",
    ],
  ])("moving a scheduled post to a refused time (%s) answers a plain sentence", async (scheduledFor, sentence) => {
    findFirstMock.mockResolvedValue({ status: "scheduled" });
    const res = await PATCH(req({ scheduledFor }), ctx("job-1"));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe(sentence);
    expect(updateManyMock).not.toHaveBeenCalled();
  });

  it("400s NOT_SCHEDULED when trying to set scheduledFor on a draft", async () => {
    findFirstMock.mockResolvedValue({ status: "draft" });
    const res = await PATCH(req({ scheduledFor: FUTURE }), ctx("job-1"));
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("NOT_SCHEDULED");
  });

  it("edits a scheduled job's caption + time via an atomic owner/status-scoped update", async () => {
    findFirstMock.mockResolvedValue({ status: "scheduled" });

    const res = await PATCH(
      req({ baseCaption: "updated", scheduledFor: FUTURE }),
      ctx("job-1"),
    );

    expect(res.status).toBe(200);
    expect(updateManyMock).toHaveBeenCalledWith({
      where: { id: "job-1", workspaceId: "ws-1", status: { in: ["scheduled", "draft"] } },
      // The text and the time changed, so a client's approval of the old ones is withdrawn.
      data: { baseCaption: "updated", scheduledFor: new Date(FUTURE), clientApprovedAt: null },
    });
  });

  it("400s when there is nothing to update", async () => {
    findFirstMock.mockResolvedValue({ status: "draft" });
    const res = await PATCH(req({}), ctx("job-1"));
    expect(res.status).toBe(400);
    expect(updateManyMock).not.toHaveBeenCalled();
  });

  it("409s when the atomic write loses the race (count 0)", async () => {
    findFirstMock.mockResolvedValue({ status: "scheduled" });
    updateManyMock.mockResolvedValue({ count: 0 });
    const res = await PATCH(req({ baseCaption: "x" }), ctx("job-1"));
    expect(res.status).toBe(409);
  });

  // R30 publishing L1: the 409 says what happened to the post and to check Activity.
  it.each([
    ["in_progress", "This post has started publishing, so it can't be edited. Check Activity to see how it goes."],
    ["completed", "This post has already gone out, so it can't be edited. Check Activity to see it."],
    ["failed", "This post failed, so it can't be edited. Check Activity for what to do next."],
  ])("a %s post: the 409 says so", async (status, sentence) => {
    findFirstMock.mockResolvedValue({ status });
    const res = await PATCH(req({ baseCaption: "new" }), ctx("job-1"));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "NOT_EDITABLE", error: sentence });
  });

  it("a race the scanner won: the post is read again and the 409 says it started publishing", async () => {
    findFirstMock.mockResolvedValueOnce({ status: "scheduled" }).mockResolvedValue({ status: "in_progress" });
    updateManyMock.mockResolvedValue({ count: 0 });
    const res = await PATCH(req({ baseCaption: "x" }), ctx("job-1"));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe(
      "This post has started publishing, so it can't be edited. Check Activity to see how it goes.",
    );
  });

  // R59 publishing-flow L4: the write is pinned to the status, so an owner
  // scheduling the draft meanwhile makes it miss while the post can still be edited.
  it("a race on a post still a draft or scheduled: it changed in the meantime, try again", async () => {
    for (const status of ["draft", "scheduled"]) {
      findFirstMock.mockResolvedValue({ status });
      updateManyMock.mockResolvedValue({ count: 0 });
      const res = await PATCH(req({ baseCaption: "x" }), ctx("job-1"));
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: "This post changed in the meantime. Try again.", code: "POST_CHANGED" });
    }
  });

  it("a race on a post deleted by the re-read: it says so, as before", async () => {
    findFirstMock.mockResolvedValueOnce({ status: "draft" }).mockResolvedValue(null);
    updateManyMock.mockResolvedValue({ count: 0 });
    const res = await PATCH(req({ baseCaption: "x" }), ctx("job-1"));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "This post no longer exists.", code: "NOT_EDITABLE" });
  });

  it("a draft is still edited as before", async () => {
    findFirstMock.mockResolvedValue({ status: "draft" });
    updateManyMock.mockResolvedValue({ count: 1 });
    const res = await PATCH(req({ baseCaption: "x" }), ctx("job-1"));
    expect(res.status).toBe(200);
  });

  it("cross-workspace isolation: a job in another workspace 404s (the ownership read is workspace-scoped, not user-scoped)", async () => {
    findFirstMock.mockResolvedValue(null); // ws-1's WHERE wouldn't match a ws-2 job
    const res = await PATCH(req({ baseCaption: "x" }), ctx("foreign-job"));
    expect(res.status).toBe(404);
    expect(findFirstMock).toHaveBeenCalledWith({
      where: { id: "foreign-job", workspaceId: "ws-1" },
      select: {
        status: true,
        // Usage limits: whether a reschedule moves the post to another UTC day.
        scheduledFor: true,
        submittedForApprovalAt: true,
        approvedAt: true,
        baseCaption: true,
        // 2026-11-01 audit (M1): everything resolvePlatformCaptions reads.
        perPlatformOverrides: true,
        publishMetadata: true,
        mediaItem: { select: { baseCaption: true, perPlatformOverrides: true } },
        // R3-client-journey M1: where a Feed and Story card finds its other half.
        storyOfPostJobId: true,
        // R56 client-journey-2 L1: whether the edit withdraws a client approval.
        clientApprovedAt: true,
      },
    });
  });
});

describe("PATCH /api/posts/[postJobId] — approval enforcement (2026-11-01 audit)", () => {
  const SUBMITTED = new Date("2026-11-01T09:00:00Z");

  /** The ownership/approval read's row. */
  function existingRow(overrides: Record<string, unknown> = {}) {
    return {
      status: "draft",
      submittedForApprovalAt: null,
      approvedAt: null,
      baseCaption: "Original caption",
      ...overrides,
    };
  }

  beforeEach(() => {
    getWorkspaceContextMock.mockResolvedValue(
      makeWorkspaceContext({
        userId: "member-1",
        email: "sam@example.com",
        name: "Sam",
        role: "member",
        requireApproval: true,
      }),
    );
  });

  it("bypass (c): a member editing an APPROVED scheduled post re-holds it in the same conditional write", async () => {
    findFirstMock.mockResolvedValue(
      existingRow({ status: "scheduled", submittedForApprovalAt: SUBMITTED, approvedAt: SUBMITTED }),
    );

    const res = await PATCH(req({ baseCaption: "Unreviewed text" }), ctx("job-1"));

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true, status: "draft", approvalState: "pending" });
    expect(updateManyMock).toHaveBeenCalledTimes(1);
    expect(updateManyMock).toHaveBeenCalledWith({
      where: { id: "job-1", workspaceId: "ws-1", status: "scheduled" },
      data: {
        baseCaption: "Unreviewed text",
        status: "draft",
        submittedForApprovalAt: expect.any(Date),
        approvedAt: null,
        approvedByUserId: null,
        clientApprovedAt: null,
      },
    });
  });

  it("emails the owners with the EDITED caption when it re-holds", async () => {
    findFirstMock.mockResolvedValue(
      existingRow({ status: "scheduled", submittedForApprovalAt: SUBMITTED, approvedAt: SUBMITTED }),
    );

    await PATCH(req({ baseCaption: "Unreviewed text" }), ctx("job-1"));

    expect(notifyOwnersMock).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      workspaceName: "Acme",
      submitter: expect.objectContaining({ id: "member-1", name: "Sam" }),
      caption: "Unreviewed text",
      platformCaptions: null,
    });
  });

  // 2026-11-01 audit (M1): the case the finding names - a member re-holds a
  // post by editing its overrides, and the owners must see the NEW texts.
  it("emails the owners the per-platform captions the post will publish with", async () => {
    findFirstMock.mockResolvedValue(
      existingRow({
        status: "scheduled",
        perPlatformOverrides: { linkedin: "Old text" },
        publishMetadata: { targetPlatforms: ["linkedin"] },
      }),
    );

    await PATCH(req({ perPlatformOverrides: { linkedin: "Edited hidden text", x: "Not targeted" } }), ctx("job-1"));

    expect(notifyOwnersMock).toHaveBeenCalledWith(
      expect.objectContaining({
        caption: "Original caption",
        platformCaptions: { linkedin: "Edited hidden text" },
      }),
    );
  });

  it("emails the stored per-platform captions when the edit leaves them alone", async () => {
    findFirstMock.mockResolvedValue(
      existingRow({ status: "scheduled", perPlatformOverrides: { linkedin: "Stored text" } }),
    );

    await PATCH(req({ baseCaption: "Only the base changed" }), ctx("job-1"));

    expect(notifyOwnersMock).toHaveBeenCalledWith(
      expect.objectContaining({
        caption: "Only the base changed",
        platformCaptions: { linkedin: "Stored text" },
      }),
    );
  });

  // 2026-11-10 (Stories): a Story publishes no caption, so none is shown as going there.
  it("lists a Story platform as 'Story, no caption' when it re-holds, even over its own override", async () => {
    findFirstMock.mockResolvedValue(
      existingRow({
        status: "scheduled",
        perPlatformOverrides: { instagram: "IG text" },
        publishMetadata: { targetPlatforms: ["instagram"], instagram: { placement: "story" } },
      }),
    );

    await PATCH(req({ baseCaption: "Edited" }), ctx("job-1"));

    expect(notifyOwnersMock).toHaveBeenCalledWith(
      expect.objectContaining({ platformCaptions: { instagram: "Story, no caption" } }),
    );
  });

  it("a feed post's re-hold email keeps the Instagram caption", async () => {
    findFirstMock.mockResolvedValue(
      existingRow({
        status: "scheduled",
        perPlatformOverrides: { instagram: "IG text" },
        publishMetadata: { targetPlatforms: ["instagram"] },
      }),
    );

    await PATCH(req({ baseCaption: "Edited" }), ctx("job-1"));

    expect(notifyOwnersMock).toHaveBeenCalledWith(
      expect.objectContaining({ platformCaptions: { instagram: "IG text" } }),
    );
  });

  it("emails no per-platform captions when the edit clears the overrides", async () => {
    findFirstMock.mockResolvedValue(
      existingRow({ status: "scheduled", perPlatformOverrides: { linkedin: "Stored text" } }),
    );

    await PATCH(req({ perPlatformOverrides: null }), ctx("job-1"));

    expect(notifyOwnersMock).toHaveBeenCalledWith(
      expect.objectContaining({ platformCaptions: null }),
    );
  });

  it("re-holds a reschedule too, keeping the new time on the held draft", async () => {
    findFirstMock.mockResolvedValue(existingRow({ status: "scheduled" }));

    const res = await PATCH(req({ scheduledFor: FUTURE }), ctx("job-1"));

    expect(res.status).toBe(200);
    expect(updateManyMock).toHaveBeenCalledWith({
      where: { id: "job-1", workspaceId: "ws-1", status: "scheduled" },
      data: expect.objectContaining({ scheduledFor: new Date(FUTURE), status: "draft" }),
    });
    // Unchanged caption → the existing one is quoted to the owners.
    expect(notifyOwnersMock).toHaveBeenCalledWith(
      expect.objectContaining({ caption: "Original caption" }),
    );
  });

  it("editing a PENDING post keeps it pending and refreshes its submission time (no new email)", async () => {
    findFirstMock.mockResolvedValue(existingRow({ submittedForApprovalAt: SUBMITTED }));

    const res = await PATCH(req({ baseCaption: "Fixed typo" }), ctx("job-1"));

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true, status: "draft", approvalState: "pending" });
    expect(updateManyMock).toHaveBeenCalledWith({
      where: { id: "job-1", workspaceId: "ws-1", status: "draft" },
      data: { baseCaption: "Fixed typo", submittedForApprovalAt: expect.any(Date), clientApprovedAt: null },
    });
    expect(notifyOwnersMock).not.toHaveBeenCalled();
  });

  it("a member's plain draft edits exactly as before", async () => {
    findFirstMock.mockResolvedValue(existingRow());

    const res = await PATCH(req({ baseCaption: "Draft text" }), ctx("job-1"));

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true });
    expect(updateManyMock).toHaveBeenCalledWith(
      expect.objectContaining({ data: { baseCaption: "Draft text", clientApprovedAt: null } }),
    );
    expect(notifyOwnersMock).not.toHaveBeenCalled();
  });

  it("409s and notifies nobody when the re-hold loses a race (e.g. the cron claimed it)", async () => {
    findFirstMock.mockResolvedValue(existingRow({ status: "scheduled", approvedAt: SUBMITTED }));
    updateManyMock.mockResolvedValue({ count: 0 });

    const res = await PATCH(req({ baseCaption: "x" }), ctx("job-1"));

    expect(res.status).toBe(409);
    expect(notifyOwnersMock).not.toHaveBeenCalled();
  });

  it("owners are never affected — an owner's edit of an approved scheduled post stays scheduled", async () => {
    getWorkspaceContextMock.mockResolvedValue(
      makeWorkspaceContext({ role: "owner", requireApproval: true }),
    );
    findFirstMock.mockResolvedValue(
      existingRow({ status: "scheduled", submittedForApprovalAt: SUBMITTED, approvedAt: SUBMITTED }),
    );

    const res = await PATCH(req({ baseCaption: "Owner tweak" }), ctx("job-1"));

    await expect(res.json()).resolves.toEqual({ ok: true });
    expect(updateManyMock).toHaveBeenCalledWith({
      where: { id: "job-1", workspaceId: "ws-1", status: { in: ["scheduled", "draft"] } },
      data: { baseCaption: "Owner tweak", clientApprovedAt: null },
    });
    expect(notifyOwnersMock).not.toHaveBeenCalled();
  });

  it("members edit scheduled posts freely when the workspace doesn't require approval", async () => {
    getWorkspaceContextMock.mockResolvedValue(
      makeWorkspaceContext({ role: "member", requireApproval: false }),
    );
    findFirstMock.mockResolvedValue(existingRow({ status: "scheduled" }));

    const res = await PATCH(req({ baseCaption: "x" }), ctx("job-1"));

    await expect(res.json()).resolves.toEqual({ ok: true });
    expect(updateManyMock).toHaveBeenCalledWith(
      expect.objectContaining({ data: { baseCaption: "x", clientApprovedAt: null } }),
    );
  });
});

describe("DELETE /api/posts/[postJobId]", () => {
  it("401s when unauthenticated", async () => {
    getWorkspaceContextMock.mockResolvedValue(null);
    const res = await DELETE(req({}), ctx("job-1"));
    expect(res.status).toBe(401);
  });

  it("deletes a draft/cancelled job via an atomic owner/status-scoped delete", async () => {
    const res = await DELETE(req({}), ctx("job-1"));
    expect(res.status).toBe(200);
    expect(deleteManyMock).toHaveBeenCalledWith({
      where: { id: "job-1", workspaceId: "ws-1", status: { in: ["draft", "cancelled"] } },
    });
  });

  it("queues a deleted post's cover file (V1 fix round 1); a post without one queues nothing", async () => {
    const COVER = "https://x.public.blob.vercel-storage.com/covers/ws-1/1-a-cover.jpg";
    queueCoverMock.mockReset();
    findFirstMock.mockResolvedValueOnce({ coverImageUrl: COVER });
    expect((await DELETE(req({}), ctx("job-1"))).status).toBe(200);
    expect(findFirstMock).toHaveBeenCalledWith({
      where: { id: "job-1", workspaceId: "ws-1" },
      select: { coverImageUrl: true, storyOfPostJobId: true },
    });
    expect(queueCoverMock).toHaveBeenCalledWith(COVER);

    queueCoverMock.mockReset();
    findFirstMock.mockResolvedValueOnce({ coverImageUrl: null });
    expect((await DELETE(req({}), ctx("job-1"))).status).toBe(200);
    expect(queueCoverMock).not.toHaveBeenCalled();
  });

  it("a cover that cannot be queued never fails the delete", async () => {
    findFirstMock.mockResolvedValueOnce({ coverImageUrl: "https://x.public.blob.vercel-storage.com/covers/ws-1/a.jpg" });
    queueCoverMock.mockRejectedValueOnce(new Error("db down"));
    expect((await DELETE(req({}), ctx("job-1"))).status).toBe(200);
  });

  it("404s when nothing matched and no such job exists", async () => {
    deleteManyMock.mockResolvedValue({ count: 0 });
    findFirstMock.mockResolvedValue(null);
    const res = await DELETE(req({}), ctx("job-1"));
    expect(res.status).toBe(404);
  });

  it("cross-workspace isolation: a job in another workspace 404s via the workspace-scoped disambiguation read", async () => {
    deleteManyMock.mockResolvedValue({ count: 0 });
    findFirstMock.mockResolvedValue(null); // ws-1's WHERE wouldn't match a ws-2 job
    const res = await DELETE(req({}), ctx("foreign-job"));
    expect(res.status).toBe(404);
    expect(deleteManyMock).toHaveBeenCalledWith({
      where: { id: "foreign-job", workspaceId: "ws-1", status: { in: ["draft", "cancelled"] } },
    });
    expect(findFirstMock).toHaveBeenCalledWith({
      where: { id: "foreign-job", workspaceId: "ws-1" },
      select: { status: true },
    });
  });

  it("409s NOT_DELETABLE when the job exists but is in a non-deletable state", async () => {
    deleteManyMock.mockResolvedValue({ count: 0 });
    findFirstMock.mockResolvedValue({ id: "job-1" }); // e.g. scheduled
    const res = await DELETE(req({}), ctx("job-1"));
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("NOT_DELETABLE");
  });
});

// 2026-11-01 scale audit (jobs, event size): the edit path stores the caption and the
// overrides a later publish event will carry, so it is capped like the create
// route (see POST /api/posts).
describe("PATCH /api/posts/[postJobId] — caption length cap and override keys (2026-11-01 scale audit)", () => {
  const OVER = "a".repeat(10_001);
  const AT_CAP = "a".repeat(10_000);

  function expectNothingRead() {
    expect(findFirstMock).not.toHaveBeenCalled();
    expect(updateManyMock).not.toHaveBeenCalled();
    expect(notifyOwnersMock).not.toHaveBeenCalled();
  }

  it("returns 400 CAPTION_TOO_LONG for a 10,001-character baseCaption, before any read or write", async () => {
    const res = await PATCH(req({ baseCaption: OVER }), ctx("job-1"));

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      code: "CAPTION_TOO_LONG",
      error: "Your caption is too long: keep it to 10,000 characters.",
    });
    expectNothingRead();
  });

  it("returns 400 CAPTION_TOO_LONG for a 10,001-character perPlatformOverrides.x, naming the field", async () => {
    const res = await PATCH(req({ perPlatformOverrides: { x: OVER } }), ctx("job-1"));

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      code: "CAPTION_TOO_LONG",
      error: "X's own caption is too long: keep it to 10,000 characters.",
    });
    expectNothingRead();
  });

  it("accepts a baseCaption and an override of exactly 10,000 characters", async () => {
    findFirstMock.mockResolvedValue({ status: "draft" });

    const res = await PATCH(
      req({ baseCaption: AT_CAP, perPlatformOverrides: { x: AT_CAP } }),
      ctx("job-1"),
    );

    expect(res.status).toBe(200);
    expect(updateManyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { baseCaption: AT_CAP, perPlatformOverrides: { x: AT_CAP }, clientApprovedAt: null },
      }),
    );
  });

  it("drops perPlatformOverrides keys that are not a platform before storing", async () => {
    findFirstMock.mockResolvedValue({ status: "draft" });

    const res = await PATCH(
      req({ perPlatformOverrides: { x: "hi", foo: "bar", legacy: OVER } }),
      ctx("job-1"),
    );

    expect(res.status).toBe(200);
    expect(updateManyMock).toHaveBeenCalledWith(
      expect.objectContaining({ data: { perPlatformOverrides: { x: "hi" }, clientApprovedAt: null } }),
    );
  });

  it("still clears the overrides on an explicit null", async () => {
    findFirstMock.mockResolvedValue({ status: "draft" });

    const res = await PATCH(req({ perPlatformOverrides: null }), ctx("job-1"));

    expect(res.status).toBe(200);
    expect(updateManyMock).toHaveBeenCalledWith(
      expect.objectContaining({ data: { perPlatformOverrides: Prisma.DbNull } }),
    );
  });
});

describe("PATCH /api/posts/[postJobId] — daily post limit (usage limits)", () => {
  const SCHEDULE_SENTENCE =
    "That day already has 20 posts, which is this workspace's daily limit. Pick another day.";
  // Two times on the same UTC day, and one on another, all in the future.
  const base = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
  const DAY_START = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate()));
  const SAME_DAY_A = new Date(DAY_START.getTime() + 2 * 60 * 60 * 1000);
  const SAME_DAY_B = new Date(DAY_START.getTime() + 20 * 60 * 60 * 1000);
  const OTHER_DAY = new Date(DAY_START.getTime() + 26 * 60 * 60 * 1000);

  it("moving a scheduled post to another UTC day checks that day, leaving the post itself out", async () => {
    findFirstMock.mockResolvedValue({ status: "scheduled", scheduledFor: SAME_DAY_A });

    const res = await PATCH(req({ scheduledFor: OTHER_DAY.toISOString() }), ctx("job-1"));

    expect(res.status).toBe(200);
    expect(checkDailyPostLimitMock).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      day: OTHER_DAY,
      mode: "schedule",
      excludePostJobId: "job-1",
      viewerUserId: expect.any(String),
    });
  });

  it("moving into a full day answers 429 with the sentence and code, and writes nothing", async () => {
    findFirstMock.mockResolvedValue({ status: "scheduled", scheduledFor: SAME_DAY_A });
    checkDailyPostLimitMock.mockResolvedValue({ error: SCHEDULE_SENTENCE, code: "WORKSPACE_DAILY_POST_LIMIT" });

    const res = await PATCH(req({ scheduledFor: OTHER_DAY.toISOString() }), ctx("job-1"));

    expect(res.status).toBe(429);
    await expect(res.json()).resolves.toEqual({ error: SCHEDULE_SENTENCE, code: "WORKSPACE_DAILY_POST_LIMIT" });
    expect(updateManyMock).not.toHaveBeenCalled();
  });

  it("does not check a new time on the same UTC day", async () => {
    findFirstMock.mockResolvedValue({ status: "scheduled", scheduledFor: SAME_DAY_A });

    const res = await PATCH(req({ scheduledFor: SAME_DAY_B.toISOString() }), ctx("job-1"));

    expect(res.status).toBe(200);
    expect(checkDailyPostLimitMock).not.toHaveBeenCalled();
  });

  it("does not check an edit that leaves the time alone", async () => {
    findFirstMock.mockResolvedValue({ status: "scheduled", scheduledFor: SAME_DAY_A });

    const res = await PATCH(req({ baseCaption: "new text" }), ctx("job-1"));

    expect(res.status).toBe(200);
    expect(checkDailyPostLimitMock).not.toHaveBeenCalled();
  });

  it("does not check a member's edit that sends the post back for approval (it becomes a draft)", async () => {
    getWorkspaceContextMock.mockResolvedValue(makeWorkspaceContext({ role: "member", requireApproval: true }));
    findFirstMock.mockResolvedValue({
      status: "scheduled",
      scheduledFor: SAME_DAY_A,
      submittedForApprovalAt: new Date("2026-11-01T09:00:00Z"),
      approvedAt: new Date("2026-11-01T10:00:00Z"),
      baseCaption: "hi",
    });

    const res = await PATCH(req({ scheduledFor: OTHER_DAY.toISOString() }), ctx("job-1"));

    expect(res.status).toBe(200);
    expect(checkDailyPostLimitMock).not.toHaveBeenCalled();
  });
});

describe("PATCH /api/posts/[postJobId] — the client's approval (client review link)", () => {
  const AT = new Date(FUTURE);
  /** A scheduled post the client approved, as the ownership read selects it. */
  function approvedScheduled(overrides: Record<string, unknown> = {}) {
    return {
      status: "scheduled",
      scheduledFor: AT,
      submittedForApprovalAt: null,
      approvedAt: null,
      baseCaption: "Dawn patrol",
      perPlatformOverrides: { instagram: "IG text" },
      publishMetadata: { targetPlatforms: ["instagram", "x"] },
      mediaItem: { baseCaption: "media caption", perPlatformOverrides: null },
      ...overrides,
    };
  }
  const written = () => updateManyMock.mock.calls[0][0].data as Record<string, unknown>;

  it("withdraws it in the same update when the caption changes", async () => {
    findFirstMock.mockResolvedValue(approvedScheduled());
    expect((await PATCH(req({ baseCaption: "Sunset session" }), ctx("job-1"))).status).toBe(200);
    expect(updateManyMock).toHaveBeenCalledTimes(1);
    expect(written()).toEqual({ baseCaption: "Sunset session", clientApprovedAt: null });
  });

  // R56 client-journey-2 L1: the answer says so, so the Queue card drops its badge.
  const APPROVED_AT = new Date("2026-11-19T10:00:00.000Z");

  it("answers clientApprovedAt null when the edit withdrew it (text or time), and nothing else new", async () => {
    findFirstMock.mockResolvedValue(approvedScheduled({ clientApprovedAt: APPROVED_AT }));
    await expect((await PATCH(req({ baseCaption: "Sunset session" }), ctx("job-1"))).json()).resolves.toEqual({
      ok: true,
      clientApprovedAt: null,
    });
    findFirstMock.mockResolvedValue(approvedScheduled({ clientApprovedAt: APPROVED_AT }));
    const later = new Date(AT.getTime() + 60 * 60 * 1000).toISOString();
    await expect((await PATCH(req({ scheduledFor: later }), ctx("job-1"))).json()).resolves.toEqual({
      ok: true,
      clientApprovedAt: null,
    });
  });

  it("answers as before when the edit leaves the approved text and time", async () => {
    findFirstMock.mockResolvedValue(approvedScheduled({ clientApprovedAt: APPROVED_AT }));
    const res = await PATCH(
      req({ baseCaption: "Dawn patrol", scheduledFor: FUTURE, perPlatformOverrides: { instagram: "IG text" } }),
      ctx("job-1"),
    );
    await expect(res.json()).resolves.toEqual({ ok: true });
  });

  it("answers as before for a post with no client approval", async () => {
    findFirstMock.mockResolvedValue(approvedScheduled({ clientApprovedAt: null }));
    await expect((await PATCH(req({ baseCaption: "Sunset session" }), ctx("job-1"))).json()).resolves.toEqual({ ok: true });
  });

  it("withdraws it when a platform's own caption changes, is added or is removed", async () => {
    for (const overrides of [{ instagram: "New IG text" }, { instagram: "IG text", x: "X text" }, null]) {
      updateManyMock.mockClear();
      findFirstMock.mockResolvedValue(approvedScheduled());
      await PATCH(req({ perPlatformOverrides: overrides }), ctx("job-1"));
      expect(written().clientApprovedAt, JSON.stringify(overrides)).toBeNull();
    }
  });

  it("withdraws it when the time changes", async () => {
    findFirstMock.mockResolvedValue(approvedScheduled());
    const later = new Date(AT.getTime() + 60 * 60 * 1000).toISOString();
    await PATCH(req({ scheduledFor: later }), ctx("job-1"));
    expect(written()).toEqual({ scheduledFor: new Date(later), clientApprovedAt: null });
  });

  it("leaves it alone when the edit changes none of those (the Queue re-saving the same text and time)", async () => {
    findFirstMock.mockResolvedValue(approvedScheduled());
    await PATCH(
      req({ baseCaption: "Dawn patrol", scheduledFor: FUTURE, perPlatformOverrides: { instagram: "IG text" } }),
      ctx("job-1"),
    );
    expect(written()).not.toHaveProperty("clientApprovedAt");
  });

  it("ignores an override for a platform the post does not go to, as the publisher does", async () => {
    findFirstMock.mockResolvedValue(approvedScheduled());
    await PATCH(req({ perPlatformOverrides: { instagram: "IG text", linkedin: "Not a target" } }), ctx("job-1"));
    expect(written()).not.toHaveProperty("clientApprovedAt");
  });

  it("compares an older post's caption with the media item's, which is what it publishes", async () => {
    findFirstMock.mockResolvedValue(approvedScheduled({ baseCaption: null, perPlatformOverrides: null }));
    await PATCH(req({ baseCaption: "media caption" }), ctx("job-1"));
    expect(written()).not.toHaveProperty("clientApprovedAt");

    updateManyMock.mockClear();
    findFirstMock.mockResolvedValue(approvedScheduled({ baseCaption: null, perPlatformOverrides: null }));
    await PATCH(req({ baseCaption: "typed for this post" }), ctx("job-1"));
    expect(written().clientApprovedAt).toBeNull();
  });
});

// R3-client-journey M1: a Feed and Story post is one Queue card. With
// includePair the edit and the delete reach both halves in one transaction.
describe("PATCH and DELETE /api/posts/[postJobId] - a Feed and Story card", () => {
  const AT = new Date(FUTURE);
  const MOVED = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000);

  function feedRow(overrides: Record<string, unknown> = {}) {
    return {
      id: "job-1",
      storyOfPostJobId: null,
      status: "scheduled",
      scheduledFor: AT,
      submittedForApprovalAt: null,
      approvedAt: null,
      baseCaption: "Dawn patrol",
      perPlatformOverrides: null,
      publishMetadata: { targetPlatforms: ["instagram", "facebook_page"] },
      mediaItem: { baseCaption: "media caption", perPlatformOverrides: null },
      coverImageUrl: null,
      ...overrides,
    };
  }
  function storyRow(overrides: Record<string, unknown> = {}) {
    return feedRow({
      id: "story-1",
      storyOfPostJobId: "job-1",
      publishMetadata: { targetPlatforms: ["instagram"], instagram: { placement: "story" } },
      ...overrides,
    });
  }

  beforeEach(() => {
    transactionMock.mockReset();
    transactionMock.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(prisma));
  });

  it("a caption edit and a new time go to both halves, once each, in one transaction", async () => {
    findFirstMock.mockResolvedValueOnce(feedRow()).mockResolvedValueOnce(storyRow());

    const res = await PATCH(
      req({ baseCaption: "Sunset session", scheduledFor: MOVED.toISOString(), includePair: true }),
      ctx("job-1"),
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      ok: true,
      otherHalf: { id: "story-1", kind: "story", changed: true, note: "Its Story was changed too." },
    });
    expect(transactionMock).toHaveBeenCalledTimes(1);
    expect(updateManyMock.mock.calls).toEqual([
      [
        {
          where: { id: "job-1", workspaceId: "ws-1", status: { in: ["scheduled", "draft"] } },
          data: { baseCaption: "Sunset session", scheduledFor: MOVED, clientApprovedAt: null },
        },
      ],
      [
        {
          where: { id: "story-1", workspaceId: "ws-1", status: { in: ["scheduled", "draft"] } },
          data: { baseCaption: "Sunset session", scheduledFor: MOVED, clientApprovedAt: null },
        },
      ],
    ]);
  });

  it("a reschedule to another day counts the pair as two posts there, neither against itself", async () => {
    findFirstMock.mockResolvedValueOnce(feedRow()).mockResolvedValueOnce(storyRow());

    await PATCH(req({ scheduledFor: MOVED.toISOString(), includePair: true }), ctx("job-1"));

    expect(checkDailyPostLimitMock).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      day: MOVED,
      mode: "schedule",
      excludePostJobId: ["job-1", "story-1"],
      alsoOnDay: 1,
      viewerUserId: expect.any(String),
    });
  });

  it("a Story already published is left alone and named; the feed post is still edited", async () => {
    findFirstMock.mockResolvedValueOnce(feedRow()).mockResolvedValueOnce(storyRow({ status: "completed" }));

    const res = await PATCH(req({ baseCaption: "Sunset session", includePair: true }), ctx("job-1"));

    expect((await res.json()).otherHalf).toEqual({
      id: "story-1",
      kind: "story",
      changed: false,
      note: "Its Story was already published, so it was not changed.",
    });
    expect(updateManyMock).toHaveBeenCalledTimes(1);
  });

  it("a new time cannot go to a half that is a draft: it is left alone and named", async () => {
    findFirstMock.mockResolvedValueOnce(feedRow()).mockResolvedValueOnce(storyRow({ status: "draft" }));

    const res = await PATCH(req({ scheduledFor: MOVED.toISOString(), includePair: true }), ctx("job-1"));

    expect((await res.json()).otherHalf).toEqual({
      id: "story-1",
      kind: "story",
      changed: false,
      note: "Its Story is a draft, so it was not changed.",
    });
    expect(updateManyMock).toHaveBeenCalledTimes(1);
  });

  it("a member under approval re-holds both halves and the owners get ONE email that names the Story", async () => {
    getWorkspaceContextMock.mockResolvedValue(
      makeWorkspaceContext({ userId: "member-1", email: "sam@example.com", name: "Sam", role: "member", requireApproval: true }),
    );
    findFirstMock.mockResolvedValueOnce(feedRow()).mockResolvedValueOnce(storyRow());

    const res = await PATCH(req({ baseCaption: "Unreviewed", includePair: true }), ctx("job-1"));

    await expect(res.json()).resolves.toEqual({
      ok: true,
      status: "draft",
      approvalState: "pending",
      otherHalf: { id: "story-1", kind: "story", changed: true, note: "Its Story was changed too." },
    });
    expect(updateManyMock).toHaveBeenCalledTimes(2);
    expect(updateManyMock.mock.calls[1][0]).toEqual({
      where: { id: "story-1", workspaceId: "ws-1", status: "scheduled" },
      data: expect.objectContaining({ baseCaption: "Unreviewed", status: "draft", submittedForApprovalAt: expect.any(Date) }),
    });
    expect(notifyOwnersMock).toHaveBeenCalledTimes(1);
    expect(notifyOwnersMock).toHaveBeenCalledWith(expect.objectContaining({ alsoAsStory: ["instagram"] }));
  });

  // R4 lows, item 2: a Story publishes no caption, so it keeps its own
  // per-platform captions; only the main caption and the time go to it.
  it("the feed post's own LinkedIn caption is saved on the feed post only; the Story keeps its own", async () => {
    findFirstMock
      .mockResolvedValueOnce(feedRow({ perPlatformOverrides: { linkedin: "Feed LinkedIn" } }))
      .mockResolvedValueOnce(storyRow());

    const res = await PATCH(
      req({ baseCaption: "Sunset session", perPlatformOverrides: { linkedin: "Feed LinkedIn" }, includePair: true }),
      ctx("job-1"),
    );

    expect(res.status).toBe(200);
    expect(updateManyMock.mock.calls[0][0].data).toEqual(
      expect.objectContaining({ baseCaption: "Sunset session", perPlatformOverrides: { linkedin: "Feed LinkedIn" } }),
    );
    expect(updateManyMock.mock.calls[1][0].where.id).toBe("story-1");
    expect(updateManyMock.mock.calls[1][0].data).toEqual({ baseCaption: "Sunset session", clientApprovedAt: null });
  });

  it("an edit sent from the Story (an old tab) never puts the Story's captions on the feed post", async () => {
    findFirstMock
      .mockResolvedValueOnce(storyRow({ id: undefined }))
      .mockResolvedValueOnce({ ...feedRow({ perPlatformOverrides: { linkedin: "Feed LinkedIn" } }), updatedAt: new Date(), createdAt: new Date() });

    await PATCH(
      req({ baseCaption: "Sunset session", perPlatformOverrides: { instagram: "Story text" }, includePair: true }),
      ctx("story-1"),
    );

    expect(updateManyMock.mock.calls[1][0].where.id).toBe("job-1");
    expect(updateManyMock.mock.calls[1][0].data).not.toHaveProperty("perPlatformOverrides");
    expect(updateManyMock.mock.calls[1][0].data).toEqual(expect.objectContaining({ baseCaption: "Sunset session" }));
  });

  it("an edit of only the per-platform captions has nothing for the Story: it is not written or named", async () => {
    findFirstMock.mockResolvedValueOnce(feedRow()).mockResolvedValueOnce(storyRow());

    const res = await PATCH(req({ perPlatformOverrides: { linkedin: "Feed LinkedIn" }, includePair: true }), ctx("job-1"));

    await expect(res.json()).resolves.toEqual({ ok: true });
    expect(updateManyMock).toHaveBeenCalledTimes(1);
    expect(updateManyMock.mock.calls[0][0].where.id).toBe("job-1");
  });

  // R4 lows, item 3: the owners' email describes the feed post, whichever half the edit came from.
  it("a member's re-hold sent from the Story: the owners' email lists the feed post's platforms and texts, with the Story line", async () => {
    getWorkspaceContextMock.mockResolvedValue(
      makeWorkspaceContext({ userId: "member-1", email: "sam@example.com", name: "Sam", role: "member", requireApproval: true }),
    );
    findFirstMock
      .mockResolvedValueOnce(storyRow({ id: undefined }))
      .mockResolvedValueOnce({
        ...feedRow({ perPlatformOverrides: { facebook_page: "Feed Facebook" } }),
        updatedAt: new Date(),
        createdAt: new Date(),
      });

    const res = await PATCH(req({ baseCaption: "Unreviewed", includePair: true }), ctx("story-1"));

    expect(res.status).toBe(200);
    expect(notifyOwnersMock).toHaveBeenCalledTimes(1);
    expect(notifyOwnersMock).toHaveBeenCalledWith(
      expect.objectContaining({
        caption: "Unreviewed",
        platformCaptions: { facebook_page: "Feed Facebook" },
        alsoAsStory: ["instagram"],
      }),
    );
  });

  it("without includePair the edit is exactly as before: one write, no pair read", async () => {
    findFirstMock.mockResolvedValueOnce(feedRow());

    const res = await PATCH(req({ baseCaption: "Sunset session" }), ctx("job-1"));

    await expect(res.json()).resolves.toEqual({ ok: true });
    expect(findFirstMock).toHaveBeenCalledTimes(1);
    expect(updateManyMock).toHaveBeenCalledTimes(1);
    expect(transactionMock).not.toHaveBeenCalled();
  });

  it("deletes both drafts once each, in one transaction, and queues each one's cover", async () => {
    const COVER = "https://x.public.blob.vercel-storage.com/covers/ws-1/1-a-cover.jpg";
    queueCoverMock.mockReset();
    findFirstMock
      .mockResolvedValueOnce({ coverImageUrl: COVER, storyOfPostJobId: null })
      .mockResolvedValueOnce(storyRow({ status: "draft", coverImageUrl: COVER }));

    const res = await DELETE(req({ includePair: true }), ctx("job-1"));

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      ok: true,
      otherHalf: { id: "story-1", kind: "story", changed: true, note: "Its Story was deleted too." },
    });
    expect(transactionMock).toHaveBeenCalledTimes(1);
    expect(deleteManyMock.mock.calls).toEqual([
      [{ where: { id: "job-1", workspaceId: "ws-1", status: { in: ["draft", "cancelled"] } } }],
      [{ where: { id: "story-1", workspaceId: "ws-1", status: { in: ["draft", "cancelled"] } } }],
    ]);
    expect(queueCoverMock).toHaveBeenCalledTimes(2);
  });

  it("a scheduled other half is not deleted, and the answer says so", async () => {
    findFirstMock.mockResolvedValueOnce({ coverImageUrl: null, storyOfPostJobId: null }).mockResolvedValueOnce(storyRow());

    const res = await DELETE(req({ includePair: true }), ctx("job-1"));

    expect((await res.json()).otherHalf).toEqual({
      id: "story-1",
      kind: "story",
      changed: false,
      note: "Its Story is scheduled, so it was not deleted.",
    });
    expect(deleteManyMock).toHaveBeenCalledTimes(1);
  });

  it("an other half someone already deleted: the draft is deleted and nothing else is said", async () => {
    findFirstMock.mockResolvedValueOnce({ coverImageUrl: null, storyOfPostJobId: null }).mockResolvedValueOnce(null);

    const res = await DELETE(req({ includePair: true }), ctx("job-1"));

    await expect(res.json()).resolves.toEqual({ ok: true });
    expect(deleteManyMock).toHaveBeenCalledTimes(1);
  });
});

// R31 pages L2: a write from a page drawn for another workspace, or from a tab
// opened before the release (no id), acts on nothing.
// R62 review low 2: an edit can no more leave X an empty text than the post
// could be created so (lib/xTextRefusal.ts, shared with POST /api/posts).
describe("PATCH /api/posts/[postJobId]: an X text post edited down to mentions", () => {
  // R63 pages-a L1: the Edit dialog can't leave X out, so PATCH says what it can do.
  const X_EMPTY =
    "X removes @mentions from posts sent through its API, so this post would have no text for X. Add some words to the caption or to X's own caption. To post without X, cancel this post and create it again without X.";
  const textPost = {
    status: "scheduled",
    scheduledFor: new Date("2099-01-01T09:00:00.000Z"),
    submittedForApprovalAt: null,
    approvedAt: null,
    baseCaption: "Lessons cancelled today",
    perPlatformOverrides: null,
    publishMetadata: { targetPlatforms: ["x", "linkedin"] },
    mediaItem: null,
    storyOfPostJobId: null,
    clientApprovedAt: null,
  };

  it("refuses \"@surfshop @wavecafe\" with PATCH's own sentence and writes nothing", async () => {
    findFirstMock.mockResolvedValue(textPost);
    const res = await PATCH(req({ baseCaption: "@surfshop @wavecafe" }), ctx("job-1"));
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: X_EMPTY });
    expect(updateManyMock).not.toHaveBeenCalled();
  });

  it("refuses an X override cut to mentions only", async () => {
    findFirstMock.mockResolvedValue(textPost);
    const res = await PATCH(req({ perPlatformOverrides: { x: "@surfshop" } }), ctx("job-1"));
    expect(res.status).toBe(400);
    expect(updateManyMock).not.toHaveBeenCalled();
  });

  it("accepts an edit with words", async () => {
    findFirstMock.mockResolvedValue(textPost);
    updateManyMock.mockResolvedValue({ count: 1 });
    const res = await PATCH(req({ baseCaption: "Thanks @surfshop for the boards" }), ctx("job-1"));
    expect(res.status).toBe(200);
    expect(updateManyMock).toHaveBeenCalledTimes(1);
  });

  // R63 pages-a L1: a mentions-only post saved before the check, rescheduled from
  // Edit (which sends the caption on every save), is not refused.
  it("accepts a time-only edit of a stored mentions-only post, which sends the same caption", async () => {
    findFirstMock.mockResolvedValue({ ...textPost, baseCaption: "@surfshop @wavecafe" });
    updateManyMock.mockResolvedValue({ count: 1 });
    const res = await PATCH(
      req({ baseCaption: "@surfshop @wavecafe", scheduledFor: "2099-01-02T09:00:00.000Z" }),
      ctx("job-1"),
    );
    expect(res.status).toBe(200);
    expect(updateManyMock).toHaveBeenCalledTimes(1);
  });

  // R63 fix review: Edit sends the caption trimmed, so a stored trailing space
  // or newline is not a change.
  it.each([["a trailing space", "@surfshop @wavecafe "], ["a trailing newline", "@surfshop\n"]])(
    "accepts a time-only edit of a stored mentions-only caption with %s",
    async (_label, stored) => {
      findFirstMock.mockResolvedValue({ ...textPost, baseCaption: stored });
      updateManyMock.mockResolvedValue({ count: 1 });
      const res = await PATCH(
        req({ baseCaption: stored.trim(), scheduledFor: "2099-01-02T09:00:00.000Z" }),
        ctx("job-1"),
      );
      expect(res.status).toBe(200);
    },
  );

  it("accepts a time-only edit with no caption sent", async () => {
    findFirstMock.mockResolvedValue({ ...textPost, baseCaption: "@surfshop @wavecafe" });
    updateManyMock.mockResolvedValue({ count: 1 });
    const res = await PATCH(req({ scheduledFor: "2099-01-02T09:00:00.000Z" }), ctx("job-1"));
    expect(res.status).toBe(200);
  });

  it("accepts a caption change that leaves X's own stored text in place", async () => {
    findFirstMock.mockResolvedValue({ ...textPost, baseCaption: "@surfshop", perPlatformOverrides: { x: "@surfshop" } });
    updateManyMock.mockResolvedValue({ count: 1 });
    const res = await PATCH(req({ baseCaption: "@surfshop @wavecafe" }), ctx("job-1"));
    expect(res.status).toBe(200);
  });

  it("refuses a stored mentions-only post whose caption is changed to other mentions", async () => {
    findFirstMock.mockResolvedValue({ ...textPost, baseCaption: "@surfshop" });
    const res = await PATCH(req({ baseCaption: "@wavecafe" }), ctx("job-1"));
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: X_EMPTY });
  });

  it("accepts mentions only when the post does not go to X", async () => {
    findFirstMock.mockResolvedValue({ ...textPost, publishMetadata: { targetPlatforms: ["linkedin"] } });
    updateManyMock.mockResolvedValue({ count: 1 });
    const res = await PATCH(req({ baseCaption: "@surfshop @wavecafe" }), ctx("job-1"));
    expect(res.status).toBe(200);
  });

  it("leaves a post with a file as before", async () => {
    findFirstMock.mockResolvedValue({ ...textPost, mediaItem: { baseCaption: "x", perPlatformOverrides: null } });
    updateManyMock.mockResolvedValue({ count: 1 });
    const res = await PATCH(req({ baseCaption: "@surfshop @wavecafe" }), ctx("job-1"));
    expect(res.status).toBe(200);
  });
});

describe("PATCH /api/posts/[postJobId]: the page's workspace id", () => {
  it("an absent id is the 400 to reload the page, and no post is read", async () => {
    const res = await PATCH({ json: async () => ({ baseCaption: "New" }) } as unknown as NextRequest, ctx("job-1"));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "This page is out of date. Reload it, then try again.",
      code: "MISSING_WORKSPACE_ID",
    });
    expect(findFirstMock).not.toHaveBeenCalled();
  });

  it("another workspace's id is the 409 WORKSPACE_CHANGED, and no post is read", async () => {
    const res = await PATCH(req({ baseCaption: "New", workspaceId: "ws-2" }), ctx("job-1"));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: "You switched workspace in another tab. Reload this page, then try again.",
      code: "WORKSPACE_CHANGED",
    });
    expect(findFirstMock).not.toHaveBeenCalled();
  });
});

// R31 pages L2: a write from a page drawn for another workspace, or from a tab
// opened before the release (no id), acts on nothing.
describe("DELETE /api/posts/[postJobId]: the page's workspace id", () => {
  it("an absent id is the 400 to reload the page, and no post is read", async () => {
    const res = await DELETE({ json: async () => ({}) } as unknown as NextRequest, ctx("job-1"));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "This page is out of date. Reload it, then try again.",
      code: "MISSING_WORKSPACE_ID",
    });
    expect(findFirstMock).not.toHaveBeenCalled();
  });

  it("another workspace's id is the 409 WORKSPACE_CHANGED, and no post is read", async () => {
    const res = await DELETE(req({ workspaceId: "ws-2" }), ctx("job-1"));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: "You switched workspace in another tab. Reload this page, then try again.",
      code: "WORKSPACE_CHANGED",
    });
    expect(findFirstMock).not.toHaveBeenCalled();
  });
});

// R31 publishing L4 and L5: Edit, the drag and Delete on a post that moved on.
describe("PATCH and DELETE /api/posts/[postJobId]: a post that moved on", () => {
  it("PATCH, deleted: 404 with the sentence", async () => {
    findFirstMock.mockResolvedValue(null);
    const res = await PATCH(req({ baseCaption: "New" }), ctx("job-1"));
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ error: "This post no longer exists." });
  });

  it("PATCH with a time, on a post that became a draft: the 400 NOT_SCHEDULED says it is a draft now", async () => {
    findFirstMock.mockResolvedValue({ status: "draft" });
    const res = await PATCH(req({ scheduledFor: new Date(Date.now() + 3_600_000).toISOString() }), ctx("job-1"));
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      error: "This post is now a draft (a change was asked for, or it is waiting for approval).",
      code: "NOT_SCHEDULED",
    });
  });

  it("PATCH, a draft still editable: unchanged (its caption saves)", async () => {
    findFirstMock.mockResolvedValue({ status: "draft" });
    const res = await PATCH(req({ baseCaption: "New" }), ctx("job-1"));
    expect(res.status).toBe(200);
  });

  it.each([
    ["scheduled", "This post is scheduled now, so it can't be deleted. Cancel it first, then delete it."],
    ["in_progress", "This post has started publishing, so it can't be deleted. Check Activity to see how it goes."],
    ["completed", "This post has already gone out, so it can't be deleted. Check Activity to see it."],
  ])("DELETE, %s meanwhile: the sentence", async (status, error) => {
    deleteManyMock.mockResolvedValue({ count: 0 });
    findFirstMock.mockResolvedValue({ status });
    const res = await DELETE(req({}), ctx("job-1"));
    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toEqual({ error, code: "NOT_DELETABLE" });
  });

  it("DELETE, deleted already: 404 with the sentence", async () => {
    deleteManyMock.mockResolvedValue({ count: 0 });
    findFirstMock.mockResolvedValue(null);
    const res = await DELETE(req({}), ctx("job-1"));
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ error: "This post no longer exists." });
  });
});
