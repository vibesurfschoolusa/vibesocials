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
} = vi.hoisted(() => ({
  getWorkspaceContextMock: vi.fn(),
  findFirstMock: vi.fn(),
  updateManyMock: vi.fn(),
  deleteManyMock: vi.fn(),
  postJobResultFindManyMock: vi.fn(),
  notifyOwnersMock: vi.fn(),
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
  },
}));
vi.mock("@/server/notifications/approvalRequested", () => ({
  notifyOwnersOfApprovalRequest: notifyOwnersMock,
}));

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
function req(body: unknown, throwOnJson = false): NextRequest {
  return {
    json: async () => {
      if (throwOnJson) throw new Error("bad json");
      return body;
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
  getWorkspaceContextMock.mockResolvedValue(makeWorkspaceContext());
  notifyOwnersMock.mockResolvedValue(undefined);
  updateManyMock.mockResolvedValue({ count: 1 });
  deleteManyMock.mockResolvedValue({ count: 1 });
  postJobResultFindManyMock.mockResolvedValue([]);
});

describe("GET /api/posts/[postJobId]", () => {
  it("401s when unauthenticated", async () => {
    getWorkspaceContextMock.mockResolvedValue(null);
    const res = await GET(req(null), ctx("job-1"));
    expect(res.status).toBe(401);
    expect(findFirstMock).not.toHaveBeenCalled();
  });

  it("404s when the job isn't in the caller's active workspace", async () => {
    findFirstMock.mockResolvedValue(null);
    const res = await GET(req(null), ctx("job-1"));
    expect(res.status).toBe(404);
  });

  it("scopes the ownership read to workspaceId (not userId) — cross-workspace isolation", async () => {
    findFirstMock.mockResolvedValue(makeJobRow());

    await GET(req(null), ctx("job-1"));

    expect(findFirstMock).toHaveBeenCalledWith({
      where: { id: "job-1", workspaceId: "ws-1" },
    });
  });

  it("a job belonging to a DIFFERENT workspace 404s, not 403 (no existence oracle)", async () => {
    // The caller's active workspace is ws-1; simulate the real-DB outcome for
    // a job that actually lives in ws-2 — the where clause wouldn't match it,
    // so Prisma would return null, same as "doesn't exist".
    findFirstMock.mockResolvedValue(null);
    const res = await GET(req(null), ctx("foreign-job"));
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ error: "Not found" });
  });
});

describe("GET /api/posts/[postJobId] — response DTO projection (SEC-1)", () => {
  it("projects the job + results to the display DTO, dropping internal fields", async () => {
    const jobRow = makeJobRow();
    const resultRow = makeResultRow();
    findFirstMock.mockResolvedValue(jobRow);
    postJobResultFindManyMock.mockResolvedValue([resultRow]);

    const res = await GET(req(null), ctx("job-1"));
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

    const res = await GET(req(null), ctx("job-1"));
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

    const res = await GET(req(null), ctx("job-1"));
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
      data: { baseCaption: "updated", scheduledFor: new Date(FUTURE) },
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

  it("cross-workspace isolation: a job in another workspace 404s (the ownership read is workspace-scoped, not user-scoped)", async () => {
    findFirstMock.mockResolvedValue(null); // ws-1's WHERE wouldn't match a ws-2 job
    const res = await PATCH(req({ baseCaption: "x" }), ctx("foreign-job"));
    expect(res.status).toBe(404);
    expect(findFirstMock).toHaveBeenCalledWith({
      where: { id: "foreign-job", workspaceId: "ws-1" },
      select: {
        status: true,
        submittedForApprovalAt: true,
        approvedAt: true,
        baseCaption: true,
        // 2026-11-01 audit (M1): everything resolvePlatformCaptions reads.
        perPlatformOverrides: true,
        publishMetadata: true,
        mediaItem: { select: { baseCaption: true, perPlatformOverrides: true } },
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
      data: { baseCaption: "Fixed typo", submittedForApprovalAt: expect.any(Date) },
    });
    expect(notifyOwnersMock).not.toHaveBeenCalled();
  });

  it("a member's plain draft edits exactly as before", async () => {
    findFirstMock.mockResolvedValue(existingRow());

    const res = await PATCH(req({ baseCaption: "Draft text" }), ctx("job-1"));

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true });
    expect(updateManyMock).toHaveBeenCalledWith(
      expect.objectContaining({ data: { baseCaption: "Draft text" } }),
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
      data: { baseCaption: "Owner tweak" },
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
      expect.objectContaining({ data: { baseCaption: "x" } }),
    );
  });
});

describe("DELETE /api/posts/[postJobId]", () => {
  it("401s when unauthenticated", async () => {
    getWorkspaceContextMock.mockResolvedValue(null);
    const res = await DELETE(req(null), ctx("job-1"));
    expect(res.status).toBe(401);
  });

  it("deletes a draft/cancelled job via an atomic owner/status-scoped delete", async () => {
    const res = await DELETE(req(null), ctx("job-1"));
    expect(res.status).toBe(200);
    expect(deleteManyMock).toHaveBeenCalledWith({
      where: { id: "job-1", workspaceId: "ws-1", status: { in: ["draft", "cancelled"] } },
    });
  });

  it("404s when nothing matched and no such job exists", async () => {
    deleteManyMock.mockResolvedValue({ count: 0 });
    findFirstMock.mockResolvedValue(null);
    const res = await DELETE(req(null), ctx("job-1"));
    expect(res.status).toBe(404);
  });

  it("cross-workspace isolation: a job in another workspace 404s via the workspace-scoped disambiguation read", async () => {
    deleteManyMock.mockResolvedValue({ count: 0 });
    findFirstMock.mockResolvedValue(null); // ws-1's WHERE wouldn't match a ws-2 job
    const res = await DELETE(req(null), ctx("foreign-job"));
    expect(res.status).toBe(404);
    expect(deleteManyMock).toHaveBeenCalledWith({
      where: { id: "foreign-job", workspaceId: "ws-1", status: { in: ["draft", "cancelled"] } },
    });
    expect(findFirstMock).toHaveBeenCalledWith({
      where: { id: "foreign-job", workspaceId: "ws-1" },
      select: { id: true },
    });
  });

  it("409s NOT_DELETABLE when the job exists but is in a non-deletable state", async () => {
    deleteManyMock.mockResolvedValue({ count: 0 });
    findFirstMock.mockResolvedValue({ id: "job-1" }); // e.g. scheduled
    const res = await DELETE(req(null), ctx("job-1"));
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
      error: "baseCaption is too long (max 10,000 characters).",
    });
    expectNothingRead();
  });

  it("returns 400 CAPTION_TOO_LONG for a 10,001-character perPlatformOverrides.x, naming the field", async () => {
    const res = await PATCH(req({ perPlatformOverrides: { x: OVER } }), ctx("job-1"));

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      code: "CAPTION_TOO_LONG",
      error: "perPlatformOverrides.x is too long (max 10,000 characters).",
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
        data: { baseCaption: AT_CAP, perPlatformOverrides: { x: AT_CAP } },
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
      expect.objectContaining({ data: { perPlatformOverrides: { x: "hi" } } }),
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
