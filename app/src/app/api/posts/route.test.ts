import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { makeWorkspaceContext } from "../__test-helpers__/workspaceContextMock";

// vi.mock + vi.hoisted are hoisted above imports by vitest (mirrors
// settings/route.test.ts / media/[id]/route.test.ts). route.ts imports
// `@/lib/db`, `@/lib/workspace`, `@/lib/inngest`, `@/lib/rateLimit`, and
// `@/server/jobs/posting` at module scope, so all must be mocked (or
// selectively real, for `MediaItemUnavailableError` below) before route.ts is
// imported.
const {
  getWorkspaceContextMock,
  checkRateLimitMock,
  createPostJobOnlyMock,
  createPostJobForExistingMediaMock,
  postJobFindUniqueMock,
  postJobUpdateMock,
  postJobResultFindManyMock,
  inngestSendMock,
  notifyOwnersMock,
  failPendingMock,
} = vi.hoisted(() => ({
  getWorkspaceContextMock: vi.fn(),
  checkRateLimitMock: vi.fn(),
  createPostJobOnlyMock: vi.fn(),
  createPostJobForExistingMediaMock: vi.fn(),
  postJobFindUniqueMock: vi.fn(),
  postJobUpdateMock: vi.fn(),
  postJobResultFindManyMock: vi.fn(),
  inngestSendMock: vi.fn(),
  notifyOwnersMock: vi.fn(),
  failPendingMock: vi.fn(),
}));

// Team Workspaces (Task 4) — route.ts now resolves the caller via
// `getWorkspaceContext` instead of `getCurrentUser` (design doc §3/§4).
vi.mock("@/lib/workspace", () => ({
  getWorkspaceContext: getWorkspaceContextMock,
}));

vi.mock("@/lib/rateLimit", () => ({
  checkRateLimit: checkRateLimitMock,
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    postJob: { findUnique: postJobFindUniqueMock, update: postJobUpdateMock },
    postJobResult: { findMany: postJobResultFindManyMock },
  },
}));

vi.mock("@/lib/inngest", () => ({
  inngest: { send: inngestSendMock },
}));

// Keep the REAL MediaItemUnavailableError class (route.ts does
// `error instanceof MediaItemUnavailableError` in its catch block, so the
// mock must be the same class the test throws), only replacing the two
// functions this suite drives directly.
vi.mock("@/server/jobs/posting", async () => {
  const actual = await vi.importActual<typeof import("@/server/jobs/posting")>(
    "@/server/jobs/posting",
  );
  return {
    ...actual,
    createPostJobOnly: createPostJobOnlyMock,
    createPostJobForExistingMedia: createPostJobForExistingMediaMock,
  };
});

vi.mock("@/server/notifications/approvalRequested", () => ({
  notifyOwnersOfApprovalRequest: notifyOwnersMock,
}));

// Keep the REAL DISPATCH_FAILURE constant; only the DB-touching helper is mocked.
vi.mock("@/server/jobs/failPendingResults", async () => {
  const actual = await vi.importActual<typeof import("@/server/jobs/failPendingResults")>(
    "@/server/jobs/failPendingResults",
  );
  return { ...actual, failPendingPostJobResults: failPendingMock };
});

import { BLOB_URL_REJECTED_MESSAGE, MAX_BLOB_URL_LENGTH } from "@/lib/blobUrl";
import { PostTargetingError } from "@/lib/postTargets";
import { MediaItemUnavailableError } from "@/server/jobs/posting";
import { POST } from "./route";

/**
 * Since the 2026-11-01 audit (Task 8) a blobUrl body must carry an image/video
 * `mimeType`. Fixtures that don't care about media metadata get a valid one
 * here unless they set the key themselves (the Task 8 validation tests do, to
 * exercise missing / invalid values).
 */
function jsonRequest(body: unknown): Request {
  const isBlobBody =
    typeof body === "object" && body !== null && "blobUrl" in body && !("mimeType" in body);
  const withDefaults = isBlobBody ? { mimeType: "video/mp4", ...(body as object) } : body;
  return new Request("http://localhost/api/posts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(withDefaults),
  });
}

beforeEach(() => {
  // Hermetic: the blob-store pin reads these; tests that want it set them.
  vi.stubEnv("BLOB_READ_WRITE_TOKEN", "");
  vi.stubEnv("BLOB_STORE_ID", "");
  getWorkspaceContextMock.mockReset();
  checkRateLimitMock.mockReset();
  createPostJobOnlyMock.mockReset();
  createPostJobForExistingMediaMock.mockReset();
  postJobFindUniqueMock.mockReset();
  postJobResultFindManyMock.mockReset();
  inngestSendMock.mockReset();
  postJobUpdateMock.mockReset();
  postJobUpdateMock.mockResolvedValue({});

  getWorkspaceContextMock.mockResolvedValue(makeWorkspaceContext());
  checkRateLimitMock.mockResolvedValue({ allowed: true });
  // Full raw-row fixture (incl. userId/workspaceId/publishMetadata) — not
  // just the minimal `{ id, status }` — so that any test reaching the
  // response-composition line exercises the same shape a real Prisma
  // `findUnique` would return (the SEC-1 DTO-projection tests below rely on
  // this to make their negative assertions actually bite).
  postJobFindUniqueMock.mockResolvedValue({
    id: "job-1",
    userId: "user-1",
    workspaceId: "ws-1",
    mediaItemId: "media-1",
    status: "in_progress",
    scheduledFor: null,
    baseCaption: "hi",
    perPlatformOverrides: null,
    publishMetadata: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
  });
  postJobResultFindManyMock.mockResolvedValue([]);
  inngestSendMock.mockResolvedValue(undefined);
  notifyOwnersMock.mockReset();
  notifyOwnersMock.mockResolvedValue(undefined);
  failPendingMock.mockReset();
  failPendingMock.mockResolvedValue({ failedCount: 1, status: "failed" });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("POST /api/posts — rate limiting", () => {
  it("returns 429 with Retry-After and never creates a job when the limit is exceeded", async () => {
    checkRateLimitMock.mockResolvedValue({ allowed: false, retryAfterSeconds: 42 });

    const response = await POST(jsonRequest({ blobUrl: "https://test.public.blob.vercel-storage.com/x", baseCaption: "hi" }));

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("42");
    await expect(response.json()).resolves.toMatchObject({ retryAfterSeconds: 42 });
    expect(createPostJobOnlyMock).not.toHaveBeenCalled();
    expect(createPostJobForExistingMediaMock).not.toHaveBeenCalled();
  });

  it("checks the rate limit under the posts/publish route key, scoped to the user", async () => {
    createPostJobOnlyMock.mockResolvedValue({
      postJobId: "job-1",
      mediaItemId: "media-1",
      resultIds: [],
    });

    await POST(jsonRequest({ blobUrl: "https://test.public.blob.vercel-storage.com/x", baseCaption: "hi" }));

    expect(checkRateLimitMock).toHaveBeenCalledWith({
      userId: "user-1",
      route: "posts/publish",
      limit: expect.any(Number),
      windowMs: expect.any(Number),
    });
  });

  it("returns 401 (and never checks the rate limit) when unauthenticated", async () => {
    getWorkspaceContextMock.mockResolvedValue(null);

    const response = await POST(jsonRequest({ blobUrl: "https://test.public.blob.vercel-storage.com/x", baseCaption: "hi" }));

    expect(response.status).toBe(401);
    expect(checkRateLimitMock).not.toHaveBeenCalled();
  });
});

describe("POST /api/posts — blobUrl path (preserved behavior)", () => {
  it("still calls createPostJobOnly (not the reuse helper) and sends the publish event", async () => {
    createPostJobOnlyMock.mockResolvedValue({
      postJobId: "job-1",
      mediaItemId: "media-1",
      resultIds: ["r1"],
    });

    const response = await POST(
      jsonRequest({
        blobUrl: "https://test.public.blob.vercel-storage.com/vid.mp4",
        filename: "vid.mp4",
        mimeType: "video/mp4",
        sizeBytes: 123,
        baseCaption: "hello world",
        location: "Miami",
      }),
    );

    expect(response.status).toBe(200);
    expect(createPostJobOnlyMock).toHaveBeenCalledWith({
      userId: "user-1",
      // Team Workspaces (Task 5) — the request's ACTIVE workspace
      // (`makeWorkspaceContext()` default is "ws-1"), passed explicitly.
      workspaceId: "ws-1",
      media: {
        storageLocation: "https://test.public.blob.vercel-storage.com/vid.mp4",
        originalFilename: "vid.mp4",
        mimeType: "video/mp4",
        sizeBytes: 123,
      },
      baseCaption: "hello world",
      location: "Miami",
      perPlatformOverrides: undefined,
      // Roadmap Phase 5 additive params; default immediate path unchanged.
      intent: "immediate",
      scheduledFor: null,
    });
    expect(createPostJobForExistingMediaMock).not.toHaveBeenCalled();

    // 2026-11-01 scale audit (jobs H6 + H1): a stable event id (a duplicate send
    // of this job is dropped by Inngest), the request's workspace for the shared
    // concurrency key, and the Post-now priority flag.
    expect(inngestSendMock).toHaveBeenCalledWith({
      id: "publish-job-1",
      name: "post/publish.requested",
      data: expect.objectContaining({
        postJobId: "job-1",
        userId: "user-1",
        workspaceId: "ws-1",
        immediate: true,
        mediaItemId: "media-1",
        baseCaption: "hello world",
        location: "Miami",
      }),
    });
  });

  it("takes the event's workspaceId from the request's ACTIVE workspace, not from the user", async () => {
    getWorkspaceContextMock.mockResolvedValue(makeWorkspaceContext({ workspaceId: "ws-shared-9" }));
    createPostJobOnlyMock.mockResolvedValue({
      postJobId: "job-1",
      mediaItemId: "media-1",
      resultIds: ["r1"],
    });

    const response = await POST(
      jsonRequest({ blobUrl: "https://test.public.blob.vercel-storage.com/x", baseCaption: "hi" }),
    );

    expect(response.status).toBe(200);
    expect(inngestSendMock).toHaveBeenCalledTimes(1);
    const [event] = inngestSendMock.mock.calls[0] as [{ id: string; data: Record<string, unknown> }];
    expect(event.id).toBe("publish-job-1");
    expect(event.data.workspaceId).toBe("ws-shared-9");
    expect(event.data.immediate).toBe(true);
  });

  it("returns 400 when neither blobUrl nor mediaItemId is present", async () => {
    const response = await POST(jsonRequest({ baseCaption: "hi" }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "blobUrl or mediaItemId is required",
    });
    expect(createPostJobOnlyMock).not.toHaveBeenCalled();
  });

  it("returns 400 when blobUrl is not on an allowed storage host", async () => {
    const response = await POST(
      jsonRequest({
        blobUrl: "https://evil.example/ssrf.mp4",
        baseCaption: "hi",
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "Media URL is not from an allowed storage host.",
    });
    expect(createPostJobOnlyMock).not.toHaveBeenCalled();
  });

  it("returns 400 when baseCaption is missing, without creating a job", async () => {
    const response = await POST(jsonRequest({ blobUrl: "https://test.public.blob.vercel-storage.com/x" }));

    expect(response.status).toBe(400);
    expect(createPostJobOnlyMock).not.toHaveBeenCalled();
  });

  it("maps a NO_CONNECTIONS error to 400 with the NO_CONNECTIONS code", async () => {
    createPostJobOnlyMock.mockRejectedValue(new Error("NO_CONNECTIONS"));

    const response = await POST(jsonRequest({ blobUrl: "https://test.public.blob.vercel-storage.com/x", baseCaption: "hi" }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ code: "NO_CONNECTIONS" });
  });
});

describe("POST /api/posts — mediaItemId reuse path (Roadmap Phase 2)", () => {
  it("branches to createPostJobForExistingMedia when mediaItemId is present and blobUrl is not", async () => {
    createPostJobForExistingMediaMock.mockResolvedValue({
      postJobId: "job-2",
      mediaItemId: "media-9",
      resultIds: ["r1", "r2"],
    });

    const response = await POST(
      jsonRequest({ mediaItemId: "media-9", baseCaption: "reused caption", location: "LA" }),
    );

    expect(response.status).toBe(200);
    expect(createPostJobForExistingMediaMock).toHaveBeenCalledWith({
      userId: "user-1",
      // Team Workspaces (Task 5) — the request's ACTIVE workspace.
      workspaceId: "ws-1",
      mediaItemId: "media-9",
      baseCaption: "reused caption",
      perPlatformOverrides: undefined,
      location: "LA",
      // Roadmap Phase 5 additive params; default immediate reuse unchanged.
      intent: "immediate",
      scheduledFor: null,
    });
    expect(createPostJobOnlyMock).not.toHaveBeenCalled();

    expect(inngestSendMock).toHaveBeenCalledWith({
      id: "publish-job-2",
      name: "post/publish.requested",
      data: expect.objectContaining({
        postJobId: "job-2",
        workspaceId: "ws-1",
        immediate: true,
        mediaItemId: "media-9",
        baseCaption: "reused caption",
      }),
    });
  });

  it("prefers blobUrl over mediaItemId when a caller sends both", async () => {
    createPostJobOnlyMock.mockResolvedValue({
      postJobId: "job-1",
      mediaItemId: "media-1",
      resultIds: [],
    });

    await POST(
      jsonRequest({ blobUrl: "https://test.public.blob.vercel-storage.com/x", mediaItemId: "media-9", baseCaption: "hi" }),
    );

    expect(createPostJobOnlyMock).toHaveBeenCalled();
    expect(createPostJobForExistingMediaMock).not.toHaveBeenCalled();
  });

  it("maps MediaItemUnavailableError (NOT_FOUND) to a 404 with the error's code", async () => {
    createPostJobForExistingMediaMock.mockRejectedValue(
      new MediaItemUnavailableError("NOT_FOUND", "Media item not found."),
    );

    const response = await POST(
      jsonRequest({ mediaItemId: "missing", baseCaption: "hi" }),
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: "Media item not found.",
      code: "NOT_FOUND",
    });
  });

  it("maps MediaItemUnavailableError (MEDIA_DELETED) to a 404 with the error's code", async () => {
    createPostJobForExistingMediaMock.mockRejectedValue(
      new MediaItemUnavailableError(
        "MEDIA_DELETED",
        "This media has been deleted and can no longer be used.",
      ),
    );

    const response = await POST(
      jsonRequest({ mediaItemId: "media-1", baseCaption: "hi" }),
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ code: "MEDIA_DELETED" });
  });

  it("rejects an empty-string mediaItemId the same as a missing one (400)", async () => {
    const response = await POST(jsonRequest({ mediaItemId: "   ", baseCaption: "hi" }));

    expect(response.status).toBe(400);
    expect(createPostJobForExistingMediaMock).not.toHaveBeenCalled();
  });
});

describe("POST /api/posts — scheduling + drafts (Roadmap Phase 5)", () => {
  const FUTURE = new Date(Date.now() + 60 * 60 * 1000).toISOString();

  beforeEach(() => {
    createPostJobOnlyMock.mockResolvedValue({
      postJobId: "job-1",
      mediaItemId: "media-1",
      resultIds: [],
    });
  });

  it("immediate (no draft/scheduledFor): intent 'immediate' AND sends the publish event (preserved)", async () => {
    const response = await POST(
      jsonRequest({ blobUrl: "https://test.public.blob.vercel-storage.com/x", baseCaption: "hi" }),
    );

    expect(response.status).toBe(200);
    expect(createPostJobOnlyMock).toHaveBeenCalledWith(
      expect.objectContaining({ intent: "immediate", scheduledFor: null }),
    );
    expect(inngestSendMock).toHaveBeenCalledTimes(1);
  });

  it("draft: creates with intent 'draft' and sends NO event", async () => {
    const response = await POST(
      jsonRequest({ blobUrl: "https://test.public.blob.vercel-storage.com/x", baseCaption: "hi", draft: true }),
    );
    const body = (await response.json()) as { message?: string };

    expect(response.status).toBe(200);
    expect(createPostJobOnlyMock).toHaveBeenCalledWith(
      expect.objectContaining({ intent: "draft", scheduledFor: null }),
    );
    expect(inngestSendMock).not.toHaveBeenCalled();
    expect(body.message).toBe("Draft saved.");
  });

  it("scheduled: creates with intent 'scheduled' + the parsed Date and sends NO event", async () => {
    const response = await POST(
      jsonRequest({ blobUrl: "https://test.public.blob.vercel-storage.com/x", baseCaption: "hi", scheduledFor: FUTURE }),
    );
    const body = (await response.json()) as { message?: string };

    expect(response.status).toBe(200);
    expect(createPostJobOnlyMock).toHaveBeenCalledWith(
      expect.objectContaining({ intent: "scheduled", scheduledFor: new Date(FUTURE) }),
    );
    expect(inngestSendMock).not.toHaveBeenCalled();
    expect(body.message).toBe("Post scheduled.");
  });

  describe("approval workflow", () => {
    it("holds a member's scheduled post as a draft, preserving their time, and sends NO event", async () => {
      getWorkspaceContextMock.mockResolvedValue(
        makeWorkspaceContext({ role: "member", requireApproval: true }),
      );

      const response = await POST(
        jsonRequest({
          blobUrl: "https://test.public.blob.vercel-storage.com/x",
          baseCaption: "hi",
          scheduledFor: FUTURE,
        }),
      );
      const body = (await response.json()) as { message?: string; awaitingApproval?: boolean };

      expect(response.status).toBe(200);
      // Created as a draft — approval, not the schedule, releases it.
      expect(createPostJobOnlyMock).toHaveBeenCalledWith(
        expect.objectContaining({ intent: "draft" }),
      );
      expect(inngestSendMock).not.toHaveBeenCalled();
      // Submission stamped and the member's chosen time restored on the row.
      expect(postJobUpdateMock).toHaveBeenCalledWith({
        where: { id: "job-1" },
        data: {
          submittedForApprovalAt: expect.any(Date),
          scheduledFor: new Date(FUTURE),
        },
      });
      expect(body.awaitingApproval).toBe(true);
      expect(body.message).toContain("approval");
    });

    it("holds a member's immediate post too", async () => {
      getWorkspaceContextMock.mockResolvedValue(
        makeWorkspaceContext({ role: "member", requireApproval: true }),
      );

      await POST(
        jsonRequest({ blobUrl: "https://test.public.blob.vercel-storage.com/x", baseCaption: "hi" }),
      );

      expect(createPostJobOnlyMock).toHaveBeenCalledWith(
        expect.objectContaining({ intent: "draft" }),
      );
      expect(inngestSendMock).not.toHaveBeenCalled();
      // No chosen time to restore — only the submission stamp.
      expect(postJobUpdateMock).toHaveBeenCalledWith({
        where: { id: "job-1" },
        data: { submittedForApprovalAt: expect.any(Date) },
      });
    });

    it("never holds an OWNER's post — owners are the approvers", async () => {
      getWorkspaceContextMock.mockResolvedValue(
        makeWorkspaceContext({ role: "owner", requireApproval: true }),
      );

      await POST(
        jsonRequest({ blobUrl: "https://test.public.blob.vercel-storage.com/x", baseCaption: "hi" }),
      );

      expect(createPostJobOnlyMock).toHaveBeenCalledWith(
        expect.objectContaining({ intent: "immediate" }),
      );
      expect(inngestSendMock).toHaveBeenCalledTimes(1);
      expect(postJobUpdateMock).not.toHaveBeenCalled();
    });

    it("leaves a member's post alone when the workspace hasn't enabled approval", async () => {
      getWorkspaceContextMock.mockResolvedValue(
        makeWorkspaceContext({ role: "member", requireApproval: false }),
      );

      await POST(
        jsonRequest({ blobUrl: "https://test.public.blob.vercel-storage.com/x", baseCaption: "hi" }),
      );

      expect(createPostJobOnlyMock).toHaveBeenCalledWith(
        expect.objectContaining({ intent: "immediate" }),
      );
      expect(inngestSendMock).toHaveBeenCalledTimes(1);
      expect(postJobUpdateMock).not.toHaveBeenCalled();
    });

    it("emails the workspace owners when a member's post is held (2026-11-01 audit)", async () => {
      getWorkspaceContextMock.mockResolvedValue(
        makeWorkspaceContext({
          userId: "member-1",
          email: "sam@example.com",
          name: "Sam",
          role: "member",
          requireApproval: true,
        }),
      );

      await POST(
        jsonRequest({ blobUrl: "https://test.public.blob.vercel-storage.com/x", baseCaption: "Held caption" }),
      );

      expect(notifyOwnersMock).toHaveBeenCalledTimes(1);
      expect(notifyOwnersMock).toHaveBeenCalledWith({
        workspaceId: "ws-1",
        workspaceName: "Acme",
        submitter: expect.objectContaining({ id: "member-1", name: "Sam", email: "sam@example.com" }),
        caption: "Held caption",
        platformCaptions: null,
      });
      // Notified only once the hold is stamped on the row.
      expect(postJobUpdateMock.mock.invocationCallOrder[0]).toBeLessThan(
        notifyOwnersMock.mock.invocationCallOrder[0],
      );
    });

    // 2026-11-01 audit (M1): the owners must see the per-platform texts that
    // will publish behind an innocuous base caption.
    it("tells the owners the per-platform captions of the targeted platforms (2026-11-01 audit, M1)", async () => {
      getWorkspaceContextMock.mockResolvedValue(
        makeWorkspaceContext({ role: "member", requireApproval: true }),
      );

      await POST(
        jsonRequest({
          blobUrl: "https://test.public.blob.vercel-storage.com/x",
          baseCaption: "Happy Friday from the team!",
          perPlatformOverrides: { linkedin: "Hidden text", x: "Not targeted" },
          platforms: ["linkedin", "youtube"],
        }),
      );

      expect(notifyOwnersMock).toHaveBeenCalledWith(
        expect.objectContaining({
          caption: "Happy Friday from the team!",
          platformCaptions: { linkedin: "Hidden text" },
        }),
      );
    });

    it("tells the owners every override when the post targets all connections", async () => {
      getWorkspaceContextMock.mockResolvedValue(
        makeWorkspaceContext({ role: "member", requireApproval: true }),
      );

      await POST(
        jsonRequest({
          blobUrl: "https://test.public.blob.vercel-storage.com/x",
          baseCaption: "hi",
          perPlatformOverrides: { linkedin: "Hidden text", x: "X text" },
        }),
      );

      expect(notifyOwnersMock).toHaveBeenCalledWith(
        expect.objectContaining({ platformCaptions: { linkedin: "Hidden text", x: "X text" } }),
      );
    });

    it("notifies nobody for a post that isn't held", async () => {
      getWorkspaceContextMock.mockResolvedValue(
        makeWorkspaceContext({ role: "owner", requireApproval: true }),
      );

      await POST(
        jsonRequest({ blobUrl: "https://test.public.blob.vercel-storage.com/x", baseCaption: "hi" }),
      );

      expect(notifyOwnersMock).not.toHaveBeenCalled();
    });

    it("notifies nobody for a member's own draft (a draft isn't submitted)", async () => {
      getWorkspaceContextMock.mockResolvedValue(
        makeWorkspaceContext({ role: "member", requireApproval: true }),
      );

      await POST(
        jsonRequest({ blobUrl: "https://test.public.blob.vercel-storage.com/x", baseCaption: "hi", draft: true }),
      );

      expect(notifyOwnersMock).not.toHaveBeenCalled();
    });
  });

  describe("dispatch failure (2026-11-01 audit)", () => {
    it("503s DISPATCH_FAILED with the postJobId and fails the pending results when inngest.send throws", async () => {
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      inngestSendMock.mockRejectedValue(new Error("inngest unreachable"));

      const response = await POST(
        jsonRequest({ blobUrl: "https://test.public.blob.vercel-storage.com/x", baseCaption: "hi" }),
      );

      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toEqual({
        code: "DISPATCH_FAILED",
        error: "Couldn't start publishing. Please try again.",
        postJobId: "job-1",
      });
      expect(failPendingMock).toHaveBeenCalledWith("job-1", {
        errorCode: "DISPATCH_FAILED",
        errorMessage: "Couldn't start publishing. Please try again.",
      });
      consoleSpy.mockRestore();
    });

    it("does not touch results when the dispatch succeeds", async () => {
      const response = await POST(
        jsonRequest({ blobUrl: "https://test.public.blob.vercel-storage.com/x", baseCaption: "hi" }),
      );

      expect(response.status).toBe(200);
      expect(failPendingMock).not.toHaveBeenCalled();
    });
  });

  it("draft wins over a provided scheduledFor", async () => {
    await POST(
      jsonRequest({
        blobUrl: "https://test.public.blob.vercel-storage.com/x",
        baseCaption: "hi",
        draft: true,
        scheduledFor: FUTURE,
      }),
    );

    expect(createPostJobOnlyMock).toHaveBeenCalledWith(
      expect.objectContaining({ intent: "draft" }),
    );
  });

  it("rejects a past/invalid scheduledFor with 400 and creates nothing", async () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    const response = await POST(
      jsonRequest({ blobUrl: "https://test.public.blob.vercel-storage.com/x", baseCaption: "hi", scheduledFor: past }),
    );

    expect(response.status).toBe(400);
    expect(createPostJobOnlyMock).not.toHaveBeenCalled();
    expect(inngestSendMock).not.toHaveBeenCalled();
  });

  it("schedules the reuse path too (intent forwarded to createPostJobForExistingMedia)", async () => {
    createPostJobForExistingMediaMock.mockResolvedValue({
      postJobId: "job-2",
      mediaItemId: "media-9",
      resultIds: [],
    });

    await POST(
      jsonRequest({ mediaItemId: "media-9", baseCaption: "reuse", scheduledFor: FUTURE }),
    );

    expect(createPostJobForExistingMediaMock).toHaveBeenCalledWith(
      expect.objectContaining({ intent: "scheduled", scheduledFor: new Date(FUTURE) }),
    );
    expect(inngestSendMock).not.toHaveBeenCalled();
  });
});

describe("POST /api/posts — per-post privacy persistence + validation (review B1 / Minor #3)", () => {
  const FUTURE = new Date(Date.now() + 60 * 60 * 1000).toISOString();

  beforeEach(() => {
    createPostJobOnlyMock.mockResolvedValue({
      postJobId: "job-1",
      mediaItemId: "media-1",
      resultIds: [],
    });
  });

  it("forwards youtubeMetadata to the create helper for a SCHEDULED post (so B1 can persist it)", async () => {
    await POST(
      jsonRequest({
        blobUrl: "https://test.public.blob.vercel-storage.com/x",
        baseCaption: "hi",
        scheduledFor: FUTURE,
        youtubeMetadata: { privacyStatus: "private" },
      }),
    );

    expect(createPostJobOnlyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        intent: "scheduled",
        youtubeMetadata: { privacyStatus: "private" },
      }),
    );
  });

  it("sends the VALIDATED tiktokMetadata (not the raw body) in the immediate publish event", async () => {
    await POST(
      jsonRequest({
        blobUrl: "https://test.public.blob.vercel-storage.com/x",
        baseCaption: "hi",
        tiktokMetadata: {
          privacyLevel: "PUBLIC_TO_EVERYONE",
          disableComment: true,
          disableDuet: false,
          disableStitch: false,
          // an unknown extra field must be dropped by validation
          bogus: "x",
        },
      }),
    );

    expect(inngestSendMock).toHaveBeenCalledWith({
      id: "publish-job-1",
      name: "post/publish.requested",
      data: expect.objectContaining({
        tiktokMetadata: {
          privacyLevel: "PUBLIC_TO_EVERYONE",
          disableComment: true,
          disableDuet: false,
          disableStitch: false,
        },
      }),
    });
  });

  it("accepts tiktokMetadata WITHOUT a privacyLevel for a scheduled post and normalizes it to empty", async () => {
    // With no explicit `platforms` list the route can't tell whether TikTok is
    // a target (a scheduled post resolves its connections at run time), so a
    // privacy-less tiktokMetadata alone must not 400 here. An explicit list that
    // names TikTok does - see the Task 9 block below.
    await POST(
      jsonRequest({
        blobUrl: "https://test.public.blob.vercel-storage.com/x",
        baseCaption: "hi",
        scheduledFor: FUTURE,
        tiktokMetadata: { disableComment: true, disableDuet: false, disableStitch: false },
      }),
    );

    expect(createPostJobOnlyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        intent: "scheduled",
        tiktokMetadata: {
          privacyLevel: "",
          disableComment: true,
          disableDuet: false,
          disableStitch: false,
        },
      }),
    );
  });

  it("rejects a non-string tiktokMetadata.privacyLevel with 400 and creates nothing", async () => {
    const response = await POST(
      jsonRequest({
        blobUrl: "https://test.public.blob.vercel-storage.com/x",
        baseCaption: "hi",
        tiktokMetadata: { privacyLevel: 5 },
      }),
    );

    expect(response.status).toBe(400);
    expect(createPostJobOnlyMock).not.toHaveBeenCalled();
    expect(inngestSendMock).not.toHaveBeenCalled();
  });

  it("rejects a non-string-map perPlatformOverrides (array) with 400", async () => {
    const response = await POST(
      jsonRequest({
        blobUrl: "https://test.public.blob.vercel-storage.com/x",
        baseCaption: "hi",
        perPlatformOverrides: ["not", "a", "map"],
      }),
    );

    expect(response.status).toBe(400);
    expect(createPostJobOnlyMock).not.toHaveBeenCalled();
  });
});

describe("POST /api/posts — platform targeting validation (Task 7)", () => {
  beforeEach(() => {
    createPostJobOnlyMock.mockResolvedValue({
      postJobId: "job-1",
      mediaItemId: "media-1",
      resultIds: [],
    });
  });

  it("returns 400 when platforms is not an array", async () => {
    const response = await POST(
      jsonRequest({ blobUrl: "https://test.public.blob.vercel-storage.com/x", baseCaption: "hi", platforms: "youtube" }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "platforms must be an array of platform names",
    });
    expect(createPostJobOnlyMock).not.toHaveBeenCalled();
  });

  it("returns 400 mentioning the unknown platform name", async () => {
    const response = await POST(
      jsonRequest({
        blobUrl: "https://test.public.blob.vercel-storage.com/x",
        baseCaption: "hi",
        platforms: ["youtube", "myspace"],
      }),
    );

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error?: string };
    expect(body.error).toContain("myspace");
    expect(createPostJobOnlyMock).not.toHaveBeenCalled();
  });

  it("returns 400 'Select at least one platform.' for an empty array", async () => {
    const response = await POST(
      jsonRequest({ blobUrl: "https://test.public.blob.vercel-storage.com/x", baseCaption: "hi", platforms: [] }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "Select at least one platform.",
    });
    expect(createPostJobOnlyMock).not.toHaveBeenCalled();
  });

  it("dedupes repeated platform names before passing them to the create helper", async () => {
    await POST(
      jsonRequest({
        blobUrl: "https://test.public.blob.vercel-storage.com/x",
        baseCaption: "hi",
        platforms: ["youtube", "youtube"],
      }),
    );

    expect(createPostJobOnlyMock).toHaveBeenCalledWith(
      expect.objectContaining({ targetPlatforms: ["youtube"] }),
    );
  });

  it("passes targetPlatforms undefined to the create helper when platforms is absent", async () => {
    await POST(jsonRequest({ blobUrl: "https://test.public.blob.vercel-storage.com/x", baseCaption: "hi" }));

    expect(createPostJobOnlyMock).toHaveBeenCalledWith(
      expect.objectContaining({ targetPlatforms: undefined }),
    );
  });
});

describe("POST /api/posts — response DTO projection (SEC-1)", () => {
  beforeEach(() => {
    createPostJobOnlyMock.mockResolvedValue({
      postJobId: "job-1",
      mediaItemId: "media-1",
      resultIds: [],
    });
  });

  it("projects postJob + results to the display DTO, dropping internal fields", async () => {
    // Full raw-row fixtures (incl. userId/workspaceId/socialConnectionId/
    // publishMetadata) so the negative assertions below actually bite.
    const jobRow = {
      id: "job-1",
      userId: "user-1",
      workspaceId: "ws-1",
      mediaItemId: "media-1",
      status: "in_progress",
      scheduledFor: null,
      baseCaption: "hello world",
      perPlatformOverrides: null,
      publishMetadata: { youtube: { privacyStatus: "public" } },
      createdAt: new Date("2026-01-01T00:00:00Z"),
      updatedAt: new Date("2026-01-01T00:05:00Z"),
    };
    const resultRow = {
      id: "result-1",
      postJobId: "job-1",
      platform: "youtube",
      socialConnectionId: "conn-1",
      status: "pending",
      externalPostId: null,
      errorCode: null,
      errorMessage: null,
      createdAt: new Date("2026-01-01T00:00:01Z"),
      updatedAt: new Date("2026-01-01T00:00:01Z"),
    };
    postJobFindUniqueMock.mockResolvedValue(jobRow);
    postJobResultFindManyMock.mockResolvedValue([resultRow]);

    const response = await POST(
      jsonRequest({ blobUrl: "https://test.public.blob.vercel-storage.com/x", baseCaption: "hello world" }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.postJob).toEqual({
      id: "job-1",
      status: "in_progress",
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
        status: "pending",
        externalPostId: null,
        errorMessage: null,
      },
    ]);
    expect(body.message).toBe("Publishing in progress. Large videos may take a few minutes.");

    const raw = JSON.stringify(body);
    expect(raw).not.toContain("socialConnectionId");
    expect(raw).not.toContain("workspaceId");
    expect(raw).not.toContain('"userId"');
    expect(raw).not.toContain("publishMetadata");
    expect(raw).not.toContain("errorCode");
    expect(raw).not.toContain("updatedAt");
  });

  // Today's code (pre-DTO) queries postJob via findUnique and unconditionally
  // echoes it; a null result (the FK guarantees this can't happen in
  // practice right after creation, but findUnique's return type is
  // `PostJob | null`) still serialized `{ postJob: null, results: [],
  // message }` without a 500. This pins that same envelope now that the
  // response is DTO-projected — toPostJobDetailDto must never be called with
  // null.
  it("guards the theoretical null postJob (findUnique race): preserves the {postJob:null, results:[], message} envelope, no crash", async () => {
    postJobFindUniqueMock.mockResolvedValue(null);

    const response = await POST(jsonRequest({ blobUrl: "https://test.public.blob.vercel-storage.com/x", baseCaption: "hi" }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      postJob: null,
      results: [],
      message: "Publishing in progress. Large videos may take a few minutes.",
    });
  });
});

describe("POST /api/posts — malformed bodies (2026-11-01 audit, Task 8)", () => {
  it.each([
    ["null", "null"],
    ["an array", "[1,2]"],
    ["a number", "5"],
    ["a string", '"hi"'],
    ["syntactically invalid JSON", "{not json"],
  ])("returns 400 'Invalid JSON body' (not a 500) for a body of %s", async (_label, raw) => {
    const response = await POST(
      new Request("http://localhost/api/posts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: raw,
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Invalid JSON body" });
    expect(createPostJobOnlyMock).not.toHaveBeenCalled();
  });
});

describe("POST /api/posts — canonical blob URLs (2026-11-01 audit, M2)", () => {
  const U = "https://test.public.blob.vercel-storage.com/1700000000000-ab12cd34-vid.mp4";

  function body(blobUrl: string) {
    return { blobUrl, filename: "vid.mp4", mimeType: "video/mp4", sizeBytes: 123, baseCaption: "hello" };
  }

  beforeEach(() => {
    createPostJobOnlyMock.mockResolvedValue({
      postJobId: "job-1",
      mediaItemId: "media-1",
      resultIds: [],
    });
  });

  it.each([
    ["a query string", `${U}?x=1`],
    ["a fragment", `${U}#f`],
    ["embedded credentials", U.replace("https://", "https://user:pw@")],
    ["a non-default explicit port", U.replace(".com/", ".com:8443/")],
  ])("returns 400 with the allowed-host message and creates nothing for %s", async (_label, blobUrl) => {
    const response = await POST(jsonRequest(body(blobUrl)));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: BLOB_URL_REJECTED_MESSAGE });
    expect(createPostJobOnlyMock).not.toHaveBeenCalled();
  });

  it("returns 400 with the allowed-host message and creates nothing for a blobUrl longer than MAX_BLOB_URL_LENGTH", async () => {
    const response = await POST(jsonRequest(body(U + "a".repeat(MAX_BLOB_URL_LENGTH - U.length + 1))));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: BLOB_URL_REJECTED_MESSAGE });
    expect(createPostJobOnlyMock).not.toHaveBeenCalled();
  });

  it("still accepts a blobUrl of exactly MAX_BLOB_URL_LENGTH characters", async () => {
    const response = await POST(jsonRequest(body(U + "a".repeat(MAX_BLOB_URL_LENGTH - U.length))));

    expect(response.status).toBe(200);
    expect(createPostJobOnlyMock).toHaveBeenCalledTimes(1);
  });

  it("stores the trimmed canonical URL for a whitespace-padded blobUrl (this path used to store it untrimmed)", async () => {
    const response = await POST(jsonRequest(body(` ${U}\n`)));

    expect(response.status).toBe(200);
    expect(createPostJobOnlyMock).toHaveBeenCalledWith(
      expect.objectContaining({ media: expect.objectContaining({ storageLocation: U }) }),
    );
  });

  it("stores the lower-cased spelling for an upper-case host", async () => {
    const response = await POST(jsonRequest(body(U.replace("https://test.", "HTTPS://TEST."))));

    expect(response.status).toBe(200);
    expect(createPostJobOnlyMock).toHaveBeenCalledWith(
      expect.objectContaining({ media: expect.objectContaining({ storageLocation: U }) }),
    );
  });

  describe("own blob store pin (ruling R6)", () => {
    const FOREIGN = U.replace("https://test.", "https://zzz999.");

    it("rejects another store's Vercel Blob URL when the own store is known", async () => {
      vi.stubEnv("BLOB_READ_WRITE_TOKEN", "vercel_blob_rw_test_secretvalue");

      const response = await POST(jsonRequest(body(FOREIGN)));

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({ error: BLOB_URL_REJECTED_MESSAGE });
      expect(createPostJobOnlyMock).not.toHaveBeenCalled();
    });

    it("accepts an own-store URL in mixed case and stores it lower-cased", async () => {
      vi.stubEnv("BLOB_READ_WRITE_TOKEN", "vercel_blob_rw_test_secretvalue");

      const response = await POST(jsonRequest(body(U.replace("https://test.", "HTTPS://TeSt."))));

      expect(response.status).toBe(200);
      expect(createPostJobOnlyMock).toHaveBeenCalledWith(
        expect.objectContaining({ media: expect.objectContaining({ storageLocation: U }) }),
      );
    });

    it("accepts a foreign-store URL when no token or store id is configured (today's behaviour)", async () => {
      const response = await POST(jsonRequest(body(FOREIGN)));

      expect(response.status).toBe(200);
      expect(createPostJobOnlyMock).toHaveBeenCalledWith(
        expect.objectContaining({ media: expect.objectContaining({ storageLocation: FOREIGN }) }),
      );
    });
  });
});

describe("POST /api/posts — blobUrl media field validation (2026-11-01 audit, Task 8)", () => {
  const BLOB = "https://test.public.blob.vercel-storage.com/vid.mp4";

  function validBody(overrides: Record<string, unknown> = {}) {
    return {
      blobUrl: BLOB,
      filename: "vid.mp4",
      mimeType: "video/mp4",
      sizeBytes: 123,
      baseCaption: "hello",
      ...overrides,
    };
  }

  beforeEach(() => {
    createPostJobOnlyMock.mockResolvedValue({
      postJobId: "job-1",
      mediaItemId: "media-1",
      resultIds: [],
    });
  });

  it.each([
    ["sizeBytes is negative", { sizeBytes: -1 }, "sizeBytes"],
    ["sizeBytes is fractional", { sizeBytes: 1.5 }, "sizeBytes"],
    ["sizeBytes is a string", { sizeBytes: "123" }, "sizeBytes"],
    ["sizeBytes is not a safe integer", { sizeBytes: 2 ** 53 }, "sizeBytes"],
    ["sizeBytes is above the 512 MB cap", { sizeBytes: 600 * 1024 * 1024 }, "sizeBytes"],
    ["mimeType is missing", { mimeType: undefined }, "mimeType"],
    ["mimeType is empty", { mimeType: "" }, "mimeType"],
    ["mimeType is not image/* or video/*", { mimeType: "application/pdf" }, "mimeType"],
    ["mimeType is not a string", { mimeType: 7 }, "mimeType"],
    ["filename is not a string", { filename: 12 }, "filename"],
    ["filename is longer than 255 characters", { filename: "a".repeat(256) }, "filename"],
  ])("returns 400 and creates nothing when %s", async (_label, overrides, field) => {
    const response = await POST(jsonRequest(validBody(overrides)));
    const body = (await response.json()) as { error?: string };

    expect(response.status).toBe(400);
    expect(body.error).toContain(field);
    expect(createPostJobOnlyMock).not.toHaveBeenCalled();
    expect(inngestSendMock).not.toHaveBeenCalled();
  });

  it("accepts sizeBytes of 0, a 255-character filename and an image type, passing them through unchanged", async () => {
    const filename = "a".repeat(255);
    const response = await POST(
      jsonRequest(validBody({ sizeBytes: 0, filename, mimeType: "image/png" })),
    );

    expect(response.status).toBe(200);
    expect(createPostJobOnlyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        media: {
          storageLocation: BLOB,
          originalFilename: filename,
          mimeType: "image/png",
          sizeBytes: 0,
        },
      }),
    );
  });

  it("defaults an absent sizeBytes to 0 and an absent filename to 'upload'", async () => {
    const response = await POST(
      jsonRequest(validBody({ sizeBytes: undefined, filename: undefined })),
    );

    expect(response.status).toBe(200);
    expect(createPostJobOnlyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        media: expect.objectContaining({ originalFilename: "upload", sizeBytes: 0 }),
      }),
    );
  });

  it("does not validate media fields on the mediaItemId reuse path (they are ignored there)", async () => {
    createPostJobForExistingMediaMock.mockResolvedValue({
      postJobId: "job-1",
      mediaItemId: "media-9",
    });

    const response = await POST(
      jsonRequest({ mediaItemId: "media-9", baseCaption: "again", sizeBytes: -1, mimeType: 7 }),
    );

    expect(response.status).toBe(200);
    expect(createPostJobForExistingMediaMock).toHaveBeenCalled();
  });
});

describe("POST /api/posts - platform/media compatibility + TikTok privacy (2026-11-01 audit, Task 9)", () => {
  const BLOB = "https://test.public.blob.vercel-storage.com/x";
  const FUTURE = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const TIKTOK_WITH_PRIVACY = {
    privacyLevel: "SELF_ONLY",
    disableComment: true,
    disableDuet: true,
    disableStitch: true,
  };

  beforeEach(() => {
    createPostJobOnlyMock.mockResolvedValue({
      postJobId: "job-1",
      mediaItemId: "media-1",
      resultIds: [],
    });
    createPostJobForExistingMediaMock.mockResolvedValue({
      postJobId: "job-2",
      mediaItemId: "media-9",
      resultIds: [],
    });
  });

  describe("media compatibility of an explicit platforms list", () => {
    it("400s naming every requested platform that can't publish the media, creating nothing", async () => {
      const response = await POST(
        jsonRequest({
          blobUrl: BLOB,
          mimeType: "image/png",
          baseCaption: "hi",
          platforms: ["youtube", "x", "tiktok"],
          tiktokMetadata: TIKTOK_WITH_PRIVACY,
        }),
      );

      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: string; code: string; platforms: string[] };
      expect(body.code).toBe("PLATFORM_MEDIA_MISMATCH");
      expect(body.platforms).toEqual(["youtube", "tiktok"]);
      expect(body.error).toContain("YouTube");
      expect(body.error).toContain("TikTok");
      expect(createPostJobOnlyMock).not.toHaveBeenCalled();
      expect(inngestSendMock).not.toHaveBeenCalled();
    });

    it("400s a video sent to an images-only platform (Facebook Page)", async () => {
      const response = await POST(
        jsonRequest({ blobUrl: BLOB, mimeType: "video/mp4", baseCaption: "hi", platforms: ["facebook_page"] }),
      );

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        code: "PLATFORM_MEDIA_MISMATCH",
        platforms: ["facebook_page"],
      });
      expect(createPostJobOnlyMock).not.toHaveBeenCalled();
    });

    it("applies to scheduled and draft posts too", async () => {
      for (const extra of [{ draft: true }, { scheduledFor: FUTURE }]) {
        const response = await POST(
          jsonRequest({
            blobUrl: BLOB,
            mimeType: "image/png",
            baseCaption: "hi",
            platforms: ["youtube"],
            ...extra,
          }),
        );
        expect(response.status).toBe(400);
      }
      expect(createPostJobOnlyMock).not.toHaveBeenCalled();
    });

    it("lets a fully compatible list through", async () => {
      const response = await POST(
        jsonRequest({ blobUrl: BLOB, mimeType: "image/png", baseCaption: "hi", platforms: ["x", "facebook_page"] }),
      );

      expect(response.status).toBe(200);
      expect(createPostJobOnlyMock).toHaveBeenCalledWith(
        expect.objectContaining({ targetPlatforms: ["x", "facebook_page"] }),
      );
    });

    it("maps a PostTargetingError from the reuse path (stored mimeType) to the same 400", async () => {
      createPostJobForExistingMediaMock.mockRejectedValue(
        new PostTargetingError(
          "PLATFORM_MEDIA_MISMATCH",
          "These platforms can't publish a video: Facebook Page (images only).",
          ["facebook_page"],
        ),
      );

      const response = await POST(
        jsonRequest({ mediaItemId: "media-9", baseCaption: "hi", platforms: ["facebook_page"] }),
      );

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        error: "These platforms can't publish a video: Facebook Page (images only).",
        code: "PLATFORM_MEDIA_MISMATCH",
        platforms: ["facebook_page"],
      });
      expect(inngestSendMock).not.toHaveBeenCalled();
    });

    it("maps NO_COMPATIBLE_PLATFORMS (no explicit list; nothing connected can publish the media) to 400", async () => {
      createPostJobOnlyMock.mockRejectedValue(
        new PostTargetingError(
          "NO_COMPATIBLE_PLATFORMS",
          "None of your connected platforms can publish this type of media.",
          ["youtube"],
        ),
      );

      const response = await POST(jsonRequest({ blobUrl: BLOB, mimeType: "image/png", baseCaption: "hi" }));

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({ code: "NO_COMPATIBLE_PLATFORMS" });
    });

    it("sends no explicit list to the helper when none was sent (the helper skips incompatible connections)", async () => {
      await POST(jsonRequest({ blobUrl: BLOB, mimeType: "image/png", baseCaption: "hi" }));

      expect(createPostJobOnlyMock).toHaveBeenCalledWith(
        expect.objectContaining({ targetPlatforms: undefined }),
      );
    });
  });

  describe("TikTok privacy level is required whenever TikTok is a target (ruling R5)", () => {
    const intents: Array<[string, Record<string, unknown>]> = [
      ["immediate", {}],
      ["draft", { draft: true }],
      ["scheduled", { scheduledFor: FUTURE }],
    ];

    it.each(intents)("400s a %s post that targets TikTok without any tiktokMetadata", async (_name, extra) => {
      const response = await POST(
        jsonRequest({ blobUrl: BLOB, baseCaption: "hi", platforms: ["tiktok"], ...extra }),
      );

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        code: "TIKTOK_PRIVACY_REQUIRED",
        platforms: ["tiktok"],
      });
      expect(createPostJobOnlyMock).not.toHaveBeenCalled();
      expect(inngestSendMock).not.toHaveBeenCalled();
    });

    it.each(intents)("400s a %s post that targets TikTok with an empty privacyLevel", async (_name, extra) => {
      const response = await POST(
        jsonRequest({
          blobUrl: BLOB,
          baseCaption: "hi",
          platforms: ["youtube", "tiktok"],
          tiktokMetadata: { privacyLevel: "", disableComment: true },
          ...extra,
        }),
      );

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({ code: "TIKTOK_PRIVACY_REQUIRED" });
      expect(createPostJobOnlyMock).not.toHaveBeenCalled();
    });

    it("400s on the reuse path too", async () => {
      const response = await POST(
        jsonRequest({ mediaItemId: "media-9", baseCaption: "hi", platforms: ["tiktok"], draft: true }),
      );

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({ code: "TIKTOK_PRIVACY_REQUIRED" });
      expect(createPostJobForExistingMediaMock).not.toHaveBeenCalled();
    });

    it.each(intents)("accepts a %s TikTok post that carries an explicit privacy level", async (_name, extra) => {
      const response = await POST(
        jsonRequest({
          blobUrl: BLOB,
          baseCaption: "hi",
          platforms: ["tiktok"],
          tiktokMetadata: TIKTOK_WITH_PRIVACY,
          ...extra,
        }),
      );

      expect(response.status).toBe(200);
      expect(createPostJobOnlyMock).toHaveBeenCalledWith(
        expect.objectContaining({ tiktokMetadata: TIKTOK_WITH_PRIVACY }),
      );
    });

    it("does not ask for a TikTok privacy level when TikTok is not a target", async () => {
      const response = await POST(
        jsonRequest({ blobUrl: BLOB, baseCaption: "hi", platforms: ["youtube"], draft: true }),
      );

      expect(response.status).toBe(200);
    });

    it("maps the helper's TIKTOK_PRIVACY_REQUIRED (implicit TikTok target, no explicit list) to 400", async () => {
      createPostJobOnlyMock.mockRejectedValue(
        new PostTargetingError("TIKTOK_PRIVACY_REQUIRED", "tiktokMetadata.privacyLevel is required when posting to TikTok.", ["tiktok"]),
      );

      const response = await POST(jsonRequest({ blobUrl: BLOB, baseCaption: "hi" }));

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({ code: "TIKTOK_PRIVACY_REQUIRED" });
    });
  });
});

describe("POST /api/posts — workspace changed in another tab (2026-11-01 audit, M3)", () => {
  const BLOB = "https://test.public.blob.vercel-storage.com/vid.mp4";
  const MESSAGE = "You switched workspace in another tab. Reload this page before posting.";

  function blobBody(extra: Record<string, unknown> = {}) {
    return { blobUrl: BLOB, filename: "vid.mp4", mimeType: "video/mp4", sizeBytes: 123, baseCaption: "hello", ...extra };
  }

  beforeEach(() => {
    createPostJobOnlyMock.mockResolvedValue({ postJobId: "job-1", mediaItemId: "media-1", resultIds: [] });
    createPostJobForExistingMediaMock.mockResolvedValue({ postJobId: "job-1", mediaItemId: "media-1", resultIds: [] });
  });

  function expectNothingWritten() {
    expect(createPostJobOnlyMock).not.toHaveBeenCalled();
    expect(createPostJobForExistingMediaMock).not.toHaveBeenCalled();
    expect(postJobUpdateMock).not.toHaveBeenCalled();
    expect(notifyOwnersMock).not.toHaveBeenCalled();
    expect(failPendingMock).not.toHaveBeenCalled();
    expect(inngestSendMock).not.toHaveBeenCalled();
  }

  it("the stale-tab scenario: the page rendered W2 (member, approval on) but the cookie now says W1 (owner) — 409, nothing published", async () => {
    // The cookie now resolves the user as OWNER of ws-1 (approval off): without
    // the check this body would publish immediately onto ws-1's accounts.
    getWorkspaceContextMock.mockResolvedValue(
      makeWorkspaceContext({ workspaceId: "ws-1", role: "owner", requireApproval: false }),
    );

    const response = await POST(jsonRequest(blobBody({ workspaceId: "ws-2" })));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: MESSAGE, code: "WORKSPACE_CHANGED" });
    expectNothingWritten();
  });

  it("409s on the mediaItemId reuse path too, writing nothing", async () => {
    const response = await POST(
      jsonRequest({ mediaItemId: "media-9", baseCaption: "hello", workspaceId: "ws-2" }),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ code: "WORKSPACE_CHANGED" });
    expectNothingWritten();
  });

  it("409s for a draft and a scheduled post as well (every intent creates a row)", async () => {
    for (const extra of [{ draft: true }, { scheduledFor: "2099-01-01T00:00:00.000Z" }]) {
      const response = await POST(jsonRequest(blobBody({ workspaceId: "ws-2", ...extra })));
      expect(response.status).toBe(409);
    }
    expectNothingWritten();
  });

  it("checks the workspace before any other body validation (a stale tab hears about the switch, not a stray 400)", async () => {
    const noMedia = await POST(jsonRequest({ baseCaption: "hello", workspaceId: "ws-2" }));
    expect(noMedia.status).toBe(409);

    const badBlob = await POST(
      jsonRequest(blobBody({ blobUrl: "https://evil.example.com/x.mp4", workspaceId: "ws-2" })),
    );
    expect(badBlob.status).toBe(409);

    const noCaption = await POST(jsonRequest(blobBody({ baseCaption: "", workspaceId: "ws-2" })));
    expect(noCaption.status).toBe(409);
    expectNothingWritten();
  });

  it("an empty-string workspaceId is a mismatch, not 'absent'", async () => {
    const response = await POST(jsonRequest(blobBody({ workspaceId: "" })));

    expect(response.status).toBe(409);
    expectNothingWritten();
  });

  it("proceeds when workspaceId matches the active workspace, creating the job in it", async () => {
    const response = await POST(jsonRequest(blobBody({ workspaceId: "ws-1" })));

    expect(response.status).toBe(200);
    expect(createPostJobOnlyMock).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: "ws-1" }));
    expect(inngestSendMock).toHaveBeenCalledTimes(1);
  });

  it("proceeds on the reuse path when workspaceId matches", async () => {
    const response = await POST(
      jsonRequest({ mediaItemId: "media-9", baseCaption: "hello", workspaceId: "ws-1" }),
    );

    expect(response.status).toBe(200);
    expect(createPostJobForExistingMediaMock).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: "ws-1" }),
    );
  });

  it("proceeds exactly as before when workspaceId is absent (API compatibility)", async () => {
    const response = await POST(jsonRequest(blobBody()));

    expect(response.status).toBe(200);
    expect(createPostJobOnlyMock).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: "ws-1" }));
    expect(inngestSendMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["a number", 5],
    ["null", null],
    ["a boolean", true],
    ["an array", ["ws-1"]],
    ["an object", { id: "ws-1" }],
  ])("returns 400 INVALID_WORKSPACE_ID for a workspaceId that is %s, writing nothing", async (_label, workspaceId) => {
    const response = await POST(jsonRequest(blobBody({ workspaceId })));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ code: "INVALID_WORKSPACE_ID" });
    expectNothingWritten();
  });

  it("still requires auth first: an unauthenticated mismatch is a 401, not a 409", async () => {
    getWorkspaceContextMock.mockResolvedValue(null);

    const response = await POST(jsonRequest(blobBody({ workspaceId: "ws-2" })));

    expect(response.status).toBe(401);
  });
});

// 2026-11-01 scale audit (jobs, event size): a publish event carries the caption plus up
// to 7 per-platform overrides, and nothing capped their length, so an oversized
// caption could exceed Inngest's event / step-output size limits.
describe("POST /api/posts — caption length cap and override keys (2026-11-01 scale audit)", () => {
  const BLOB = "https://test.public.blob.vercel-storage.com/vid.mp4";
  const OVER = "a".repeat(10_001);
  const AT_CAP = "a".repeat(10_000);

  function blobBody(extra: Record<string, unknown> = {}) {
    return { blobUrl: BLOB, filename: "vid.mp4", mimeType: "video/mp4", sizeBytes: 123, baseCaption: "hello", ...extra };
  }

  beforeEach(() => {
    createPostJobOnlyMock.mockResolvedValue({ postJobId: "job-1", mediaItemId: "media-1", resultIds: [] });
    createPostJobForExistingMediaMock.mockResolvedValue({ postJobId: "job-1", mediaItemId: "media-1", resultIds: [] });
  });

  function expectNothingWritten() {
    expect(createPostJobOnlyMock).not.toHaveBeenCalled();
    expect(createPostJobForExistingMediaMock).not.toHaveBeenCalled();
    expect(postJobUpdateMock).not.toHaveBeenCalled();
    expect(notifyOwnersMock).not.toHaveBeenCalled();
    expect(inngestSendMock).not.toHaveBeenCalled();
  }

  it("returns 400 CAPTION_TOO_LONG for a 10,001-character baseCaption, writing and sending nothing", async () => {
    const response = await POST(jsonRequest(blobBody({ baseCaption: OVER })));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      code: "CAPTION_TOO_LONG",
      error: "baseCaption is too long (max 10,000 characters).",
    });
    expectNothingWritten();
  });

  it("returns 400 CAPTION_TOO_LONG for a 10,001-character perPlatformOverrides.x, naming the field", async () => {
    const response = await POST(jsonRequest(blobBody({ perPlatformOverrides: { x: OVER } })));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      code: "CAPTION_TOO_LONG",
      error: "perPlatformOverrides.x is too long (max 10,000 characters).",
    });
    expectNothingWritten();
  });

  it("applies the cap on the mediaItemId reuse path too", async () => {
    const base = await POST(jsonRequest({ mediaItemId: "media-9", baseCaption: OVER }));
    expect(base.status).toBe(400);
    await expect(base.json()).resolves.toMatchObject({ code: "CAPTION_TOO_LONG" });

    const override = await POST(
      jsonRequest({ mediaItemId: "media-9", baseCaption: "hi", perPlatformOverrides: { linkedin: OVER } }),
    );
    expect(override.status).toBe(400);
    await expect(override.json()).resolves.toMatchObject({
      code: "CAPTION_TOO_LONG",
      error: "perPlatformOverrides.linkedin is too long (max 10,000 characters).",
    });
    expectNothingWritten();
  });

  it("applies the cap to a draft and a scheduled post as well (every intent stores the caption)", async () => {
    for (const extra of [{ draft: true }, { scheduledFor: "2099-01-01T00:00:00.000Z" }]) {
      const response = await POST(jsonRequest(blobBody({ baseCaption: OVER, ...extra })));
      expect(response.status).toBe(400);
    }
    expectNothingWritten();
  });

  it("accepts a baseCaption and an override of exactly 10,000 characters", async () => {
    const response = await POST(
      jsonRequest(blobBody({ baseCaption: AT_CAP, perPlatformOverrides: { x: AT_CAP } })),
    );

    expect(response.status).toBe(200);
    expect(createPostJobOnlyMock).toHaveBeenCalledWith(
      expect.objectContaining({ baseCaption: AT_CAP, perPlatformOverrides: { x: AT_CAP } }),
    );
  });

  it("counts UTF-16 code units: 5,000 emoji pass, 5,001 are rejected", async () => {
    const ok = await POST(jsonRequest(blobBody({ baseCaption: "😀".repeat(5_000) })));
    expect(ok.status).toBe(200);

    createPostJobOnlyMock.mockClear();
    const tooLong = await POST(jsonRequest(blobBody({ baseCaption: "😀".repeat(5_001) })));
    expect(tooLong.status).toBe(400);
    await expect(tooLong.json()).resolves.toMatchObject({ code: "CAPTION_TOO_LONG" });
    expect(createPostJobOnlyMock).not.toHaveBeenCalled();
  });

  it("drops perPlatformOverrides keys that are not a platform before storing and publishing", async () => {
    const response = await POST(
      jsonRequest(blobBody({ perPlatformOverrides: { x: "hi", foo: "bar" } })),
    );

    expect(response.status).toBe(200);
    expect(createPostJobOnlyMock).toHaveBeenCalledWith(
      expect.objectContaining({ perPlatformOverrides: { x: "hi" } }),
    );
    expect(inngestSendMock).toHaveBeenCalledWith({
      id: "publish-job-1",
      name: "post/publish.requested",
      data: expect.objectContaining({ perPlatformOverrides: { x: "hi" } }),
    });
  });

  it("drops non-platform keys on the reuse path too", async () => {
    await POST(
      jsonRequest({
        mediaItemId: "media-9",
        baseCaption: "hi",
        perPlatformOverrides: { linkedin: "li", foo: "bar" },
      }),
    );

    expect(createPostJobForExistingMediaMock).toHaveBeenCalledWith(
      expect.objectContaining({ perPlatformOverrides: { linkedin: "li" } }),
    );
  });

  it("does not let an over-long NON-platform key block the post (it is dropped before the cap is checked)", async () => {
    const response = await POST(
      jsonRequest(blobBody({ perPlatformOverrides: { x: "hi", legacy: OVER } })),
    );

    expect(response.status).toBe(200);
    expect(createPostJobOnlyMock).toHaveBeenCalledWith(
      expect.objectContaining({ perPlatformOverrides: { x: "hi" } }),
    );
  });

  it("bounds the publish event: 8 captions of 10,000 characters plus a junk key stay under 80,000 caption characters", async () => {
    const overrides = Object.fromEntries(
      ["tiktok", "youtube", "x", "linkedin", "instagram", "google_business_profile", "facebook_page"].map(
        (p) => [p, AT_CAP],
      ),
    );
    await POST(jsonRequest(blobBody({ baseCaption: AT_CAP, perPlatformOverrides: { ...overrides, junk: AT_CAP } })));

    const sent = inngestSendMock.mock.calls[0][0] as {
      data: { baseCaption: string; perPlatformOverrides: Record<string, string> };
    };
    expect(Object.keys(sent.data.perPlatformOverrides)).toHaveLength(7);
    expect(sent.data.perPlatformOverrides).not.toHaveProperty("junk");
    const total =
      sent.data.baseCaption.length +
      Object.values(sent.data.perPlatformOverrides).reduce((n, v) => n + v.length, 0);
    expect(total).toBe(80_000);
  });
});
