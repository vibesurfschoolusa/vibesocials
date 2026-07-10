import { beforeEach, describe, expect, it, vi } from "vitest";

// Focused suite for prepareDeferredPostJobDispatch (the §6.3 run-time
// result-creation fix). Isolated in its own file so its `@/lib/db` mock only
// needs the handful of methods this helper touches. vitest hoists vi.mock.
const {
  postJobFindUniqueMock,
  postJobUpdateMock,
  connectionFindManyMock,
  resultCountMock,
  resultCreateManyMock,
} = vi.hoisted(() => ({
  postJobFindUniqueMock: vi.fn(),
  postJobUpdateMock: vi.fn(),
  connectionFindManyMock: vi.fn(),
  resultCountMock: vi.fn(),
  resultCreateManyMock: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    postJob: { findUnique: postJobFindUniqueMock, update: postJobUpdateMock },
    socialConnection: { findMany: connectionFindManyMock },
    postJobResult: { count: resultCountMock, createMany: resultCreateManyMock },
  },
}));

import { prepareDeferredPostJobDispatch } from "./posting";

function makeJob(overrides: Record<string, unknown> = {}) {
  return {
    id: "job-1",
    userId: "user-1",
    mediaItemId: "media-1",
    baseCaption: "Job snapshot caption",
    perPlatformOverrides: null,
    mediaItem: { baseCaption: "Media caption", perPlatformOverrides: null },
    ...overrides,
  };
}

beforeEach(() => {
  postJobFindUniqueMock.mockReset();
  postJobUpdateMock.mockReset();
  connectionFindManyMock.mockReset();
  resultCountMock.mockReset();
  resultCreateManyMock.mockReset();

  postJobUpdateMock.mockResolvedValue({});
  resultCountMock.mockResolvedValue(0);
  resultCreateManyMock.mockResolvedValue({ count: 0 });
});

describe("prepareDeferredPostJobDispatch", () => {
  it("returns NOT_FOUND when the job doesn't exist", async () => {
    postJobFindUniqueMock.mockResolvedValue(null);

    const result = await prepareDeferredPostJobDispatch("missing");

    expect(result).toEqual({ ok: false, reason: "NOT_FOUND" });
    expect(resultCreateManyMock).not.toHaveBeenCalled();
  });

  it("marks the job failed and returns NO_CONNECTIONS when no connections exist at run time", async () => {
    postJobFindUniqueMock.mockResolvedValue(makeJob());
    connectionFindManyMock.mockResolvedValue([]);

    const result = await prepareDeferredPostJobDispatch("job-1");

    expect(result).toEqual({ ok: false, reason: "NO_CONNECTIONS" });
    expect(postJobUpdateMock).toHaveBeenCalledWith({
      where: { id: "job-1" },
      data: { status: "failed" },
    });
    expect(resultCreateManyMock).not.toHaveBeenCalled();
  });

  it("creates a result PER CURRENT connection and returns the publish payload", async () => {
    postJobFindUniqueMock.mockResolvedValue(makeJob());
    // These are the connections that exist NOW — the run-time fan-out.
    connectionFindManyMock.mockResolvedValue([
      { id: "c-tiktok", platform: "tiktok" },
      { id: "c-youtube", platform: "youtube" },
    ]);

    const result = await prepareDeferredPostJobDispatch("job-1");

    expect(resultCreateManyMock).toHaveBeenCalledWith({
      data: [
        { postJobId: "job-1", platform: "tiktok", socialConnectionId: "c-tiktok", status: "pending" },
        { postJobId: "job-1", platform: "youtube", socialConnectionId: "c-youtube", status: "pending" },
      ],
    });
    expect(result).toEqual({
      ok: true,
      event: {
        postJobId: "job-1",
        userId: "user-1",
        mediaItemId: "media-1",
        baseCaption: "Job snapshot caption",
        perPlatformOverrides: null,
      },
    });
  });

  it("is idempotent — does NOT recreate results if some already exist", async () => {
    postJobFindUniqueMock.mockResolvedValue(makeJob());
    connectionFindManyMock.mockResolvedValue([{ id: "c-x", platform: "x" }]);
    resultCountMock.mockResolvedValue(1); // a prior attempt already created them

    const result = await prepareDeferredPostJobDispatch("job-1");

    expect(resultCreateManyMock).not.toHaveBeenCalled();
    expect(result.ok).toBe(true);
  });

  it("falls back to the media item's caption/overrides when the job has no snapshot", async () => {
    postJobFindUniqueMock.mockResolvedValue(
      makeJob({
        baseCaption: null,
        perPlatformOverrides: null,
        mediaItem: { baseCaption: "Media caption", perPlatformOverrides: { x: "override" } },
      }),
    );
    connectionFindManyMock.mockResolvedValue([{ id: "c-x", platform: "x" }]);

    const result = await prepareDeferredPostJobDispatch("job-1");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.event.baseCaption).toBe("Media caption");
      expect(result.event.perPlatformOverrides).toEqual({ x: "override" });
    }
  });
});
