import { beforeEach, describe, expect, it, vi } from "vitest";

// vi.mock + vi.hoisted are hoisted above imports by vitest (mirrors
// settings/route.test.ts / media/[id]/route.test.ts). route.ts imports
// `@/lib/db`, `@/lib/auth`, `@/lib/inngest`, `@/lib/rateLimit`, and
// `@/server/jobs/posting` at module scope, so all must be mocked (or
// selectively real, for `MediaItemUnavailableError` below) before route.ts is
// imported.
const {
  getCurrentUserMock,
  checkRateLimitMock,
  createPostJobOnlyMock,
  createPostJobForExistingMediaMock,
  postJobFindUniqueMock,
  postJobResultFindManyMock,
  inngestSendMock,
} = vi.hoisted(() => ({
  getCurrentUserMock: vi.fn(),
  checkRateLimitMock: vi.fn(),
  createPostJobOnlyMock: vi.fn(),
  createPostJobForExistingMediaMock: vi.fn(),
  postJobFindUniqueMock: vi.fn(),
  postJobResultFindManyMock: vi.fn(),
  inngestSendMock: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  getCurrentUser: getCurrentUserMock,
}));

vi.mock("@/lib/rateLimit", () => ({
  checkRateLimit: checkRateLimitMock,
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    postJob: { findUnique: postJobFindUniqueMock },
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

import { MediaItemUnavailableError } from "@/server/jobs/posting";
import { POST } from "./route";

const USER = { id: "user-1", email: "user@example.com" };

function jsonRequest(body: unknown): Request {
  return new Request("http://localhost/api/posts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  getCurrentUserMock.mockReset();
  checkRateLimitMock.mockReset();
  createPostJobOnlyMock.mockReset();
  createPostJobForExistingMediaMock.mockReset();
  postJobFindUniqueMock.mockReset();
  postJobResultFindManyMock.mockReset();
  inngestSendMock.mockReset();

  getCurrentUserMock.mockResolvedValue(USER);
  checkRateLimitMock.mockResolvedValue({ allowed: true });
  postJobFindUniqueMock.mockResolvedValue({ id: "job-1", status: "in_progress" });
  postJobResultFindManyMock.mockResolvedValue([]);
  inngestSendMock.mockResolvedValue(undefined);
});

describe("POST /api/posts — rate limiting", () => {
  it("returns 429 with Retry-After and never creates a job when the limit is exceeded", async () => {
    checkRateLimitMock.mockResolvedValue({ allowed: false, retryAfterSeconds: 42 });

    const response = await POST(jsonRequest({ blobUrl: "https://x/y", baseCaption: "hi" }));

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

    await POST(jsonRequest({ blobUrl: "https://x/y", baseCaption: "hi" }));

    expect(checkRateLimitMock).toHaveBeenCalledWith({
      userId: "user-1",
      route: "posts/publish",
      limit: expect.any(Number),
      windowMs: expect.any(Number),
    });
  });

  it("returns 401 (and never checks the rate limit) when unauthenticated", async () => {
    getCurrentUserMock.mockResolvedValue(null);

    const response = await POST(jsonRequest({ blobUrl: "https://x/y", baseCaption: "hi" }));

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
        blobUrl: "https://blob.example/vid.mp4",
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
      media: {
        storageLocation: "https://blob.example/vid.mp4",
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

    expect(inngestSendMock).toHaveBeenCalledWith({
      name: "post/publish.requested",
      data: expect.objectContaining({
        postJobId: "job-1",
        userId: "user-1",
        mediaItemId: "media-1",
        baseCaption: "hello world",
        location: "Miami",
      }),
    });
  });

  it("returns 400 when neither blobUrl nor mediaItemId is present", async () => {
    const response = await POST(jsonRequest({ baseCaption: "hi" }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "blobUrl or mediaItemId is required",
    });
    expect(createPostJobOnlyMock).not.toHaveBeenCalled();
  });

  it("returns 400 when baseCaption is missing, without creating a job", async () => {
    const response = await POST(jsonRequest({ blobUrl: "https://x/y" }));

    expect(response.status).toBe(400);
    expect(createPostJobOnlyMock).not.toHaveBeenCalled();
  });

  it("maps a NO_CONNECTIONS error to 400 with the NO_CONNECTIONS code", async () => {
    createPostJobOnlyMock.mockRejectedValue(new Error("NO_CONNECTIONS"));

    const response = await POST(jsonRequest({ blobUrl: "https://x/y", baseCaption: "hi" }));

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
      name: "post/publish.requested",
      data: expect.objectContaining({
        postJobId: "job-2",
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
      jsonRequest({ blobUrl: "https://x/y", mediaItemId: "media-9", baseCaption: "hi" }),
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
      jsonRequest({ blobUrl: "https://x/y", baseCaption: "hi" }),
    );

    expect(response.status).toBe(200);
    expect(createPostJobOnlyMock).toHaveBeenCalledWith(
      expect.objectContaining({ intent: "immediate", scheduledFor: null }),
    );
    expect(inngestSendMock).toHaveBeenCalledTimes(1);
  });

  it("draft: creates with intent 'draft' and sends NO event", async () => {
    const response = await POST(
      jsonRequest({ blobUrl: "https://x/y", baseCaption: "hi", draft: true }),
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
      jsonRequest({ blobUrl: "https://x/y", baseCaption: "hi", scheduledFor: FUTURE }),
    );
    const body = (await response.json()) as { message?: string };

    expect(response.status).toBe(200);
    expect(createPostJobOnlyMock).toHaveBeenCalledWith(
      expect.objectContaining({ intent: "scheduled", scheduledFor: new Date(FUTURE) }),
    );
    expect(inngestSendMock).not.toHaveBeenCalled();
    expect(body.message).toBe("Post scheduled.");
  });

  it("draft wins over a provided scheduledFor", async () => {
    await POST(
      jsonRequest({
        blobUrl: "https://x/y",
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
      jsonRequest({ blobUrl: "https://x/y", baseCaption: "hi", scheduledFor: past }),
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
