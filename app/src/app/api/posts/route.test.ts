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
  checkDailyPostLimitMock,
  headMock,
  withdrawSendMock,
  storyCanSendMock,
} = vi.hoisted(() => ({
  storyCanSendMock: vi.fn(),
  headMock: vi.fn(),
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
  checkDailyPostLimitMock: vi.fn(),
  withdrawSendMock: vi.fn(),
}));

// Third review of K2: a send the create helper wrote is taken back when the hand-over fails.
// Review of T1, item 1: the real refusal class, which the create helpers throw.
vi.mock("@/server/usage/usageLog", async (importOriginal) => ({
  FreeRunRefusedError: (await importOriginal<typeof import("@/server/usage/usageLog")>()).FreeRunRefusedError,
  LimitCheckFailedError: (await importOriginal<typeof import("@/server/usage/usageLog")>()).LimitCheckFailedError,
  withdrawSend: withdrawSendMock,
}));

// Team Workspaces (Task 4) — route.ts now resolves the caller via
// `getWorkspaceContext` instead of `getCurrentUser` (design doc §3/§4).
vi.mock("@/lib/workspace", () => ({
  getWorkspaceContext: getWorkspaceContextMock,
}));

// F5: a new file's size and type are read from storage. By default storage
// holds what each request said it sent (see jsonRequest); the F5 tests below
// make it disagree.
vi.mock("@vercel/blob", () => ({ head: headMock }));

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
    // R8-publishing L2: posting.test.ts covers the rule; here only how the route uses it.
    immediateStoryCanSend: storyCanSendMock,
  };
});

// Usage limits (2026-11-10): the count and the email have their own suite
// (workspaceUsage.test.ts); here only where the route checks, and what it answers.
vi.mock("@/server/usage/workspaceUsage", () => ({
  checkDailyPostLimit: checkDailyPostLimitMock,
}));

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

import { BLOB_URL_REJECTED_MESSAGE, MAX_BLOB_URL_LENGTH, canonicalBlobUrl } from "@/lib/blobUrl";
import { LOGO_ADDRESS_RESERVED_MESSAGE } from "@/lib/workspaceLogo";
import { PostTargetingError } from "@/lib/postTargets";
import { MediaItemUnavailableError } from "@/server/jobs/posting";
import { composerSubmitOutcome } from "@/lib/composerSubmitOutcome";
import { POST } from "./route";

/**
 * Since the 2026-11-01 audit (Task 8) a blobUrl body must carry an image/video
 * `mimeType`. Fixtures that don't care about media metadata get a valid one
 * here unless they set the key themselves (the Task 8 validation tests do, to
 * exercise missing / invalid values).
 */
/** What the default storage double holds: each requested file, as the request described it. */
let storedFiles = new Map<string, { size: number; contentType: string }>();

function remember(file: unknown): void {
  if (typeof file !== "object" || file === null) return;
  const { blobUrl, mimeType, sizeBytes } = file as Record<string, unknown>;
  if (typeof blobUrl !== "string") return;
  storedFiles.set(canonicalBlobUrl(blobUrl) ?? blobUrl, {
    size: typeof sizeBytes === "number" && sizeBytes > 0 ? sizeBytes : 1,
    contentType: typeof mimeType === "string" ? mimeType : "",
  });
}

/**
 * F6 item 5: the route requires the id of the workspace the page was rendered
 * for, as the Create page and Add many send it. A body without the key gets the
 * active workspace's id here ("ws-1"); a test of the missing id sends the key
 * as undefined, which JSON leaves out.
 */
function withRenderedWorkspace(body: unknown): unknown {
  return typeof body === "object" && body !== null && !Array.isArray(body) && !("workspaceId" in body)
    ? { ...(body as object), workspaceId: "ws-1" }
    : body;
}

function jsonRequest(sent: unknown): Request {
  const body = withRenderedWorkspace(sent);
  const isBlobBody =
    typeof body === "object" && body !== null && "blobUrl" in body && !("mimeType" in body);
  const withDefaults = isBlobBody ? { mimeType: "video/mp4", ...(body as object) } : body;
  remember(withDefaults);
  const media = (withDefaults as { media?: unknown } | null)?.media;
  if (Array.isArray(media)) media.forEach(remember);
  // R3-security M1: a cover image is read from storage too.
  const cover = (withDefaults as { cover?: unknown } | null)?.cover;
  if (typeof cover === "object" && cover !== null) {
    const { imageUrl, mimeType, sizeBytes } = cover as Record<string, unknown>;
    remember({ blobUrl: imageUrl, mimeType, sizeBytes });
  }
  return new Request("http://localhost/api/posts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(withDefaults),
  });
}

beforeEach(() => {
  storedFiles = new Map();
  headMock.mockReset();
  headMock.mockImplementation(async (url: string) => {
    const stored = storedFiles.get(url);
    if (!stored) throw new Error("BlobNotFoundError");
    return stored;
  });
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
  checkDailyPostLimitMock.mockReset();
  checkDailyPostLimitMock.mockResolvedValue(null);
  withdrawSendMock.mockReset();
  withdrawSendMock.mockResolvedValue(undefined);
  storyCanSendMock.mockReset();
  storyCanSendMock.mockResolvedValue(true);
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
      perPlatformOverrides: undefined,
      // Roadmap Phase 5 additive params; default immediate path unchanged.
      intent: "immediate",
      scheduledFor: null,
    });
    // R21 publishing-flow L2: a location sent is accepted and ignored: nothing reads it.
    expect(createPostJobOnlyMock.mock.calls[0][0]).not.toHaveProperty("location");
    expect((inngestSendMock.mock.calls[0][0] as { data: object }).data).not.toHaveProperty("location");
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
      }),
    });
  });

  // R21 publishing-flow L2: a location of any length is no longer read or stored.
  it("accepts a request with a very long location and ignores it", async () => {
    createPostJobOnlyMock.mockResolvedValue({ postJobId: "job-1", mediaItemId: "media-1", resultIds: ["r1"] });
    const response = await POST(
      jsonRequest({
        blobUrl: "https://test.public.blob.vercel-storage.com/vid.mp4",
        filename: "vid.mp4",
        mimeType: "video/mp4",
        sizeBytes: 123,
        baseCaption: "hello world",
        location: "x".repeat(100_000),
      }),
    );

    expect(response.status).toBe(200);
    expect(createPostJobOnlyMock.mock.calls[0][0]).not.toHaveProperty("location");
    expect(JSON.stringify(inngestSendMock.mock.calls)).not.toContain("xxxxxxxxxx");
  });

  it("takes the event's workspaceId from the request's ACTIVE workspace, not from the user", async () => {
    getWorkspaceContextMock.mockResolvedValue(makeWorkspaceContext({ workspaceId: "ws-shared-9" }));
    createPostJobOnlyMock.mockResolvedValue({
      postJobId: "job-1",
      mediaItemId: "media-1",
      resultIds: ["r1"],
    });

    const response = await POST(
      jsonRequest({ blobUrl: "https://test.public.blob.vercel-storage.com/x", baseCaption: "hi", workspaceId: "ws-shared-9" }),
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

  // R11-publishing L1: only the owner can connect; a member reads who can.
  it("NO_CONNECTIONS: the owner is told to connect, a member that the owner can", async () => {
    createPostJobOnlyMock.mockRejectedValue(new Error("NO_CONNECTIONS"));
    const body = { blobUrl: "https://test.public.blob.vercel-storage.com/x", baseCaption: "hi" };

    await expect((await POST(jsonRequest(body))).json()).resolves.toMatchObject({
      message: "Connect at least one platform before creating a post.",
    });

    getWorkspaceContextMock.mockResolvedValue(makeWorkspaceContext({ role: "member" }));
    await expect((await POST(jsonRequest(body))).json()).resolves.toMatchObject({
      code: "NO_CONNECTIONS",
      message: "The workspace owner can connect a platform for this workspace.",
    });
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
      // Roadmap Phase 5 additive params; default immediate reuse unchanged.
      intent: "immediate",
      scheduledFor: null,
    });
    expect(createPostJobForExistingMediaMock.mock.calls[0][0]).not.toHaveProperty("location");
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
      // R25 L3: submission stamped and the member's chosen time kept inside
      // the create call's transaction, so the post is held or doesn't exist.
      expect(createPostJobOnlyMock).toHaveBeenCalledWith(
        expect.objectContaining({
          approvalHold: { submittedForApprovalAt: expect.any(Date), scheduledFor: new Date(FUTURE) },
        }),
      );
      expect(postJobUpdateMock).not.toHaveBeenCalled();
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
      // No chosen time to keep — only the submission stamp, in the create call.
      expect(createPostJobOnlyMock).toHaveBeenCalledWith(
        expect.objectContaining({ approvalHold: { submittedForApprovalAt: expect.any(Date), scheduledFor: null } }),
      );
      expect(postJobUpdateMock).not.toHaveBeenCalled();
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
      // Notified only once the held post is created.
      expect(createPostJobOnlyMock.mock.invocationCallOrder[0]).toBeLessThan(
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

    // Third review of K2: a send exists only for a post handed to publishing.
    it("takes back the send the create helper reported writing when the hand-over fails", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      const sendsWritten = { postJobIds: ["job-1"], day: new Date("2026-11-14T15:00:00Z") };
      createPostJobOnlyMock.mockResolvedValue({ postJobId: "job-1", mediaItemId: "media-1", resultIds: ["r1"], sendsWritten });
      inngestSendMock.mockRejectedValue(new Error("inngest unreachable"));

      const response = await POST(
        jsonRequest({ blobUrl: "https://test.public.blob.vercel-storage.com/x", baseCaption: "hi" }),
      );

      expect(response.status).toBe(503);
      expect(withdrawSendMock).toHaveBeenCalledWith(sendsWritten);
    });

    it("takes back nothing when the helper wrote no send, or when the hand-over succeeds", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      createPostJobOnlyMock.mockResolvedValue({ postJobId: "job-1", mediaItemId: "media-1", resultIds: ["r1"] });
      inngestSendMock.mockRejectedValueOnce(new Error("inngest unreachable"));
      await POST(jsonRequest({ blobUrl: "https://test.public.blob.vercel-storage.com/x", baseCaption: "hi" }));
      createPostJobOnlyMock.mockResolvedValue({
        postJobId: "job-1",
        mediaItemId: "media-1",
        resultIds: ["r1"],
        sendsWritten: { postJobIds: ["job-1"], day: new Date() },
      });
      await POST(jsonRequest({ blobUrl: "https://test.public.blob.vercel-storage.com/x", baseCaption: "hi" }));
      expect(withdrawSendMock).not.toHaveBeenCalled();
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

  // 2026-11-10: the Google post's options, validated by lib/googlePostOptions.ts.
  const GOOGLE_EVENT = {
    postType: "event",
    event: { title: "Full moon paddle", startDate: "2030-01-05", endDate: "2030-01-05", startTime: "18:00" },
    button: { type: "SIGN_UP", url: "https://example.com/signup" },
  };

  it("forwards the validated googleMetadata to the create helper for a scheduled post (stored in the snapshot)", async () => {
    await POST(
      jsonRequest({
        blobUrl: "https://test.public.blob.vercel-storage.com/x",
        baseCaption: "hi",
        scheduledFor: FUTURE,
        googleMetadata: { ...GOOGLE_EVENT, bogus: 1 },
      }),
    );

    expect(createPostJobOnlyMock).toHaveBeenCalledWith(
      expect.objectContaining({ intent: "scheduled", googleMetadata: GOOGLE_EVENT }),
    );
  });

  it("forwards googleMetadata on the reuse path too", async () => {
    createPostJobForExistingMediaMock.mockResolvedValue({ postJobId: "job-2", mediaItemId: "media-9", resultIds: [] });

    await POST(jsonRequest({ mediaItemId: "media-9", baseCaption: "hi", draft: true, googleMetadata: GOOGLE_EVENT }));

    expect(createPostJobForExistingMediaMock).toHaveBeenCalledWith(
      expect.objectContaining({ intent: "draft", googleMetadata: GOOGLE_EVENT }),
    );
  });

  it("sends googleMetadata in the immediate publish event", async () => {
    await POST(
      jsonRequest({
        blobUrl: "https://test.public.blob.vercel-storage.com/x",
        baseCaption: "hi",
        googleMetadata: { postType: "update" },
      }),
    );

    expect(inngestSendMock).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ googleMetadata: { postType: "update" } }) }),
    );
  });

  it("a post without googleMetadata sends none (the workspace default applies at publish)", async () => {
    await POST(jsonRequest({ blobUrl: "https://test.public.blob.vercel-storage.com/x", baseCaption: "hi" }));

    const [event] = inngestSendMock.mock.calls[0] as [{ data: Record<string, unknown> }];
    expect(event.data.googleMetadata).toBeUndefined();
  });

  it.each([
    [{ postType: "offer", offer: { title: "Deal", startDate: "2030-01-01", endDate: "2030-01-02" }, button: { type: "BOOK", url: "https://e.com" } }, /offer can't have a button/],
    [{ postType: "update", button: { type: "BOOK", url: "http://e.com" } }, /button link/],
    [{ postType: "event", event: { title: "x", startDate: "2030-01-05", endDate: "2030-01-04" } }, /end date/],
    ["update", /googleMetadata/],
  ])("refuses bad googleMetadata with a 400 naming the field (%#)", async (googleMetadata, message) => {
    const response = await POST(
      jsonRequest({ blobUrl: "https://test.public.blob.vercel-storage.com/x", baseCaption: "hi", googleMetadata }),
    );

    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toMatch(message);
    expect(createPostJobOnlyMock).not.toHaveBeenCalled();
    expect(inngestSendMock).not.toHaveBeenCalled();
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

  it("refuses a workspace logo's address in blobUrl with a plain 400 and creates nothing", async () => {
    const response = await POST(
      jsonRequest(body("https://test.public.blob.vercel-storage.com/logos/0123456789abcdef0123456789abcdef.png")),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: LOGO_ADDRESS_RESERVED_MESSAGE });
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

  // F5: storage is the truth for the size and the type. Whatever the request
  // says about them is replaced by what storage holds (here a 123-byte MP4).
  it.each([
    ["sizeBytes is negative", { sizeBytes: -1 }],
    ["sizeBytes is fractional", { sizeBytes: 1.5 }],
    ["sizeBytes is a string", { sizeBytes: "123" }],
    ["sizeBytes is not a safe integer", { sizeBytes: 2 ** 53 }],
    ["sizeBytes is above the 512 MB cap", { sizeBytes: 600 * 1024 * 1024 }],
    ["mimeType is missing", { mimeType: undefined }],
    ["mimeType is empty", { mimeType: "" }],
    ["mimeType is not image/* or video/*", { mimeType: "application/pdf" }],
    ["mimeType is not a string", { mimeType: 7 }],
  ])("stores what storage holds when the request's %s", async (_label, overrides) => {
    const body = jsonRequest(validBody(overrides));
    headMock.mockReset();
    headMock.mockResolvedValue({ size: 123, contentType: "video/mp4" });

    const response = await POST(body);

    expect(response.status).toBe(200);
    expect(createPostJobOnlyMock.mock.calls[0][0].media).toMatchObject({ mimeType: "video/mp4", sizeBytes: 123 });
  });

  it.each([
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

  it("accepts sizeBytes of 0, a 255-character filename and an image type; the size stored is storage's (F5)", async () => {
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
          // The storage double's size for a file the request called 0 bytes.
          sizeBytes: 1,
        },
      }),
    );
  });

  it("accepts an absent sizeBytes (storage's size is stored) and defaults an absent filename to 'upload'", async () => {
    const response = await POST(
      jsonRequest(validBody({ sizeBytes: undefined, filename: undefined })),
    );

    expect(response.status).toBe(200);
    expect(createPostJobOnlyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        media: expect.objectContaining({ originalFilename: "upload", sizeBytes: 1 }),
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

    it("lets a video through to Facebook Page (it takes videos since 2026-11-08)", async () => {
      const response = await POST(
        jsonRequest({ blobUrl: BLOB, mimeType: "video/mp4", baseCaption: "hi", platforms: ["facebook_page"] }),
      );

      expect(response.status).toBe(200);
      expect(createPostJobOnlyMock).toHaveBeenCalledWith(
        expect.objectContaining({ targetPlatforms: ["facebook_page"] }),
      );
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
          "These platforms can't publish an image: YouTube (video only).",
          ["youtube"],
        ),
      );

      const response = await POST(
        jsonRequest({ mediaItemId: "media-9", baseCaption: "hi", platforms: ["youtube"] }),
      );

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        error: "These platforms can't publish an image: YouTube (video only).",
        code: "PLATFORM_MEDIA_MISMATCH",
        platforms: ["youtube"],
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

  it("an empty-string workspaceId is refused as missing (F6 item 5)", async () => {
    const response = await POST(jsonRequest(blobBody({ workspaceId: "" })));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "This page is out of date. Reload it, then try again.",
      code: "MISSING_WORKSPACE_ID",
    });
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

  it("refuses a body without workspaceId (F6 item 5): 400, nothing written, on every path", async () => {
    for (const body of [
      blobBody({ workspaceId: undefined }),
      { mediaItemId: "media-9", baseCaption: "hello", workspaceId: undefined },
      blobBody({ workspaceId: undefined, draft: true }),
    ]) {
      const response = await POST(jsonRequest(body));
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        error: "This page is out of date. Reload it, then try again.",
        code: "MISSING_WORKSPACE_ID",
      });
    }
    expectNothingWritten();
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
// to 8 per-platform overrides, and nothing capped their length, so an oversized
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

  // One override per platform: 8 since Pinterest (2026-11-10).
  it("bounds the publish event: 9 captions of 10,000 characters plus a junk key stay at 90,000 caption characters", async () => {
    const overrides = Object.fromEntries(
      [
        "tiktok",
        "youtube",
        "x",
        "linkedin",
        "instagram",
        "google_business_profile",
        "facebook_page",
        "pinterest",
      ].map((p) => [p, AT_CAP]),
    );
    await POST(jsonRequest(blobBody({ baseCaption: AT_CAP, perPlatformOverrides: { ...overrides, junk: AT_CAP } })));

    const sent = inngestSendMock.mock.calls[0][0] as {
      data: { baseCaption: string; perPlatformOverrides: Record<string, string> };
    };
    expect(Object.keys(sent.data.perPlatformOverrides)).toHaveLength(8);
    expect(sent.data.perPlatformOverrides).not.toHaveProperty("junk");
    const total =
      sent.data.baseCaption.length +
      Object.values(sent.data.perPlatformOverrides).reduce((n, v) => n + v.length, 0);
    expect(total).toBe(90_000);
  });
});

// 2026-11-09: publishing no longer waits for a verified email. Posting needs
// the person's own platform accounts connected through each platform's sign-in,
// and Meta's reviewers register with any email address, then publish.
describe("POST /api/posts — an unverified email may publish", () => {
  beforeEach(() => {
    // Email is deliverable, and the fixture user has no emailVerifiedAt.
    vi.stubEnv("RESEND_API_KEY", "re_test");
    createPostJobOnlyMock.mockResolvedValue({ postJobId: "job-1", mediaItemId: "media-1", resultIds: [] });
  });

  it("publishes now for a user who hasn't verified their email", async () => {
    const response = await POST(
      jsonRequest({ blobUrl: "https://test.public.blob.vercel-storage.com/x", baseCaption: "hi" }),
    );

    expect(response.status).toBe(200);
    expect(inngestSendMock).toHaveBeenCalledTimes(1);
  });
});

describe("POST /api/posts — daily post limit (usage limits)", () => {
  const FUTURE = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const BLOB = "https://test.public.blob.vercel-storage.com/x";
  const NOW_SENTENCE =
    "This workspace has reached its limit of 20 posts for today. Schedule this post for another day, or try again tomorrow.";
  const SCHEDULE_SENTENCE =
    "That day already has 20 posts, which is this workspace's daily limit. Pick another day.";

  beforeEach(() => {
    createPostJobOnlyMock.mockResolvedValue({ postJobId: "job-1", mediaItemId: "media-1", resultIds: [] });
  });

  it("checks a post going out now against today, and lets it through under the limit", async () => {
    const before = Date.now();
    const response = await POST(jsonRequest({ blobUrl: BLOB, baseCaption: "hi" }));

    expect(response.status).toBe(200);
    expect(checkDailyPostLimitMock).toHaveBeenCalledTimes(1);
    const args = checkDailyPostLimitMock.mock.calls[0][0];
    expect(args).toMatchObject({ workspaceId: "ws-1", mode: "now" });
    expect(args.day.getTime()).toBeGreaterThanOrEqual(before);
    expect(createPostJobOnlyMock).toHaveBeenCalled();
  });

  it("answers 429 with the sentence and code at the limit, and creates nothing", async () => {
    checkDailyPostLimitMock.mockResolvedValue({ error: NOW_SENTENCE, code: "WORKSPACE_DAILY_POST_LIMIT" });

    const response = await POST(jsonRequest({ blobUrl: BLOB, baseCaption: "hi" }));

    expect(response.status).toBe(429);
    await expect(response.json()).resolves.toEqual({
      error: NOW_SENTENCE,
      code: "WORKSPACE_DAILY_POST_LIMIT",
    });
    expect(createPostJobOnlyMock).not.toHaveBeenCalled();
    expect(inngestSendMock).not.toHaveBeenCalled();
  });

  it("checks a scheduled post against its scheduled day", async () => {
    checkDailyPostLimitMock.mockResolvedValue({ error: SCHEDULE_SENTENCE, code: "WORKSPACE_DAILY_POST_LIMIT" });

    const response = await POST(jsonRequest({ blobUrl: BLOB, baseCaption: "hi", scheduledFor: FUTURE }));

    expect(checkDailyPostLimitMock).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      day: new Date(FUTURE),
      mode: "schedule",
      viewerUserId: expect.any(String),
    });
    expect(response.status).toBe(429);
    await expect(response.json()).resolves.toEqual({
      error: SCHEDULE_SENTENCE,
      code: "WORKSPACE_DAILY_POST_LIMIT",
    });
    expect(createPostJobOnlyMock).not.toHaveBeenCalled();
  });

  it("never checks a draft", async () => {
    const response = await POST(jsonRequest({ blobUrl: BLOB, baseCaption: "hi", draft: true }));

    expect(response.status).toBe(200);
    expect(checkDailyPostLimitMock).not.toHaveBeenCalled();
  });

  it("never checks a member's post held for approval (it is saved as a draft)", async () => {
    getWorkspaceContextMock.mockResolvedValue(makeWorkspaceContext({ role: "member", requireApproval: true }));

    const response = await POST(jsonRequest({ blobUrl: BLOB, baseCaption: "hi", scheduledFor: FUTURE }));

    expect(response.status).toBe(200);
    expect(checkDailyPostLimitMock).not.toHaveBeenCalled();
  });
});

describe("POST /api/posts - the media list (several photos, 07a)", () => {
  const HOST = "https://test.public.blob.vercel-storage.com";
  const photo = (n: number, mimeType = "image/jpeg") => ({
    blobUrl: `${HOST}/p${n}.jpg`,
    filename: `p${n}.jpg`,
    mimeType,
    sizeBytes: 100 + n,
  });
  const stored = (n: number, mimeType = "image/jpeg") => ({
    storageLocation: `${HOST}/p${n}.jpg`,
    originalFilename: `p${n}.jpg`,
    mimeType,
    sizeBytes: 100 + n,
  });
  const FUTURE = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

  beforeEach(() => {
    createPostJobOnlyMock.mockResolvedValue({ postJobId: "job-1", mediaItemId: "media-1", resultIds: ["r1"] });
  });

  it("one entry creates the post with exactly the arguments the blobUrl fields give", async () => {
    await POST(jsonRequest({ ...photo(1), baseCaption: "hi" }));
    const viaBlobUrl = createPostJobOnlyMock.mock.calls[0][0];
    const eventViaBlobUrl = inngestSendMock.mock.calls[0][0];
    createPostJobOnlyMock.mockClear();
    inngestSendMock.mockClear();

    const response = await POST(jsonRequest({ media: [photo(1)], baseCaption: "hi" }));

    expect(response.status).toBe(200);
    expect(createPostJobOnlyMock.mock.calls[0][0]).toStrictEqual(viaBlobUrl);
    expect(createPostJobOnlyMock.mock.calls[0][0]).not.toHaveProperty("extraMedia");
    expect(inngestSendMock.mock.calls[0][0]).toStrictEqual(eventViaBlobUrl);
  });

  it("a single GIF or video in the list behaves as a single blob does", async () => {
    const response = await POST(jsonRequest({ media: [photo(1, "video/mp4")], baseCaption: "hi" }));
    expect(response.status).toBe(200);
    expect(createPostJobOnlyMock.mock.calls[0][0].media).toEqual(stored(1, "video/mp4"));
  });

  it("three entries create the post with the first as media and the rest, in order, as extraMedia", async () => {
    const response = await POST(
      jsonRequest({ media: [photo(1), photo(2, "image/png"), photo(3, "image/webp")], baseCaption: "hi" }),
    );

    expect(response.status).toBe(200);
    expect(createPostJobOnlyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        media: stored(1),
        extraMedia: [stored(2, "image/png"), stored(3, "image/webp")],
        intent: "immediate",
      }),
    );
    // The publish event is unchanged: it names the first photo.
    expect(inngestSendMock).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ mediaItemId: "media-1" }) }),
    );
  });

  it.each([
    ["blobUrl", { blobUrl: `${HOST}/x.jpg` }],
    ["mediaItemId", { mediaItemId: "media-9" }],
  ])("media together with %s is a 400", async (_name, extra) => {
    const response = await POST(jsonRequest({ media: [photo(1), photo(2)], baseCaption: "hi", ...extra }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Send either media or blobUrl / mediaItemId, not both.",
    });
    expect(createPostJobOnlyMock).not.toHaveBeenCalled();
    expect(createPostJobForExistingMediaMock).not.toHaveBeenCalled();
  });

  it.each([
    ["eleven files", Array.from({ length: 11 }, (_, i) => photo(i)), "A post can have at most 10 photos."],
    [
      "a video among several",
      [photo(1), photo(2, "video/mp4")],
      "A post with several files can only contain photos. Post a video on its own.",
    ],
    [
      "a GIF among several",
      [photo(1, "image/gif"), photo(2)],
      "A post with several photos can't include a GIF. Post a GIF on its own.",
    ],
    ["a bad host", [photo(1), { ...photo(2), blobUrl: "https://evil.example/x.jpg" }], `File 2: ${BLOB_URL_REJECTED_MESSAGE}`],
    [
      "a workspace logo's address",
      [photo(1), { ...photo(2), blobUrl: `${HOST}/logos/0123456789abcdef0123456789abcdef.png` }],
      `File 2: ${LOGO_ADDRESS_RESERVED_MESSAGE}`,
    ],
  ])("%s is a 400 that names the rule", async (_name, media, error) => {
    const response = await POST(jsonRequest({ media, baseCaption: "hi" }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error });
    expect(createPostJobOnlyMock).not.toHaveBeenCalled();
  });

  it("treats a multi-photo post as an image post for platform targeting", async () => {
    const response = await POST(
      jsonRequest({ media: [photo(1), photo(2)], baseCaption: "hi", platforms: ["youtube"] }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ code: "PLATFORM_MEDIA_MISMATCH", platforms: ["youtube"] });
    expect(createPostJobOnlyMock).not.toHaveBeenCalled();
  });

  // R21 platform-clients M1: every file LinkedIn receives is checked, not the first alone.
  it.each([
    ["first", ["image/webp", "image/jpeg", "image/jpeg"], 1],
    ["middle", ["image/jpeg", "image/webp", "image/jpeg"], 2],
    ["last", ["image/jpeg", "image/jpeg", "image/webp"], 3],
  ] as const)("a WebP %s refuses LinkedIn and names the photo", async (_where, types, n) => {
    const response = await POST(
      jsonRequest({
        media: types.map((type, index) => photo(index + 1, type)),
        baseCaption: "hi",
        platforms: ["linkedin", "instagram"],
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      code: "PLATFORM_MEDIA_MISMATCH",
      platforms: ["linkedin"],
      error: `These platforms can't publish these photos: LinkedIn (photo ${n} is WebP; JPG or PNG only). Remove them from platforms or choose different media.`,
    });
    expect(createPostJobOnlyMock).not.toHaveBeenCalled();
  });

  it("Google is judged on the first photo only: a WebP second is accepted", async () => {
    const response = await POST(
      jsonRequest({
        media: [photo(1), photo(2, "image/webp")],
        baseCaption: "hi",
        platforms: ["google_business_profile", "x"],
      }),
    );
    expect(response.status).toBe(200);
  });

  it("the daily post limit still applies", async () => {
    checkDailyPostLimitMock.mockResolvedValue({ error: "Limit reached.", code: "WORKSPACE_DAILY_POST_LIMIT" });

    const response = await POST(jsonRequest({ media: [photo(1), photo(2)], baseCaption: "hi" }));

    expect(response.status).toBe(429);
    expect(createPostJobOnlyMock).not.toHaveBeenCalled();
  });

  it("a member's multi-photo post is held for approval with its photos", async () => {
    getWorkspaceContextMock.mockResolvedValue(makeWorkspaceContext({ role: "member", requireApproval: true }));

    const response = await POST(jsonRequest({ media: [photo(1), photo(2)], baseCaption: "hi" }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ awaitingApproval: true });
    expect(createPostJobOnlyMock).toHaveBeenCalledWith(
      expect.objectContaining({ intent: "draft", media: stored(1), extraMedia: [stored(2)] }),
    );
    expect(inngestSendMock).not.toHaveBeenCalled();
  });

  it("a scheduled multi-photo post is created scheduled with its photos and sends no event", async () => {
    const response = await POST(jsonRequest({ media: [photo(1), photo(2)], baseCaption: "hi", scheduledFor: FUTURE }));

    expect(response.status).toBe(200);
    expect(createPostJobOnlyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        intent: "scheduled",
        scheduledFor: new Date(FUTURE),
        extraMedia: [stored(2)],
      }),
    );
    expect(checkDailyPostLimitMock).toHaveBeenCalledWith(expect.objectContaining({ mode: "schedule" }));
    expect(inngestSendMock).not.toHaveBeenCalled();
  });

  it("a multi-photo post keeps its Google options, on the job and in the publish event", async () => {
    const googleMetadata = { postType: "update", button: { type: "BOOK", url: "https://e.com/book" } };

    const response = await POST(jsonRequest({ media: [photo(1), photo(2)], baseCaption: "hi", googleMetadata }));

    expect(response.status).toBe(200);
    expect(createPostJobOnlyMock).toHaveBeenCalledWith(
      expect.objectContaining({ extraMedia: [stored(2)], googleMetadata }),
    );
    expect(inngestSendMock).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ googleMetadata }) }),
    );
  });

  it("a multi-photo draft is saved with its photos", async () => {
    const response = await POST(jsonRequest({ media: [photo(1), photo(2)], baseCaption: "hi", draft: true }));

    expect(response.status).toBe(200);
    expect(createPostJobOnlyMock).toHaveBeenCalledWith(
      expect.objectContaining({ intent: "draft", extraMedia: [stored(2)] }),
    );
  });
});

// 2026-11-10: feed or Story for Instagram and Facebook (lib/storyPlacement.ts).
describe("POST /api/posts - Story placement", () => {
  const HOST = "https://test.public.blob.vercel-storage.com";
  const photo = (n: number) => ({
    blobUrl: `${HOST}/p${n}.jpg`,
    filename: `p${n}.jpg`,
    mimeType: "image/jpeg",
    sizeBytes: 100 + n,
  });
  const STORY = { placement: "story" };

  beforeEach(() => {
    createPostJobOnlyMock.mockResolvedValue({ postJobId: "job-1", mediaItemId: "media-1", resultIds: ["r1"] });
    createPostJobForExistingMediaMock.mockResolvedValue({ postJobId: "job-2", mediaItemId: "media-9", resultIds: [] });
  });

  it("hands a Story to the create helper (the snapshot) and to the publish event", async () => {
    const response = await POST(
      jsonRequest({
        ...photo(1),
        baseCaption: "hi",
        platforms: ["instagram", "facebook_page"],
        instagramMetadata: STORY,
        facebookMetadata: STORY,
      }),
    );

    expect(response.status).toBe(200);
    expect(createPostJobOnlyMock).toHaveBeenCalledWith(
      expect.objectContaining({ instagramMetadata: STORY, facebookMetadata: STORY }),
    );
    expect(inngestSendMock).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ instagramMetadata: STORY, facebookMetadata: STORY }),
      }),
    );
  });

  it("hands a Story to the reuse helper too", async () => {
    await POST(jsonRequest({ mediaItemId: "media-9", baseCaption: "hi", draft: true, instagramMetadata: STORY }));

    expect(createPostJobForExistingMediaMock).toHaveBeenCalledWith(
      expect.objectContaining({ instagramMetadata: STORY }),
    );
  });

  it("feed, or no field, creates the post exactly as before", async () => {
    await POST(jsonRequest({ ...photo(1), baseCaption: "hi", platforms: ["instagram"] }));
    const before = createPostJobOnlyMock.mock.calls[0][0];
    const eventBefore = inngestSendMock.mock.calls[0][0];
    createPostJobOnlyMock.mockClear();
    inngestSendMock.mockClear();

    await POST(
      jsonRequest({
        ...photo(1),
        baseCaption: "hi",
        platforms: ["instagram"],
        instagramMetadata: { placement: "feed" },
      }),
    );

    expect(createPostJobOnlyMock.mock.calls[0][0]).toStrictEqual(before);
    expect(inngestSendMock.mock.calls[0][0]).toStrictEqual(eventBefore);
  });

  it("ignores the field of a platform the post does not target, even junk", async () => {
    const response = await POST(
      jsonRequest({ ...photo(1), baseCaption: "hi", platforms: ["x"], instagramMetadata: "junk", facebookMetadata: STORY }),
    );

    expect(response.status).toBe(200);
    const args = createPostJobOnlyMock.mock.calls[0][0];
    expect(args).not.toHaveProperty("instagramMetadata");
    expect(args).not.toHaveProperty("facebookMetadata");
  });

  it.each([
    ["instagramMetadata", { placement: "reel" }],
    ["instagramMetadata", "story"],
    ["facebookMetadata", { placement: "story", extra: true }],
  ])("refuses junk in %s with a 400 naming the field", async (field, value) => {
    const response = await POST(
      jsonRequest({ ...photo(1), baseCaption: "hi", platforms: ["instagram", "facebook_page"], [field]: value }),
    );

    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toContain(field);
    expect(createPostJobOnlyMock).not.toHaveBeenCalled();
    expect(inngestSendMock).not.toHaveBeenCalled();
  });

  it("refuses a Story with several photos, with the sentence", async () => {
    const response = await POST(
      jsonRequest({
        media: [photo(1), photo(2)],
        baseCaption: "hi",
        platforms: ["instagram", "x"],
        instagramMetadata: STORY,
      }),
    );

    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toBe(
      "A Story takes one photo or video. Choose Feed for Instagram, or remove the extra photos.",
    );
    expect(createPostJobOnlyMock).not.toHaveBeenCalled();
  });

  it("reads the field when the post names no platforms (every connection is a target)", async () => {
    await POST(jsonRequest({ ...photo(1), baseCaption: "hi", facebookMetadata: STORY }));

    expect(createPostJobOnlyMock).toHaveBeenCalledWith(expect.objectContaining({ facebookMetadata: STORY }));
  });
});

describe("POST /api/posts - the approval email for a Story (fix round 1)", () => {
  beforeEach(() => {
    createPostJobOnlyMock.mockResolvedValue({ postJobId: "job-1", mediaItemId: "media-1", resultIds: [] });
    getWorkspaceContextMock.mockResolvedValue(makeWorkspaceContext({ role: "member", requireApproval: true }));
  });

  it("lists a Story platform as 'Story, no caption', even over its own override", async () => {
    await POST(
      jsonRequest({
        blobUrl: "https://test.public.blob.vercel-storage.com/x.jpg",
        mimeType: "image/jpeg",
        baseCaption: "Two spots left today",
        perPlatformOverrides: { instagram: "IG text", x: "X text" },
        platforms: ["instagram", "facebook_page", "x"],
        instagramMetadata: { placement: "story" },
        facebookMetadata: { placement: "story" },
      }),
    );

    expect(notifyOwnersMock).toHaveBeenCalledWith(
      expect.objectContaining({
        platformCaptions: {
          instagram: "Story, no caption",
          facebook_page: "Story, no caption",
          x: "X text",
        },
      }),
    );
  });

  it("a feed post's email is unchanged", async () => {
    await POST(
      jsonRequest({
        blobUrl: "https://test.public.blob.vercel-storage.com/x.jpg",
        mimeType: "image/jpeg",
        baseCaption: "Two spots left today",
        perPlatformOverrides: { instagram: "IG text" },
        platforms: ["instagram"],
        instagramMetadata: { placement: "feed" },
      }),
    );

    expect(notifyOwnersMock).toHaveBeenCalledWith(
      expect.objectContaining({ platformCaptions: { instagram: "IG text" } }),
    );
  });
});

// 07d: the route hands each cleaned description to the create helper, which
// writes it with the media row in the post's transaction (posting.test.ts).
describe("POST /api/posts - alt text (07d)", () => {
  const HOST = "https://test.public.blob.vercel-storage.com";
  const photo = (n: number, mimeType = "image/jpeg") => ({
    blobUrl: `${HOST}/p${n}.jpg`,
    filename: `p${n}.jpg`,
    mimeType,
    sizeBytes: 100 + n,
  });
  const stored = (n: number, mimeType = "image/jpeg") => ({
    storageLocation: `${HOST}/p${n}.jpg`,
    originalFilename: `p${n}.jpg`,
    mimeType,
    sizeBytes: 100 + n,
  });
  const created = () => createPostJobOnlyMock.mock.calls[0][0];
  const reused = () => createPostJobForExistingMediaMock.mock.calls[0][0];

  beforeEach(() => {
    createPostJobOnlyMock.mockResolvedValue({ postJobId: "job-1", mediaItemId: "media-1", resultIds: ["r1"] });
    createPostJobForExistingMediaMock.mockResolvedValue({ postJobId: "job-2", mediaItemId: "media-9", resultIds: [] });
  });

  it("hands a single photo's cleaned description to the create helper with its file", async () => {
    const response = await POST(jsonRequest({ ...photo(1), baseCaption: "hi", altText: " A dog\non a beach. " }));

    expect(response.status).toBe(200);
    expect(created().media).toStrictEqual({ ...stored(1), altText: "A dog on a beach." });
  });

  it("hands each of several photos its own description, in order", async () => {
    const response = await POST(
      jsonRequest({
        media: [{ ...photo(1), altText: "First." }, photo(2), { ...photo(3), altText: "Third." }],
        baseCaption: "hi",
      }),
    );

    expect(response.status).toBe(200);
    expect(created().media).toStrictEqual({ ...stored(1), altText: "First." });
    expect(created().extraMedia).toStrictEqual([stored(2), { ...stored(3), altText: "Third." }]);
  });

  it("a post without descriptions hands the helper exactly today's file info", async () => {
    await POST(jsonRequest({ ...photo(1), baseCaption: "hi", altText: "  \n " }));
    expect(created().media).toStrictEqual(stored(1));
    createPostJobOnlyMock.mockClear();

    await POST(jsonRequest({ media: [photo(1), photo(2)], baseCaption: "hi" }));
    expect(created().media).toStrictEqual(stored(1));
    expect(created().extraMedia).toStrictEqual([stored(2)]);
  });

  it("ignores a description sent with a video", async () => {
    const response = await POST(jsonRequest({ ...photo(1, "video/mp4"), baseCaption: "hi", altText: "A clip." }));

    expect(response.status).toBe(200);
    expect(created().media).toStrictEqual(stored(1, "video/mp4"));
  });

  it("refuses an altText that is not text, creating nothing", async () => {
    const response = await POST(jsonRequest({ ...photo(1), baseCaption: "hi", altText: ["x"] }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "altText must be text." });
    expect(createPostJobOnlyMock).not.toHaveBeenCalled();
  });

  it("a reused photo: a sent description goes to the reuse helper, with the active workspace", async () => {
    const response = await POST(jsonRequest({ mediaItemId: "media-9", baseCaption: "hi", altText: "A new one." }));

    expect(response.status).toBe(200);
    expect(reused()).toMatchObject({ workspaceId: "ws-1", mediaItemId: "media-9", altText: "A new one." });
  });

  it("a reused photo without a description sends the helper no altText, so the stored one stays", async () => {
    await POST(jsonRequest({ mediaItemId: "media-9", baseCaption: "hi" }));
    await POST(jsonRequest({ mediaItemId: "media-9", baseCaption: "hi", altText: "" }));

    for (const [args] of createPostJobForExistingMediaMock.mock.calls) {
      expect(args).not.toHaveProperty("altText");
    }
  });
});

// 11: a repeating post is a series of ordinary scheduled posts, created in one
// call to the create helper (one transaction).
describe("POST /api/posts - repeat (repeatAt)", () => {
  const HOST = "https://test.public.blob.vercel-storage.com";
  const photo = (n: number) => ({
    blobUrl: `${HOST}/p${n}.jpg`,
    filename: `p${n}.jpg`,
    mimeType: "image/jpeg",
    sizeBytes: 100 + n,
  });
  const DAY = 24 * 60 * 60 * 1000;
  const FIRST = new Date(Date.now() + 2 * 60 * 60 * 1000);
  const weekly = (n: number) => Array.from({ length: n }, (_, i) => new Date(FIRST.getTime() + (i + 1) * 7 * DAY));
  const iso = (dates: Date[]) => dates.map((d) => d.toISOString());
  const NEEDS_TIME = "A repeating post needs a date and time (scheduledFor). Schedule it, then choose Repeat.";

  beforeEach(() => {
    createPostJobOnlyMock.mockResolvedValue({
      postJobId: "job-1",
      postJobIds: ["job-1", "job-2", "job-3", "job-4"],
      mediaItemId: "media-1",
      resultIds: [],
    });
    createPostJobForExistingMediaMock.mockResolvedValue({
      postJobId: "job-1",
      postJobIds: ["job-1", "job-2"],
      mediaItemId: "media-9",
      resultIds: [],
    });
  });

  async function refused(body: Record<string, unknown>): Promise<string> {
    const response = await POST(jsonRequest({ ...photo(1), baseCaption: "hi", ...body }));
    expect(response.status).toBe(400);
    expect(createPostJobOnlyMock).not.toHaveBeenCalled();
    expect(createPostJobForExistingMediaMock).not.toHaveBeenCalled();
    return ((await response.json()) as { error: string }).error;
  }

  it("refuses repeatAt without scheduledFor, and with a draft", async () => {
    expect(await refused({ repeatAt: iso(weekly(1)) })).toBe(NEEDS_TIME);
    expect(await refused({ draft: true, scheduledFor: FIRST.toISOString(), repeatAt: iso(weekly(1)) })).toBe(
      NEEDS_TIME,
    );
  });

  it("refuses repeats out of order, too close together, in the past, or more than 11", async () => {
    const [a, b] = weekly(2);
    expect(await refused({ scheduledFor: FIRST.toISOString(), repeatAt: iso([b, a]) })).toBe(
      "Repeat 2 must be later than the one before it.",
    );
    const hourLater = new Date(FIRST.getTime() + 60 * 60 * 1000).toISOString();
    expect(await refused({ scheduledFor: FIRST.toISOString(), repeatAt: [hourLater] })).toBe(
      "Repeat 1 is less than 23 hours after the one before it. Space the repeats at least a day apart.",
    );
    expect(await refused({ scheduledFor: FIRST.toISOString(), repeatAt: ["2020-01-01T00:00:00.000Z"] })).toBe(
      "Repeat 1 must be at least a minute in the future.",
    );
    expect(await refused({ scheduledFor: FIRST.toISOString(), repeatAt: iso(weekly(12)) })).toBe(
      "A post can repeat at most 12 times in total. Choose fewer repeats.",
    );
  });

  it("refuses a Story that repeats", async () => {
    expect(
      await refused({
        scheduledFor: FIRST.toISOString(),
        repeatAt: iso(weekly(1)),
        platforms: ["instagram"],
        instagramMetadata: { placement: "story" },
      }),
    ).toBe("A Story cannot repeat.");
  });

  it("creates the whole series in one helper call: same files, captions, targets and options, one series id", async () => {
    const repeats = weekly(3);
    const response = await POST(
      jsonRequest({
        media: [photo(1), { ...photo(2), altText: "Two boards." }],
        baseCaption: "Book your lesson",
        perPlatformOverrides: { x: "Book now" },
        platforms: ["x", "instagram"],
        googleMetadata: null,
        scheduledFor: FIRST.toISOString(),
        repeatAt: iso(repeats),
      }),
    );
    const body = (await response.json()) as { message: string; series?: { id: string; count: number } };

    expect(response.status).toBe(200);
    expect(createPostJobOnlyMock).toHaveBeenCalledTimes(1);
    const args = createPostJobOnlyMock.mock.calls[0][0];
    expect(args).toMatchObject({
      intent: "scheduled",
      scheduledFor: FIRST,
      baseCaption: "Book your lesson",
      perPlatformOverrides: { x: "Book now" },
      targetPlatforms: ["x", "instagram"],
      extraMedia: [expect.objectContaining({ altText: "Two boards." })],
      series: { seriesId: expect.any(String), times: [FIRST, ...repeats] },
    });
    expect(args.series).not.toHaveProperty("submittedForApprovalAt");
    expect(body.series).toEqual({ id: args.series.seriesId, count: 4 });
    expect(body.message).toBe("4 posts scheduled.");
    expect(inngestSendMock).not.toHaveBeenCalled();
  });

  it("a reused file makes a series too", async () => {
    const response = await POST(
      jsonRequest({
        mediaItemId: "media-9",
        baseCaption: "hi",
        scheduledFor: FIRST.toISOString(),
        repeatAt: iso(weekly(1)),
      }),
    );
    expect(response.status).toBe(200);
    expect(createPostJobForExistingMediaMock.mock.calls[0][0].series.times).toEqual([FIRST, ...weekly(1)]);
  });

  it("a post without repeatAt passes no series", async () => {
    await POST(jsonRequest({ ...photo(1), baseCaption: "hi", scheduledFor: FIRST.toISOString() }));
    expect(createPostJobOnlyMock.mock.calls[0][0]).not.toHaveProperty("series");
  });

  it("checks every date's daily limit; a limit on the fifth date creates nothing and names the date", async () => {
    const repeats = weekly(5);
    const fifth = repeats[3];
    const SENTENCE = "That day already has 20 posts, which is this workspace's daily limit. Pick another day.";
    checkDailyPostLimitMock.mockImplementation(({ day }: { day: Date }) =>
      Promise.resolve(
        day.getTime() === fifth.getTime() ? { error: SENTENCE, code: "WORKSPACE_DAILY_POST_LIMIT" } : null,
      ),
    );

    const response = await POST(
      jsonRequest({ ...photo(1), baseCaption: "hi", scheduledFor: FIRST.toISOString(), repeatAt: iso(repeats) }),
    );
    const body = (await response.json()) as { error: string; code: string; date: string };

    expect(response.status).toBe(429);
    expect(checkDailyPostLimitMock).toHaveBeenCalledTimes(5);
    for (const call of checkDailyPostLimitMock.mock.calls) expect(call[0].mode).toBe("schedule");
    const label = fifth.toLocaleDateString("en-US", {
      timeZone: "UTC",
      weekday: "long",
      month: "long",
      day: "numeric",
      year: "numeric",
    });
    expect(body.error).toBe(`The post on ${label} (UTC) can't be scheduled. ${SENTENCE}`);
    expect(body.code).toBe("WORKSPACE_DAILY_POST_LIMIT");
    expect(body.date).toBe(fifth.toISOString());
    // 11 polish: the limit's own sentence, so the Create page can name the date in the viewer's zone.
    expect((body as unknown as { reason: string }).reason).toBe(SENTENCE);
    expect(createPostJobOnlyMock).not.toHaveBeenCalled();
  });

  it("a member under approval: every post held in the same transaction, and one approval email", async () => {
    getWorkspaceContextMock.mockResolvedValue(makeWorkspaceContext({ role: "member", requireApproval: true }));

    const response = await POST(
      jsonRequest({ ...photo(1), baseCaption: "hi", scheduledFor: FIRST.toISOString(), repeatAt: iso(weekly(3)) }),
    );
    const body = (await response.json()) as { awaitingApproval?: boolean; message: string };

    expect(response.status).toBe(200);
    const args = createPostJobOnlyMock.mock.calls[0][0];
    expect(args.intent).toBe("draft");
    expect(args.series).toEqual({
      seriesId: expect.any(String),
      times: [FIRST, ...weekly(3)],
      submittedForApprovalAt: expect.any(Date),
    });
    // The hold is written with the posts, not by a second update afterwards.
    expect(postJobUpdateMock).not.toHaveBeenCalled();
    expect(checkDailyPostLimitMock).not.toHaveBeenCalled();
    expect(notifyOwnersMock).toHaveBeenCalledTimes(1);
    // 11 polish: the one email says the post repeats.
    expect(notifyOwnersMock.mock.calls[0][0].series).toEqual({
      count: 4,
      first: FIRST,
      last: weekly(3)[2],
    });
    expect(body.awaitingApproval).toBe(true);
    expect(body.message).toBe("Sent for approval: 4 posts. An owner will review each one before it publishes.");
  });
});

// 11 polish: a series counts its own earlier posts on the same UTC day.
describe("POST /api/posts - repeat, posts of one request on the same day", () => {
  const BLOB = "https://test.public.blob.vercel-storage.com/x";
  // 00:30 and 23:40 UTC on one day are 23 hours 10 minutes apart.
  const DAY = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const EARLY = new Date(`${DAY}T00:30:00.000Z`);
  const LATE = new Date(`${DAY}T23:40:00.000Z`);
  const NEXT_DAY = new Date(LATE.getTime() + 24 * 60 * 60 * 1000);

  beforeEach(() => {
    createPostJobOnlyMock.mockResolvedValue({ postJobId: "job-1", postJobIds: ["job-1", "job-2"], mediaItemId: "media-1", resultIds: [] });
    // The day holds the limit minus one: refused only when the request adds another.
    checkDailyPostLimitMock.mockImplementation(({ alsoOnDay }: { alsoOnDay?: number }) =>
      Promise.resolve((alsoOnDay ?? 0) >= 1 ? { error: "Full.", code: "WORKSPACE_DAILY_POST_LIMIT" } : null),
    );
  });

  it("two occurrences on a day at the limit minus one: refused, naming the second", async () => {
    const response = await POST(
      jsonRequest({ blobUrl: BLOB, baseCaption: "hi", scheduledFor: EARLY.toISOString(), repeatAt: [LATE.toISOString()] }),
    );
    const body = (await response.json()) as { date: string };

    expect(response.status).toBe(429);
    expect(checkDailyPostLimitMock.mock.calls.map((c) => c[0].alsoOnDay)).toEqual([0, 1]);
    expect(body.date).toBe(LATE.toISOString());
    expect(createPostJobOnlyMock).not.toHaveBeenCalled();
  });

  it("occurrences on different days count only the stored posts", async () => {
    const response = await POST(
      jsonRequest({ blobUrl: BLOB, baseCaption: "hi", scheduledFor: LATE.toISOString(), repeatAt: [NEXT_DAY.toISOString()] }),
    );

    expect(response.status).toBe(200);
    expect(checkDailyPostLimitMock.mock.calls.map((c) => c[0].alsoOnDay)).toEqual([0, 0]);
  });

  it("a single post is checked as before, with nothing else on the day", async () => {
    const response = await POST(jsonRequest({ blobUrl: BLOB, baseCaption: "hi", scheduledFor: EARLY.toISOString() }));

    expect(response.status).toBe(200);
    expect(checkDailyPostLimitMock.mock.calls[0][0]).not.toHaveProperty("alsoOnDay");
  });
});

// V1 (2026-11-14): a video's cover rides the create call onto the job.
describe("POST /api/posts — a video's cover", () => {
  const VIDEO = {
    blobUrl: "https://test.public.blob.vercel-storage.com/vid.mp4",
    filename: "vid.mp4",
    mimeType: "video/mp4",
    sizeBytes: 123,
    baseCaption: "hello",
  };
  const COVER_URL = "https://test.public.blob.vercel-storage.com/covers/ws-1/1-a-cover.jpg";

  beforeEach(() => {
    createPostJobOnlyMock.mockResolvedValue({ postJobId: "job-1", mediaItemId: "media-1", resultIds: ["r1"] });
    createPostJobForExistingMediaMock.mockResolvedValue({ postJobId: "job-2", mediaItemId: "media-9", resultIds: ["r1"] });
  });

  it("passes a frame and its captured image to the create helper", async () => {
    const response = await POST(
      jsonRequest({ ...VIDEO, cover: { timeMs: 1500, imageUrl: COVER_URL, mimeType: "image/jpeg", sizeBytes: 900 } }),
    );
    expect(response.status).toBe(200);
    expect(createPostJobOnlyMock.mock.calls[0][0].cover).toEqual({ timeMs: 1500, imageUrl: COVER_URL });
  });

  it("passes a cover on the reuse path", async () => {
    const response = await POST(jsonRequest({ mediaItemId: "media-9", baseCaption: "hi", cover: { timeMs: 40 } }));
    expect(response.status).toBe(200);
    expect(createPostJobForExistingMediaMock.mock.calls[0][0].cover).toEqual({ timeMs: 40 });
  });

  it("no cover: the helper gets no cover field", async () => {
    await POST(jsonRequest(VIDEO));
    expect(createPostJobOnlyMock.mock.calls[0][0]).not.toHaveProperty("cover");
  });

  it("refuses a PNG cover, and a cover on a photo, before anything is written", async () => {
    const png = await POST(
      jsonRequest({ ...VIDEO, cover: { imageUrl: COVER_URL, mimeType: "image/png", sizeBytes: 900 } }),
    );
    expect(png.status).toBe(400);
    expect(await png.json()).toEqual({ error: "The cover must be a JPEG image of 8 MB or less." });

    const photo = await POST(
      jsonRequest({ ...VIDEO, filename: "p.jpg", mimeType: "image/jpeg", cover: { timeMs: 0 } }),
    );
    expect(photo.status).toBe(400);
    expect(createPostJobOnlyMock).not.toHaveBeenCalled();
  });

  it("refuses another workspace's cover image (fix round 1)", async () => {
    const response = await POST(
      jsonRequest({
        ...VIDEO,
        cover: {
          imageUrl: "https://test.public.blob.vercel-storage.com/covers/ws-2/1-a-cover.jpg",
          mimeType: "image/jpeg",
          sizeBytes: 9,
        },
      }),
    );
    expect(response.status).toBe(400);
    expect(createPostJobOnlyMock).not.toHaveBeenCalled();
  });

  it("R3-security M1: refuses a cover whose stored file is not a JPEG image, whatever the request said", async () => {
    const request = jsonRequest({ ...VIDEO, cover: { imageUrl: COVER_URL, mimeType: "image/jpeg", sizeBytes: 900 } });
    storedFiles.set(COVER_URL, { size: 300 * 1024 * 1024, contentType: "video/mp4" });

    const response = await POST(request);

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "The cover must be a JPEG image of 8 MB or less." });
    expect(headMock).toHaveBeenCalledWith(COVER_URL);
    expect(createPostJobOnlyMock).not.toHaveBeenCalled();
  });

  it("R3-security M1: refuses a stored JPEG cover over 8 MB, and one storage cannot find", async () => {
    const big = jsonRequest({ ...VIDEO, cover: { imageUrl: COVER_URL, mimeType: "image/jpeg", sizeBytes: 900 } });
    storedFiles.set(COVER_URL, { size: 9 * 1024 * 1024, contentType: "image/jpeg" });
    expect((await POST(big)).status).toBe(400);

    const missing = jsonRequest({ ...VIDEO, cover: { imageUrl: COVER_URL, mimeType: "image/jpeg", sizeBytes: 900 } });
    storedFiles.delete(COVER_URL);
    const response = await POST(missing);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "Couldn't find the cover image in storage. Choose the cover again and post once more.",
    });
    expect(createPostJobOnlyMock).not.toHaveBeenCalled();
  });

  it("refuses a cover image that is not in the app's storage", async () => {
    const response = await POST(
      jsonRequest({ ...VIDEO, cover: { imageUrl: "https://evil.example.com/c.jpg", mimeType: "image/jpeg", sizeBytes: 9 } }),
    );
    expect(response.status).toBe(400);
    expect(createPostJobOnlyMock).not.toHaveBeenCalled();
  });
});

// Q1 (2026-11-14): "Feed and Story" makes the main post plus a Story job, in
// the one create-helper call (so in its one transaction).
describe("POST /api/posts - Feed and Story (both)", () => {
  const HOST = "https://test.public.blob.vercel-storage.com";
  const photo = (n: number) => ({
    blobUrl: `${HOST}/p${n}.jpg`,
    filename: `p${n}.jpg`,
    mimeType: "image/jpeg",
    sizeBytes: 100 + n,
  });
  const BOTH = { placement: "both" };
  const STORY = { placement: "story" };
  const LATER = new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString();

  beforeEach(() => {
    createPostJobOnlyMock.mockResolvedValue({
      postJobId: "job-1",
      storyPostJobId: "job-s",
      mediaItemId: "media-1",
      resultIds: ["r1"],
    });
    createPostJobForExistingMediaMock.mockResolvedValue({
      postJobId: "job-1",
      storyPostJobId: "job-s",
      mediaItemId: "media-9",
      resultIds: [],
    });
  });

  it("Instagram both (upload, now): a feed main job for every platform and a Story job for Instagram, one call", async () => {
    const response = await POST(
      jsonRequest({ ...photo(1), baseCaption: "hi", location: "Miami", platforms: ["instagram", "x"], instagramMetadata: BOTH }),
    );
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(createPostJobOnlyMock).toHaveBeenCalledTimes(1);
    const args = createPostJobOnlyMock.mock.calls[0][0];
    expect(args).not.toHaveProperty("instagramMetadata");
    expect(args).not.toHaveProperty("facebookMetadata");
    expect(args).toMatchObject({
      targetPlatforms: ["instagram", "x"],
      intent: "immediate",
      story: { targetPlatforms: ["instagram"], instagramMetadata: STORY },
    });
    expect(args.story).not.toHaveProperty("facebookMetadata");
    // Both events in one send, so either both start or neither does.
    expect(inngestSendMock).toHaveBeenCalledTimes(1);
    const [main, story] = inngestSendMock.mock.calls[0][0] as { id: string; data: Record<string, unknown> }[];
    expect(main.data).toMatchObject({ postJobId: "job-1" });
    expect(main.data).not.toHaveProperty("location");
    expect(story.data).not.toHaveProperty("location");
    expect(main.data).not.toHaveProperty("instagramMetadata");
    expect(story.id).toBe("publish-job-s");
    expect(story.data).toMatchObject({
      postJobId: "job-s",
      mediaItemId: "media-1",
      baseCaption: "hi",
      instagramMetadata: STORY,
      immediate: true,
    });
    expect(body.storyPostJobId).toBe("job-s");
    expect(body.postJob).toBeDefined();
    expect(body.message).toBeDefined();
  });

  it("Facebook both (Media reuse, draft): a Story job for Facebook, both drafts", async () => {
    const response = await POST(
      jsonRequest({ mediaItemId: "media-9", baseCaption: "hi", draft: true, platforms: ["facebook_page"], facebookMetadata: BOTH }),
    );

    expect(response.status).toBe(200);
    const args = createPostJobForExistingMediaMock.mock.calls[0][0];
    expect(args).toMatchObject({
      intent: "draft",
      story: { targetPlatforms: ["facebook_page"], facebookMetadata: STORY },
    });
    expect(args).not.toHaveProperty("facebookMetadata");
    expect(inngestSendMock).not.toHaveBeenCalled();
    expect(((await response.json()) as { storyPostJobId?: string }).storyPostJobId).toBe("job-s");
  });

  it("both on both platforms: one Story job with both", async () => {
    await POST(
      jsonRequest({
        ...photo(1),
        baseCaption: "hi",
        scheduledFor: LATER,
        platforms: ["instagram", "facebook_page"],
        instagramMetadata: BOTH,
        facebookMetadata: BOTH,
      }),
    );

    const args = createPostJobOnlyMock.mock.calls[0][0];
    expect(args.story).toEqual({
      targetPlatforms: ["instagram", "facebook_page"],
      instagramMetadata: STORY,
      facebookMetadata: STORY,
    });
    expect(args).not.toHaveProperty("instagramMetadata");
    expect(args).not.toHaveProperty("facebookMetadata");
  });

  it("Instagram both + Facebook Story: main has the Facebook Story, the Story job Instagram only", async () => {
    await POST(
      jsonRequest({
        ...photo(1),
        baseCaption: "hi",
        platforms: ["instagram", "facebook_page"],
        instagramMetadata: BOTH,
        facebookMetadata: STORY,
      }),
    );

    const args = createPostJobOnlyMock.mock.calls[0][0];
    expect(args.facebookMetadata).toEqual(STORY);
    expect(args).not.toHaveProperty("instagramMetadata");
    expect(args.story).toEqual({ targetPlatforms: ["instagram"], instagramMetadata: STORY });
    const [main, story] = inngestSendMock.mock.calls[0][0] as { data: Record<string, unknown> }[];
    expect(main.data.facebookMetadata).toEqual(STORY);
    expect(story.data).toMatchObject({ instagramMetadata: STORY });
    expect(story.data).not.toHaveProperty("facebookMetadata");
  });

  it("ignores both for a platform the post does not target", async () => {
    const response = await POST(
      jsonRequest({ ...photo(1), baseCaption: "hi", platforms: ["x"], instagramMetadata: BOTH }),
    );
    expect(response.status).toBe(200);
    expect(createPostJobOnlyMock.mock.calls[0][0]).not.toHaveProperty("story");
  });

  it("refuses both with two photos, with the Story sentence, and creates nothing", async () => {
    const response = await POST(
      jsonRequest({ media: [photo(1), photo(2)], baseCaption: "hi", platforms: ["instagram"], instagramMetadata: BOTH }),
    );
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toBe(
      "A Story takes one photo or video. Choose Feed for Instagram, or remove the extra photos.",
    );
    expect(createPostJobOnlyMock).not.toHaveBeenCalled();
    expect(inngestSendMock).not.toHaveBeenCalled();
  });

  it("refuses both that repeats, with the Story sentence, and creates nothing", async () => {
    const first = new Date(Date.now() + 2 * 60 * 60 * 1000);
    const response = await POST(
      jsonRequest({
        ...photo(1),
        baseCaption: "hi",
        platforms: ["facebook_page"],
        facebookMetadata: BOTH,
        scheduledFor: first.toISOString(),
        repeatAt: [new Date(first.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString()],
      }),
    );
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toBe("A Story cannot repeat.");
    expect(createPostJobOnlyMock).not.toHaveBeenCalled();
  });

  it("a member's scheduled both: both jobs held inside the create call, one email that names the Story", async () => {
    getWorkspaceContextMock.mockResolvedValue(makeWorkspaceContext({ role: "member", requireApproval: true }));
    const response = await POST(
      jsonRequest({ ...photo(1), baseCaption: "hi", scheduledFor: LATER, platforms: ["instagram"], instagramMetadata: BOTH }),
    );
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(createPostJobOnlyMock.mock.calls[0][0]).toMatchObject({
      intent: "draft",
      approvalHold: { submittedForApprovalAt: expect.any(Date), scheduledFor: new Date(LATER) },
    });
    // The hold is in the create transaction: nothing is written after it.
    expect(postJobUpdateMock).not.toHaveBeenCalled();
    expect(notifyOwnersMock).toHaveBeenCalledTimes(1);
    expect(notifyOwnersMock).toHaveBeenCalledWith(expect.objectContaining({ alsoAsStory: ["instagram"] }));
    expect(inngestSendMock).not.toHaveBeenCalled();
    expect(body).toMatchObject({ awaitingApproval: true, storyPostJobId: "job-s" });
  });

  it("a member's draft both (reuse): two plain drafts, no hold and no email, as a single draft is today", async () => {
    getWorkspaceContextMock.mockResolvedValue(makeWorkspaceContext({ role: "member", requireApproval: true }));
    const response = await POST(
      jsonRequest({
        mediaItemId: "media-9",
        baseCaption: "hi",
        draft: true,
        platforms: ["instagram", "facebook_page"],
        instagramMetadata: BOTH,
        facebookMetadata: BOTH,
      }),
    );

    expect(response.status).toBe(200);
    // shouldHoldForApproval: a member's own draft is not held; it is held
    // when they submit it, through the publish route, one job at a time.
    const args = createPostJobForExistingMediaMock.mock.calls[0][0];
    expect(args).toMatchObject({ intent: "draft" });
    expect(args).not.toHaveProperty("approvalHold");
    expect(postJobUpdateMock).not.toHaveBeenCalled();
    expect(notifyOwnersMock).not.toHaveBeenCalled();
  });

  it("a member's Post now both: both held with no time, the email names both Stories", async () => {
    getWorkspaceContextMock.mockResolvedValue(makeWorkspaceContext({ role: "member", requireApproval: true }));
    await POST(
      jsonRequest({
        ...photo(1),
        baseCaption: "hi",
        platforms: ["instagram", "facebook_page"],
        instagramMetadata: BOTH,
        facebookMetadata: BOTH,
      }),
    );

    expect(createPostJobOnlyMock.mock.calls[0][0]).toMatchObject({
      intent: "draft",
      approvalHold: { submittedForApprovalAt: expect.any(Date), scheduledFor: null },
    });
    expect(postJobUpdateMock).not.toHaveBeenCalled();
    expect(inngestSendMock).not.toHaveBeenCalled();
    expect(notifyOwnersMock).toHaveBeenCalledWith(
      expect.objectContaining({ alsoAsStory: ["instagram", "facebook_page"] }),
    );
  });

  it("a member's both whose held write fails: nothing created, a 500, no email", async () => {
    getWorkspaceContextMock.mockResolvedValue(makeWorkspaceContext({ role: "member", requireApproval: true }));
    createPostJobOnlyMock.mockRejectedValue(new Error("db down"));
    const response = await POST(
      jsonRequest({ ...photo(1), baseCaption: "hi", scheduledFor: LATER, platforms: ["instagram"], instagramMetadata: BOTH }),
    );

    expect(response.status).toBe(500);
    expect(postJobUpdateMock).not.toHaveBeenCalled();
    expect(notifyOwnersMock).not.toHaveBeenCalled();
    expect(inngestSendMock).not.toHaveBeenCalled();
  });

  it("an owner's both: no hold", async () => {
    await POST(
      jsonRequest({ ...photo(1), baseCaption: "hi", scheduledFor: LATER, platforms: ["instagram"], instagramMetadata: BOTH }),
    );
    expect(createPostJobOnlyMock.mock.calls[0][0]).not.toHaveProperty("approvalHold");
    expect(postJobUpdateMock).not.toHaveBeenCalled();
    expect(notifyOwnersMock).not.toHaveBeenCalled();
  });

  it("a member's single post (no both): held in the create call like a pair, email without a Story line", async () => {
    getWorkspaceContextMock.mockResolvedValue(makeWorkspaceContext({ role: "member", requireApproval: true }));
    createPostJobOnlyMock.mockResolvedValue({ postJobId: "job-1", mediaItemId: "media-1", resultIds: [] });
    await POST(
      jsonRequest({ ...photo(1), baseCaption: "hi", scheduledFor: LATER, platforms: ["instagram"], instagramMetadata: STORY }),
    );

    expect(createPostJobOnlyMock.mock.calls[0][0]).toMatchObject({
      approvalHold: { submittedForApprovalAt: expect.any(Date), scheduledFor: new Date(LATER) },
    });
    expect(createPostJobOnlyMock.mock.calls[0][0]).not.toHaveProperty("story");
    expect(postJobUpdateMock).not.toHaveBeenCalled();
    expect(notifyOwnersMock.mock.calls[0][0]).not.toHaveProperty("alsoAsStory");
  });

  it("the daily limit counts the Story job as a post", async () => {
    await POST(jsonRequest({ ...photo(1), baseCaption: "hi", platforms: ["instagram"], instagramMetadata: BOTH }));
    expect(checkDailyPostLimitMock).toHaveBeenCalledWith(expect.objectContaining({ mode: "now", alsoOnDay: 1, runsAlsoOnDay: 1 }));
    expect(storyCanSendMock).toHaveBeenCalledWith({
      workspaceId: expect.any(String),
      story: expect.objectContaining({ targetPlatforms: ["instagram"] }),
      targetPlatforms: ["instagram"],
    });
  });

  // R8-publishing L2: a Story with nothing to send makes no run, so it is not counted.
  it("Post now: a Story that could not send is not counted; a scheduled one always is", async () => {
    storyCanSendMock.mockResolvedValue(false);
    await POST(jsonRequest({ ...photo(1), baseCaption: "hi", platforms: ["instagram"], instagramMetadata: BOTH }));
    // Still a post that day for the workspace's own limit; no run for the limits across workspaces.
    expect(checkDailyPostLimitMock.mock.calls[0][0]).toMatchObject({ mode: "now", alsoOnDay: 1, runsAlsoOnDay: 0 });

    checkDailyPostLimitMock.mockClear();
    storyCanSendMock.mockClear();
    await POST(
      jsonRequest({ ...photo(1), baseCaption: "hi", scheduledFor: LATER, platforms: ["instagram"], instagramMetadata: BOTH }),
    );
    expect(checkDailyPostLimitMock).toHaveBeenCalledWith(expect.objectContaining({ mode: "schedule", alsoOnDay: 1 }));
    expect(checkDailyPostLimitMock.mock.calls[0][0]).not.toHaveProperty("runsAlsoOnDay");
    expect(storyCanSendMock).not.toHaveBeenCalled();
  });

  it("a full day refuses both with a 429 and creates nothing", async () => {
    checkDailyPostLimitMock.mockResolvedValue({ error: "Full today.", code: "DAILY_POST_LIMIT" });
    const response = await POST(
      jsonRequest({ ...photo(1), baseCaption: "hi", scheduledFor: LATER, platforms: ["instagram"], instagramMetadata: BOTH }),
    );
    expect(response.status).toBe(429);
    expect(checkDailyPostLimitMock).toHaveBeenCalledWith(expect.objectContaining({ mode: "schedule", alsoOnDay: 1 }));
    expect(createPostJobOnlyMock).not.toHaveBeenCalled();
  });

  it("no both anywhere: today's single job, limit check and response", async () => {
    createPostJobOnlyMock.mockResolvedValue({ postJobId: "job-1", mediaItemId: "media-1", resultIds: ["r1"] });
    const response = await POST(
      jsonRequest({ ...photo(1), baseCaption: "hi", platforms: ["instagram"], instagramMetadata: STORY }),
    );
    const body = (await response.json()) as Record<string, unknown>;

    expect(createPostJobOnlyMock.mock.calls[0][0]).not.toHaveProperty("story");
    expect(checkDailyPostLimitMock.mock.calls[0][0]).not.toHaveProperty("alsoOnDay");
    // One event object, not a list, as before.
    expect(Array.isArray(inngestSendMock.mock.calls[0][0])).toBe(false);
    expect(body).not.toHaveProperty("storyPostJobId");
  });

  it("a Post now with no reachable Story platform: the helper made no Story job, so none is sent or named", async () => {
    createPostJobOnlyMock.mockResolvedValue({ postJobId: "job-1", mediaItemId: "media-1", resultIds: ["r1"] });
    const response = await POST(
      jsonRequest({ ...photo(1), baseCaption: "hi", platforms: ["instagram", "x"], instagramMetadata: BOTH }),
    );
    expect(Array.isArray(inngestSendMock.mock.calls[0][0])).toBe(false);
    expect((await response.json()) as Record<string, unknown>).not.toHaveProperty("storyPostJobId");
  });

  it("when the events cannot be sent, both jobs' results are failed", async () => {
    inngestSendMock.mockRejectedValue(new Error("inngest down"));
    const response = await POST(
      jsonRequest({ ...photo(1), baseCaption: "hi", platforms: ["instagram"], instagramMetadata: BOTH }),
    );
    expect(response.status).toBe(503);
    expect(failPendingMock.mock.calls.map((c) => c[0])).toEqual(["job-1", "job-s"]);
  });
});

describe("POST /api/posts — a new file's size and type come from storage (F5)", () => {
  const URL_1 = "https://test.public.blob.vercel-storage.com/1731600000000-abc-vid.mp4";

  beforeEach(() => {
    createPostJobOnlyMock.mockResolvedValue({ postJobId: "job-1", mediaItemId: "media-1", resultIds: ["r1"] });
  });

  it("stores 500 MB for a file the request called 1 byte", async () => {
    const body = jsonRequest({ blobUrl: URL_1, mimeType: "video/mp4", sizeBytes: 1, baseCaption: "hi" });
    headMock.mockReset();
    headMock.mockResolvedValue({ size: 500 * 1024 * 1024, contentType: "video/mp4" });

    const response = await POST(body);

    expect(response.status).toBe(200);
    expect(headMock).toHaveBeenCalledWith(URL_1);
    expect(createPostJobOnlyMock.mock.calls[0][0].media).toMatchObject({
      sizeBytes: 500 * 1024 * 1024,
      mimeType: "video/mp4",
    });
  });

  it("takes the stored type as the truth: the browser's image/jpg is stored as image/jpeg", async () => {
    const url = "https://test.public.blob.vercel-storage.com/1731600000000-abc-a.jpg";
    const body = jsonRequest({ blobUrl: url, mimeType: "image/jpg", sizeBytes: 10, baseCaption: "hi" });
    headMock.mockReset();
    headMock.mockResolvedValue({ size: 10, contentType: "image/jpeg" });

    const response = await POST(body);

    expect(response.status).toBe(200);
    expect(createPostJobOnlyMock.mock.calls[0][0].media).toMatchObject({ mimeType: "image/jpeg", sizeBytes: 10 });
  });

  it("accepts photos the browser called image/jpg in a several-photo post, stored as image/jpeg", async () => {
    const photo = (n: number) => ({
      blobUrl: `https://test.public.blob.vercel-storage.com/1731600000000-abc-p${n}.jpg`,
      mimeType: "image/jpg",
      sizeBytes: 1,
    });
    const body = jsonRequest({ media: [photo(1), photo(2)], baseCaption: "hi" });
    headMock.mockReset();
    headMock.mockResolvedValue({ size: 2_000, contentType: "image/jpeg" });

    const response = await POST(body);

    expect(response.status).toBe(200);
    const args = createPostJobOnlyMock.mock.calls[0][0];
    expect(args.media).toMatchObject({ mimeType: "image/jpeg" });
    expect(args.extraMedia).toEqual([expect.objectContaining({ mimeType: "image/jpeg" })]);
  });

  it("checks the post's rules against the stored types: a video stored among photos is refused", async () => {
    const photo = (n: number) => ({
      blobUrl: `https://test.public.blob.vercel-storage.com/1731600000000-abc-p${n}.jpg`,
      mimeType: "image/jpeg",
      sizeBytes: 1,
    });
    const body = jsonRequest({ media: [photo(1), photo(2)], baseCaption: "hi" });
    headMock.mockReset();
    headMock.mockImplementation(async (url: string) => ({
      size: 2_000,
      contentType: url.endsWith("p2.jpg") ? "video/mp4" : "image/jpeg",
    }));

    const response = await POST(body);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "A post with several files can only contain photos. Post a video on its own.",
    });
    expect(createPostJobOnlyMock).not.toHaveBeenCalled();
  });

  it("refuses a file stored as a type uploads do not allow, and creates nothing", async () => {
    const body = jsonRequest({ blobUrl: URL_1, mimeType: "video/mp4", sizeBytes: 10, baseCaption: "hi" });
    headMock.mockReset();
    headMock.mockResolvedValue({ size: 10, contentType: "application/pdf" });

    const response = await POST(body);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Only photos and videos can be added." });
    expect(createPostJobOnlyMock).not.toHaveBeenCalled();
  });

  it("refuses with a plain sentence when storage cannot read the file, and creates nothing", async () => {
    const body = jsonRequest({ blobUrl: URL_1, mimeType: "video/mp4", sizeBytes: 10, baseCaption: "hi" });
    headMock.mockReset();
    headMock.mockRejectedValue(new Error("not found"));

    const response = await POST(body);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Couldn't find this file in storage. Upload it again.",
    });
    expect(createPostJobOnlyMock).not.toHaveBeenCalled();
  });

  it("checks every file of a several-photo post, naming the one storage cannot read", async () => {
    const photo = (n: number) => ({
      blobUrl: `https://test.public.blob.vercel-storage.com/1731600000000-abc-p${n}.jpg`,
      mimeType: "image/jpeg",
      sizeBytes: 1,
    });
    const body = jsonRequest({ media: [photo(1), photo(2), photo(3)], baseCaption: "hi" });
    headMock.mockReset();
    headMock.mockImplementation(async (url: string) => {
      if (url.endsWith("p3.jpg")) throw new Error("not found");
      return { size: 2_000_000, contentType: "image/jpeg" };
    });

    const response = await POST(body);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "File 3: Couldn't find this file in storage. Upload it again.",
    });
    expect(createPostJobOnlyMock).not.toHaveBeenCalled();
  });

  it("stores each photo's stored size in a several-photo post", async () => {
    const photo = (n: number) => ({
      blobUrl: `https://test.public.blob.vercel-storage.com/1731600000000-abc-p${n}.jpg`,
      mimeType: "image/jpeg",
      sizeBytes: 1,
    });
    const body = jsonRequest({ media: [photo(1), photo(2)], baseCaption: "hi" });
    headMock.mockReset();
    headMock.mockImplementation(async (url: string) => ({
      size: url.endsWith("p1.jpg") ? 3_000_000 : 4_000_000,
      contentType: "image/jpeg",
    }));

    const response = await POST(body);

    expect(response.status).toBe(200);
    const args = createPostJobOnlyMock.mock.calls[0][0];
    expect(args.media).toMatchObject({ sizeBytes: 3_000_000 });
    expect(args.extraMedia).toEqual([expect.objectContaining({ sizeBytes: 4_000_000 })]);
  });
});

// G1 review: a "Post now" whose chosen platforms failed when it was created
// (connection needs reconnecting, or is gone) says which, so Create can warn.
describe("POST /api/posts - platforms not sent at creation", () => {
  const HOST = "https://test.public.blob.vercel-storage.com";
  const failedRow = (postJobId: string, platform: string, errorCode: string, errorMessage: string) => ({
    id: `r-${postJobId}-${platform}`,
    postJobId,
    platform,
    status: "failed",
    errorCode,
    errorMessage,
  });
  const pendingRow = (postJobId: string, platform: string) => ({
    id: `r-${postJobId}-${platform}`,
    postJobId,
    platform,
    status: "pending",
    errorCode: null,
    errorMessage: null,
  });
  const post = (extra: Record<string, unknown> = {}) =>
    POST(jsonRequest({ blobUrl: `${HOST}/p.jpg`, filename: "p.jpg", mimeType: "image/jpeg", sizeBytes: 100, baseCaption: "hi", ...extra }));

  beforeEach(() => {
    createPostJobOnlyMock.mockResolvedValue({ postJobId: "job-1", mediaItemId: "media-1", resultIds: ["r1"] });
  });

  it("every platform dead: allFailed with each platform's sentence", async () => {
    postJobResultFindManyMock.mockResolvedValue([
      failedRow("job-1", "x", "RECONNECT_REQUIRED", "Reconnect X in Settings, then retry."),
    ]);

    const body = (await (await post({ platforms: ["x"] })).json()) as Record<string, unknown>;

    expect(body.allFailed).toBe(true);
    expect(body.notSent).toEqual([
      { platform: "x", reason: "RECONNECT_REQUIRED", message: "Reconnect X in Settings, then retry." },
    ]);
    expect(body.message).toBe("Nothing was sent: Reconnect X in Settings, then use Retry in Activity.");
    expect(body.notSentText).toBe("Nothing was sent: Reconnect X in Settings, then use Retry in Activity.");
  });

  // R10-client-journey L1: a member can't reconnect, so their answer names the owner.
  it("a member's Post now with every platform dead: the owner's step, not Settings", async () => {
    getWorkspaceContextMock.mockResolvedValue(makeWorkspaceContext({ role: "member", requireApproval: false }));
    postJobResultFindManyMock.mockResolvedValue([
      failedRow("job-1", "x", "RECONNECT_REQUIRED", "Reconnect X in Settings, then retry."),
    ]);

    const body = (await (await post({ platforms: ["x"] })).json()) as Record<string, unknown>;

    expect(body.allFailed).toBe(true);
    expect(body.notSent).toEqual([
      { platform: "x", reason: "RECONNECT_REQUIRED", message: "The workspace owner can reconnect X; then retry." },
    ]);
    expect(body.message).toBe("Nothing was sent: The workspace owner can reconnect X; then use Retry in Activity.");
    expect(body.notSentText).toBe("Nothing was sent: The workspace owner can reconnect X; then use Retry in Activity.");
  });

  it("a member's Post now with one platform dead: the not-sent text names the owner", async () => {
    getWorkspaceContextMock.mockResolvedValue(makeWorkspaceContext({ role: "member", requireApproval: false }));
    postJobResultFindManyMock.mockResolvedValue([
      failedRow("job-1", "x", "RECONNECT_REQUIRED", "Reconnect X in Settings, then retry."),
      pendingRow("job-1", "instagram"),
    ]);

    const body = (await (await post({ platforms: ["x", "instagram"] })).json()) as Record<string, unknown>;

    expect(body.notSentText).toBe("Not sent to X: The workspace owner can reconnect X; then use Retry in Activity.");
  });

  it("one dead, one healthy: names the dead one, not allFailed", async () => {
    postJobResultFindManyMock.mockResolvedValue([
      failedRow("job-1", "x", "RECONNECT_REQUIRED", "Reconnect X in Settings, then retry."),
      pendingRow("job-1", "instagram"),
    ]);

    const body = (await (await post({ platforms: ["x", "instagram"] })).json()) as Record<string, unknown>;

    expect(body).not.toHaveProperty("allFailed");
    expect(body.notSent).toEqual([
      { platform: "x", reason: "RECONNECT_REQUIRED", message: "Reconnect X in Settings, then retry." },
    ]);
    expect(body.message).toBe("Publishing in progress. Large videos may take a few minutes.");
  });

  it("Feed and Story with a dead Instagram: the Story job's rows count too, each platform once", async () => {
    createPostJobOnlyMock.mockResolvedValue({
      postJobId: "job-1",
      storyPostJobId: "job-s",
      mediaItemId: "media-1",
      resultIds: ["r1"],
    });
    const gone = "Instagram is no longer connected. Connect it in Settings, then retry.";
    postJobResultFindManyMock.mockImplementation(async (args: { where: { postJobId: string } }) =>
      args.where.postJobId === "job-s"
        ? [failedRow("job-s", "instagram", "CONNECTION_GONE", gone)]
        : [failedRow("job-1", "instagram", "CONNECTION_GONE", gone)],
    );

    const body = (await (
      await post({ platforms: ["instagram"], instagramMetadata: { placement: "both" } })
    ).json()) as Record<string, unknown>;

    expect(postJobResultFindManyMock).toHaveBeenCalledWith({ where: { postJobId: "job-s" } });
    expect(body.allFailed).toBe(true);
    expect(body.notSent).toEqual([{ platform: "instagram", reason: "CONNECTION_GONE", message: gone }]);
  });

  // Review of T1, item 1: the reservation in the create transaction refused, so nothing was created.
  it("a daily limit refusing the reservation: 429 with its sentence, no event, nothing to take back", async () => {
    const { FreeRunRefusedError } = await import("@/server/usage/usageLog");
    const refusal = {
      error: "Vibe Socials has reached its daily limit of posts for the whole service. Schedule this post for another day, or try again tomorrow.",
      code: "SERVICE_DAILY_POST_LIMIT",
    };
    createPostJobOnlyMock.mockRejectedValue(new FreeRunRefusedError(refusal, null));

    const response = await post({ platforms: ["x"] });

    expect(response.status).toBe(429);
    await expect(response.json()).resolves.toEqual(refusal);
    expect(inngestSendMock).not.toHaveBeenCalled();
    expect(withdrawSendMock).not.toHaveBeenCalled();
  });

  // R9-new-customer L2: the limits could not be checked (lock timeout, database error): nothing was created.
  it("today's limits can't be checked: 503 with the try-again sentence, no event, nothing to take back", async () => {
    const { LimitCheckFailedError } = await import("@/server/usage/usageLog");
    createPostJobOnlyMock.mockRejectedValue(new LimitCheckFailedError(new Error("canceling statement due to lock timeout")));

    const response = await post({ platforms: ["x"] });

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "We couldn't check today's limits. Try again in a minute.",
      code: "LIMIT_CHECK_FAILED",
    });
    expect(inngestSendMock).not.toHaveBeenCalled();
    expect(withdrawSendMock).not.toHaveBeenCalled();
  });

  it("healthy: the response is unchanged", async () => {

    postJobResultFindManyMock.mockResolvedValue([pendingRow("job-1", "x")]);

    const body = (await (await post({ platforms: ["x"] })).json()) as Record<string, unknown>;

    expect(body).not.toHaveProperty("allFailed");
    expect(body).not.toHaveProperty("notSent");
    expect(inngestSendMock).toHaveBeenCalledTimes(1);
  });

  // R8-publishing M1: a Post now with nothing it can send starts no publish run.
  it("LinkedIn connected, platforms [x]: no publish event; the failed result and its sentence at once", async () => {
    createPostJobOnlyMock.mockResolvedValue({ postJobId: "job-1", mediaItemId: "media-1", resultIds: ["r1"], unsent: ["job-1"] });
    const gone = "X is no longer connected. Connect it in Settings, then retry.";
    postJobResultFindManyMock.mockResolvedValue([failedRow("job-1", "x", "CONNECTION_GONE", gone)]);

    const response = await post({ platforms: ["x"] });
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(inngestSendMock).not.toHaveBeenCalled();
    expect(failPendingMock).not.toHaveBeenCalled();
    expect(body.allFailed).toBe(true);
    expect(body.notSent).toEqual([{ platform: "x", reason: "CONNECTION_GONE", message: gone }]);
    expect(body.message).toBe("Nothing was sent: Connect X in Settings, then use Retry in Activity.");
  });

  it("Feed and Story, one can send and one cannot: one event, for the one that can (one run)", async () => {
    createPostJobOnlyMock.mockResolvedValue({
      postJobId: "job-1",
      storyPostJobId: "job-s",
      mediaItemId: "media-1",
      resultIds: ["r1"],
      unsent: ["job-s"],
    });
    postJobResultFindManyMock.mockImplementation(async (args: { where: { postJobId: string } }) =>
      args.where.postJobId === "job-s"
        ? [failedRow("job-s", "instagram", "RECONNECT_REQUIRED", "Reconnect Instagram in Settings, then retry.")]
        : [pendingRow("job-1", "facebook_page")],
    );

    await post({ platforms: ["facebook_page", "instagram"], instagramMetadata: { placement: "both" } });

    expect(inngestSendMock).toHaveBeenCalledTimes(1);
    const sent = inngestSendMock.mock.calls[0][0];
    expect(Array.isArray(sent)).toBe(false);
    expect(sent).toMatchObject({ id: "publish-job-1", data: { postJobId: "job-1" } });
  });

  it("Feed and Story, only the Story can send: one event, the Story's", async () => {
    createPostJobOnlyMock.mockResolvedValue({
      postJobId: "job-1",
      storyPostJobId: "job-s",
      mediaItemId: "media-1",
      resultIds: ["r1"],
      unsent: ["job-1"],
    });

    await post({ platforms: ["facebook_page", "instagram"], instagramMetadata: { placement: "both" } });

    expect(inngestSendMock).toHaveBeenCalledTimes(1);
    expect(inngestSendMock.mock.calls[0][0]).toMatchObject({ id: "publish-job-s", data: { postJobId: "job-s" } });
  });
});

// R25 publishing-flow L3: once the create has committed, nothing after it may
// answer 500, or Create keeps the form and a second press posts a second copy.
describe("POST /api/posts - after the create has committed", () => {
  const HOST = "https://test.public.blob.vercel-storage.com";
  const photo = { blobUrl: `${HOST}/p1.jpg`, filename: "p1.jpg", mimeType: "image/jpeg", sizeBytes: 101 };
  const DAY = 24 * 60 * 60 * 1000;
  const LATER = new Date(Date.now() + 3 * 60 * 60 * 1000);
  const blip = () => new Error("database blip");

  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    createPostJobOnlyMock.mockResolvedValue({ postJobId: "job-1", mediaItemId: "media-1", resultIds: ["r1"] });
    createPostJobForExistingMediaMock.mockResolvedValue({ postJobId: "job-1", mediaItemId: "media-9", resultIds: ["r1"] });
  });

  async function send(body: Record<string, unknown>) {
    const response = await POST(jsonRequest({ baseCaption: "hi", ...body }));
    return { response, body: (await response.json()) as Record<string, unknown> };
  }

  it("Post now: the job read after the hand-off fails -> 200 with the postJobId, Create resets the form", async () => {
    postJobFindUniqueMock.mockRejectedValue(blip());
    const { response, body } = await send(photo);

    expect(response.status).toBe(200);
    expect(inngestSendMock).toHaveBeenCalledTimes(1);
    expect(body).toMatchObject({ postJobId: "job-1", postJob: null, results: [] });
    expect(typeof body.message).toBe("string");
    expect(failPendingMock).not.toHaveBeenCalled();
    expect(withdrawSendMock).not.toHaveBeenCalled();
    expect(composerSubmitOutcome({ ok: response.ok, body, mode: "now" })).toMatchObject({
      kind: "success",
      resetForm: true,
    });
  });

  it("Post now: the results read fails -> 200 with the postJobId", async () => {
    postJobResultFindManyMock.mockRejectedValue(blip());
    const { response, body } = await send(photo);

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ postJobId: "job-1" });
    expect(composerSubmitOutcome({ ok: response.ok, body, mode: "now" }).kind).toBe("success");
  });

  it("Post now with nothing it could send: a read failure says so instead of 'in progress'", async () => {
    createPostJobOnlyMock.mockResolvedValue({ postJobId: "job-1", mediaItemId: "media-1", resultIds: ["r1"], unsent: ["job-1"] });
    postJobResultFindManyMock.mockRejectedValue(blip());
    const { response, body } = await send(photo);

    expect(response.status).toBe(200);
    expect(inngestSendMock).not.toHaveBeenCalled();
    expect(body).toMatchObject({ postJobId: "job-1" });
    expect(body.message).not.toMatch(/in progress/);
  });

  it("reuse path: a read failure after the create is a 200 too", async () => {
    postJobFindUniqueMock.mockRejectedValue(blip());
    const { response, body } = await send({ mediaItemId: "media-9" });

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ postJobId: "job-1" });
  });

  it("Feed and Story pair: the Story's results read fails -> 200 with both ids", async () => {
    createPostJobOnlyMock.mockResolvedValue({
      postJobId: "job-1",
      storyPostJobId: "job-s",
      mediaItemId: "media-1",
      resultIds: ["r1"],
    });
    postJobResultFindManyMock.mockImplementation(async (args: { where: { postJobId: string } }) => {
      if (args.where.postJobId === "job-s") throw blip();
      return [];
    });
    const { response, body } = await send({ ...photo, platforms: ["instagram"], instagramMetadata: { placement: "both" } });

    expect(response.status).toBe(200);
    expect(inngestSendMock).toHaveBeenCalledTimes(1);
    expect(body).toMatchObject({ postJobId: "job-1", storyPostJobId: "job-s" });
    expect(composerSubmitOutcome({ ok: response.ok, body, mode: "now" }).kind).toBe("success");
  });

  it("Repeat series: a read failure after the create -> 200 with the series and its count", async () => {
    createPostJobOnlyMock.mockResolvedValue({
      postJobId: "job-1",
      postJobIds: ["job-1", "job-2"],
      mediaItemId: "media-1",
      resultIds: [],
    });
    postJobFindUniqueMock.mockRejectedValue(blip());
    const { response, body } = await send({
      ...photo,
      scheduledFor: LATER.toISOString(),
      repeatAt: [new Date(LATER.getTime() + 7 * DAY).toISOString()],
    });

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ postJobId: "job-1", series: { id: expect.any(String), count: 2 }, message: "2 posts scheduled." });
    expect(composerSubmitOutcome({ ok: response.ok, body, mode: "schedule" }).kind).toBe("success");
  });

  it("a member's held post: a read failure after the create still says it was sent for approval", async () => {
    getWorkspaceContextMock.mockResolvedValue(makeWorkspaceContext({ role: "member", requireApproval: true }));
    postJobFindUniqueMock.mockRejectedValue(blip());
    const { response, body } = await send({ ...photo, scheduledFor: LATER.toISOString() });

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ postJobId: "job-1", awaitingApproval: true });
    expect(notifyOwnersMock).toHaveBeenCalledTimes(1);
    expect(composerSubmitOutcome({ ok: response.ok, body, mode: "schedule" })).toMatchObject({
      kind: "success",
      heldForApproval: true,
    });
  });

  it("a member's single post is held inside the create call on the upload and reuse paths", async () => {
    getWorkspaceContextMock.mockResolvedValue(makeWorkspaceContext({ role: "member", requireApproval: true }));
    await send({ ...photo, scheduledFor: LATER.toISOString() });
    await send({ mediaItemId: "media-9" });

    const hold = (scheduledFor: Date | null) => ({ submittedForApprovalAt: expect.any(Date), scheduledFor });
    expect(createPostJobOnlyMock.mock.calls[0][0]).toMatchObject({ intent: "draft", approvalHold: hold(LATER) });
    expect(createPostJobForExistingMediaMock.mock.calls[0][0]).toMatchObject({ intent: "draft", approvalHold: hold(null) });
    // Nothing is written after the create, so a failed stamp can't leave a plain draft.
    expect(postJobUpdateMock).not.toHaveBeenCalled();
  });

  it("a member's series carries its hold in the series, not a second hold", async () => {
    getWorkspaceContextMock.mockResolvedValue(makeWorkspaceContext({ role: "member", requireApproval: true }));
    await send({
      ...photo,
      scheduledFor: LATER.toISOString(),
      repeatAt: [new Date(LATER.getTime() + 7 * DAY).toISOString()],
    });

    const args = createPostJobOnlyMock.mock.calls[0][0];
    expect(args.series).toMatchObject({ submittedForApprovalAt: expect.any(Date) });
    expect(args).not.toHaveProperty("approvalHold");
  });

  it("a member's held write fails: nothing created, today's 500, no email", async () => {
    getWorkspaceContextMock.mockResolvedValue(makeWorkspaceContext({ role: "member", requireApproval: true }));
    createPostJobOnlyMock.mockRejectedValue(blip());
    const { response, body } = await send({ ...photo, scheduledFor: LATER.toISOString() });

    expect(response.status).toBe(500);
    expect(body).toEqual({ error: "Failed to create post" });
    expect(notifyOwnersMock).not.toHaveBeenCalled();
    expect(postJobUpdateMock).not.toHaveBeenCalled();
  });

  it("a failure before the create commits: today's 500 and no hand-off", async () => {
    createPostJobOnlyMock.mockRejectedValue(blip());
    const { response, body } = await send(photo);

    expect(response.status).toBe(500);
    expect(body).toEqual({ error: "Failed to create post" });
    expect(inngestSendMock).not.toHaveBeenCalled();
    expect(composerSubmitOutcome({ ok: response.ok, body, mode: "now" }).kind).toBe("error");
  });
});
