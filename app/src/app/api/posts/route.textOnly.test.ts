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
  checkDailyPostLimitMock: vi.fn(),
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

// Usage limits (2026-11-10): the count and the email have their own suite
// (workspaceUsage.test.ts); here only where the route checks, and what it answers.
vi.mock("@/server/usage/workspaceUsage", () => ({
  checkDailyPostLimit: checkDailyPostLimitMock,
}));

// The release switch (platformLimits.ts textPostsEnabled): on for the suite
// below, off where a test says so.
const textPosts = vi.hoisted(() => ({ enabled: true }));
vi.mock("@/lib/platformLimits", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/platformLimits")>()),
  textPostsEnabled: () => textPosts.enabled,
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
  checkDailyPostLimitMock.mockReset();
  checkDailyPostLimitMock.mockResolvedValue(null);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// Posts without a photo (2026-11-10): `textOnly: true`.
describe("POST /api/posts - textOnly (a post without a photo)", () => {
  function textRequest(extra: Record<string, unknown> = {}) {
    return jsonRequest({ textOnly: true, baseCaption: "Lessons cancelled today", platforms: ["x"], ...extra });
  }

  beforeEach(() => {
    createPostJobOnlyMock.mockResolvedValue({ postJobId: "job-1", mediaItemId: null, resultIds: ["r1"] });
  });

  it.each([
    ["blobUrl", { blobUrl: "https://test.public.blob.vercel-storage.com/x.jpg" }],
    ["mediaItemId", { mediaItemId: "media-1" }],
    ["media", { media: [] }],
    ["filename", { filename: "x.jpg" }],
    ["mimeType", { mimeType: "image/jpeg" }],
    ["sizeBytes", { sizeBytes: 1 }],
    ["altText", { altText: "a photo" }],
  ])("refuses a file field (%s) with 400 and creates nothing", async (_name, field) => {
    const response = await POST(textRequest(field));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "A post without a photo can't carry a file. Remove textOnly, or remove the file.",
    });
    expect(createPostJobOnlyMock).not.toHaveBeenCalled();
    expect(createPostJobForExistingMediaMock).not.toHaveBeenCalled();
  });

  it.each([[""], ["   \n "], [undefined]])("refuses empty text (%j) with the sentence", async (caption) => {
    const response = await POST(textRequest({ baseCaption: caption }));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Write something to post, or add a photo or video." });
    expect(createPostJobOnlyMock).not.toHaveBeenCalled();
  });

  it("refuses a platform that needs a file, naming it", async () => {
    const response = await POST(textRequest({ platforms: ["x", "instagram"] }));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Instagram needs a photo or video.",
      code: "PLATFORM_NEEDS_MEDIA",
      platforms: ["instagram"],
    });
    expect(createPostJobOnlyMock).not.toHaveBeenCalled();
  });

  it("refuses a Story", async () => {
    const response = await POST(
      textRequest({ platforms: ["facebook_page"], facebookMetadata: { placement: "story" } }),
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "A Story needs a photo or video." });
    expect(createPostJobOnlyMock).not.toHaveBeenCalled();
  });

  it("creates a job with no file and sends a publish event with a null mediaItemId", async () => {
    const googleMetadata = { postType: "update", button: { type: "CALL" } };
    const response = await POST(
      textRequest({ platforms: ["x", "google_business_profile"], googleMetadata }),
    );

    expect(response.status).toBe(200);
    expect(createPostJobOnlyMock).toHaveBeenCalledWith({
      userId: "user-1",
      workspaceId: "ws-1",
      media: null,
      baseCaption: "Lessons cancelled today",
      location: undefined,
      perPlatformOverrides: undefined,
      intent: "immediate",
      scheduledFor: null,
      tiktokMetadata: undefined,
      youtubeMetadata: undefined,
      googleMetadata,
      targetPlatforms: ["x", "google_business_profile"],
    });
    expect(createPostJobForExistingMediaMock).not.toHaveBeenCalled();
    expect(inngestSendMock).toHaveBeenCalledWith({
      id: "publish-job-1",
      name: "post/publish.requested",
      data: expect.objectContaining({
        postJobId: "job-1",
        mediaItemId: null,
        baseCaption: "Lessons cancelled today",
        googleMetadata,
        immediate: true,
      }),
    });
    await expect(response.json()).resolves.toMatchObject({ message: "Publishing in progress." });
  });

  it("schedules and saves drafts like any post", async () => {
    await POST(textRequest({ scheduledFor: "2099-01-01T09:00:00.000Z" }));
    expect(createPostJobOnlyMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ media: null, intent: "scheduled", scheduledFor: new Date("2099-01-01T09:00:00.000Z") }),
    );
    await POST(textRequest({ draft: true }));
    expect(createPostJobOnlyMock).toHaveBeenLastCalledWith(expect.objectContaining({ media: null, intent: "draft" }));
    expect(inngestSendMock).not.toHaveBeenCalled();
  });

  it("repeats like any scheduled post, one create call for the series", async () => {
    createPostJobOnlyMock.mockResolvedValue({ postJobId: "job-1", postJobIds: ["job-1", "job-2"], mediaItemId: null, resultIds: [] });
    const response = await POST(
      textRequest({ scheduledFor: "2099-01-01T09:00:00.000Z", repeatAt: ["2099-01-08T09:00:00.000Z"] }),
    );
    expect(response.status).toBe(200);
    expect(createPostJobOnlyMock).toHaveBeenCalledTimes(1);
    expect(createPostJobOnlyMock.mock.calls[0][0]).toMatchObject({
      media: null,
      series: { times: [new Date("2099-01-01T09:00:00.000Z"), new Date("2099-01-08T09:00:00.000Z")] },
    });
  });

  it("counts toward the daily post limit", async () => {
    checkDailyPostLimitMock.mockResolvedValue({ error: "Today's limit is reached.", code: "DAILY_POST_LIMIT" });
    const response = await POST(textRequest());
    expect(response.status).toBe(429);
    expect(checkDailyPostLimitMock).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: "ws-1", mode: "now" }));
    expect(createPostJobOnlyMock).not.toHaveBeenCalled();
  });

  it("without textOnly the old answers are unchanged", async () => {
    const missing = await POST(jsonRequest({ baseCaption: "hi" }));
    expect(missing.status).toBe(400);
    await expect(missing.json()).resolves.toEqual({ error: "blobUrl or mediaItemId is required" });

    const falsy = await POST(jsonRequest({ textOnly: false, baseCaption: "hi" }));
    await expect(falsy.json()).resolves.toEqual({ error: "blobUrl or mediaItemId is required" });

    const noCaption = await POST(jsonRequest({ blobUrl: "https://test.public.blob.vercel-storage.com/x" }));
    await expect(noCaption.json()).resolves.toEqual({ error: "baseCaption is required" });
  });
});

describe("POST /api/posts - textOnly while posts without a photo are switched off", () => {
  beforeEach(() => {
    textPosts.enabled = false;
  });
  afterEach(() => {
    textPosts.enabled = true;
  });

  it("refuses textOnly with the sentence, before any other check, and creates nothing", async () => {
    for (const body of [
      { textOnly: true, baseCaption: "Lessons cancelled", platforms: ["x"] },
      { textOnly: true, baseCaption: "", platforms: ["instagram"] },
      { textOnly: true, blobUrl: "https://test.public.blob.vercel-storage.com/x.jpg", baseCaption: "hi" },
    ]) {
      const response = await POST(jsonRequest(body));
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({ error: "Posts without a photo are not available yet." });
    }
    expect(createPostJobOnlyMock).not.toHaveBeenCalled();
    expect(inngestSendMock).not.toHaveBeenCalled();
  });

  it("answers a body without textOnly exactly as before", async () => {
    const missing = await POST(jsonRequest({ baseCaption: "hi" }));
    await expect(missing.json()).resolves.toEqual({ error: "blobUrl or mediaItemId is required" });
  });
});
