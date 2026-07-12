import type { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { makeWorkspaceContext } from "../../../__test-helpers__/workspaceContextMock";

// vi.mock + vi.hoisted are hoisted above imports (mirrors media/[id]/route.test.ts).
// route.ts imports `@/lib/workspace`, `@/lib/db`, `@/lib/inngest`, and
// `@/lib/rateLimit` at module scope, so all four must be mocked before
// route.ts is imported.
const {
  getWorkspaceContextMock,
  postJobFindFirstMock,
  postJobUpdateMock,
  resultUpdateManyMock,
  connectionFindUniqueMock,
  inngestSendMock,
  checkRateLimitMock,
} = vi.hoisted(() => ({
  getWorkspaceContextMock: vi.fn(),
  postJobFindFirstMock: vi.fn(),
  postJobUpdateMock: vi.fn(),
  resultUpdateManyMock: vi.fn(),
  connectionFindUniqueMock: vi.fn(),
  inngestSendMock: vi.fn(),
  checkRateLimitMock: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    postJob: { findFirst: postJobFindFirstMock, update: postJobUpdateMock },
    postJobResult: { updateMany: resultUpdateManyMock },
    socialConnection: { findUnique: connectionFindUniqueMock },
  },
}));

vi.mock("@/lib/inngest", () => ({ inngest: { send: inngestSendMock } }));
vi.mock("@/lib/rateLimit", () => ({ checkRateLimit: checkRateLimitMock }));
// Team Workspaces (Task 4): getCurrentUser -> getWorkspaceContext, and the
// reconnect preflight now reads `context.workspace.id` directly instead of
// re-resolving via resolveWorkspaceForUser (the Task 2 bridge this replaces).
vi.mock("@/lib/workspace", () => ({
  getWorkspaceContext: getWorkspaceContextMock,
}));

import { POST, parseRetryBody } from "./route";

function ctx(postJobId: string) {
  return { params: Promise.resolve({ postJobId }) };
}

/** Minimal NextRequest stub: the handler only calls `request.json()`. */
function req(body: unknown, throwOnJson = false): NextRequest {
  return {
    json: async () => {
      if (throwOnJson) throw new Error("bad json");
      return body;
    },
  } as unknown as NextRequest;
}

function makeJob(
  results: { platform: string; status: string }[],
  deletedAt: Date | null = null,
) {
  return { id: "job-1", mediaItem: { deletedAt }, results };
}

beforeEach(() => {
  getWorkspaceContextMock.mockReset();
  postJobFindFirstMock.mockReset();
  postJobUpdateMock.mockReset();
  resultUpdateManyMock.mockReset();
  connectionFindUniqueMock.mockReset();
  inngestSendMock.mockReset();
  checkRateLimitMock.mockReset();

  // Sensible defaults for the happy path; individual tests override.
  getWorkspaceContextMock.mockResolvedValue(makeWorkspaceContext());
  checkRateLimitMock.mockResolvedValue({ allowed: true });
  postJobUpdateMock.mockResolvedValue({});
  inngestSendMock.mockResolvedValue(undefined);
  connectionFindUniqueMock.mockResolvedValue({ needsReconnect: false });
});

describe("parseRetryBody (pure)", () => {
  it("accepts retryAllFailed: true", () => {
    expect(parseRetryBody({ retryAllFailed: true })).toEqual({ kind: "all" });
  });

  it("accepts a single known platform", () => {
    expect(parseRetryBody({ platform: "tiktok" })).toEqual({
      kind: "platform",
      platform: "tiktok",
    });
  });

  it("rejects an unknown platform", () => {
    expect(parseRetryBody({ platform: "myspace" })).toEqual({
      error: "Unknown platform.",
    });
  });

  it("rejects a body with neither field", () => {
    expect("error" in parseRetryBody({})).toBe(true);
  });

  it("rejects a non-object body", () => {
    expect("error" in parseRetryBody(null)).toBe(true);
    expect("error" in parseRetryBody("tiktok")).toBe(true);
  });

  it("retryAllFailed wins if both are provided", () => {
    expect(parseRetryBody({ retryAllFailed: true, platform: "x" })).toEqual({
      kind: "all",
    });
  });
});

describe("POST /api/posts/[postJobId]/retry", () => {
  it("returns 401 and never rate-limits or hits the DB when unauthenticated", async () => {
    getWorkspaceContextMock.mockResolvedValue(null);

    const res = await POST(req({ platform: "tiktok" }), ctx("job-1"));

    expect(res.status).toBe(401);
    expect(checkRateLimitMock).not.toHaveBeenCalled();
    expect(postJobFindFirstMock).not.toHaveBeenCalled();
  });

  it("returns 429 with Retry-After when rate limited, before any DB work", async () => {
    checkRateLimitMock.mockResolvedValue({ allowed: false, retryAfterSeconds: 42 });

    const res = await POST(req({ platform: "tiktok" }), ctx("job-1"));

    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("42");
    expect(postJobFindFirstMock).not.toHaveBeenCalled();
    expect(checkRateLimitMock).toHaveBeenCalledWith({
      userId: "user-1",
      route: "posts/retry",
      limit: 10,
      windowMs: 5 * 60 * 1000,
    });
  });

  it("returns 400 on invalid JSON", async () => {
    const res = await POST(req(undefined, true), ctx("job-1"));
    expect(res.status).toBe(400);
  });

  it("returns 400 on an invalid body", async () => {
    const res = await POST(req({}), ctx("job-1"));
    expect(res.status).toBe(400);
    expect(postJobFindFirstMock).not.toHaveBeenCalled();
  });

  it("returns 404 when the job isn't in the caller's active workspace", async () => {
    postJobFindFirstMock.mockResolvedValue(null);

    const res = await POST(req({ platform: "tiktok" }), ctx("job-1"));

    expect(res.status).toBe(404);
    expect(postJobFindFirstMock).toHaveBeenCalledWith({
      where: { id: "job-1", workspaceId: "ws-1" },
      select: expect.any(Object),
    });
    expect(resultUpdateManyMock).not.toHaveBeenCalled();
  });

  it("cross-workspace isolation: a job in another workspace 404s, not 403 (no existence oracle)", async () => {
    // ws-1's WHERE wouldn't match a job that actually lives in ws-2.
    postJobFindFirstMock.mockResolvedValue(null);

    const res = await POST(req({ retryAllFailed: true }), ctx("foreign-job"));

    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ error: "Not found" });
  });

  it("returns 409 MEDIA_UNAVAILABLE when the media blob was soft-deleted", async () => {
    postJobFindFirstMock.mockResolvedValue(
      makeJob([{ platform: "tiktok", status: "failed" }], new Date()),
    );

    const res = await POST(req({ platform: "tiktok" }), ctx("job-1"));
    const body = (await res.json()) as { code?: string };

    expect(res.status).toBe(409);
    expect(body.code).toBe("MEDIA_UNAVAILABLE");
    expect(resultUpdateManyMock).not.toHaveBeenCalled();
    expect(inngestSendMock).not.toHaveBeenCalled();
  });

  it("returns 409 NOTHING_TO_RETRY when retryAllFailed but no result is failed", async () => {
    postJobFindFirstMock.mockResolvedValue(
      makeJob([{ platform: "tiktok", status: "success" }]),
    );

    const res = await POST(req({ retryAllFailed: true }), ctx("job-1"));
    const body = (await res.json()) as { code?: string };

    expect(res.status).toBe(409);
    expect(body.code).toBe("NOTHING_TO_RETRY");
    expect(resultUpdateManyMock).not.toHaveBeenCalled();
  });

  it("returns 409 RECONNECT_REQUIRED when the target connection needs reconnect", async () => {
    postJobFindFirstMock.mockResolvedValue(
      makeJob([{ platform: "instagram", status: "failed" }]),
    );
    connectionFindUniqueMock.mockResolvedValue({ needsReconnect: true });

    const res = await POST(req({ platform: "instagram" }), ctx("job-1"));
    const body = (await res.json()) as { code?: string; platform?: string };

    expect(res.status).toBe(409);
    expect(body.code).toBe("RECONNECT_REQUIRED");
    expect(body.platform).toBe("instagram");
    // Must NOT flip anything to pending — retrying a dead connection would just
    // re-fail, and we want the UI to send the user to Settings instead.
    expect(resultUpdateManyMock).not.toHaveBeenCalled();
    expect(inngestSendMock).not.toHaveBeenCalled();
  });

  it("returns 409 RECONNECT_REQUIRED when the connection is gone entirely", async () => {
    postJobFindFirstMock.mockResolvedValue(
      makeJob([{ platform: "instagram", status: "failed" }]),
    );
    connectionFindUniqueMock.mockResolvedValue(null);

    const res = await POST(req({ platform: "instagram" }), ctx("job-1"));
    const body = (await res.json()) as { code?: string };

    expect(res.status).toBe(409);
    expect(body.code).toBe("RECONNECT_REQUIRED");
  });

  it("IDEMPOTENCY: returns 409 and emits no event when the conditional claim matches nothing", async () => {
    postJobFindFirstMock.mockResolvedValue(
      makeJob([{ platform: "tiktok", status: "failed" }]),
    );
    // A concurrent/duplicate retry already flipped it out of `failed`.
    resultUpdateManyMock.mockResolvedValue({ count: 0 });

    const res = await POST(req({ platform: "tiktok" }), ctx("job-1"));
    const body = (await res.json()) as { code?: string };

    expect(res.status).toBe(409);
    expect(body.code).toBe("NOTHING_TO_RETRY");
    expect(postJobUpdateMock).not.toHaveBeenCalled();
    expect(inngestSendMock).not.toHaveBeenCalled();
  });

  it("single platform happy path: atomic claim, in_progress, event with just that platform", async () => {
    postJobFindFirstMock.mockResolvedValue(
      makeJob([{ platform: "tiktok", status: "failed" }]),
    );
    resultUpdateManyMock.mockResolvedValue({ count: 1 });

    const res = await POST(req({ platform: "tiktok" }), ctx("job-1"));
    const body = (await res.json()) as { ok?: boolean; retrying?: string[] };

    expect(res.status).toBe(202);
    expect(body).toEqual({ ok: true, retrying: ["tiktok"] });

    // The conditional claim only touches rows still in `failed` and clears the
    // prior error fields.
    expect(resultUpdateManyMock).toHaveBeenCalledWith({
      where: { postJobId: "job-1", platform: "tiktok", status: "failed" },
      data: { status: "pending", errorCode: null, errorMessage: null },
    });
    expect(postJobUpdateMock).toHaveBeenCalledWith({
      where: { id: "job-1" },
      data: { status: "in_progress" },
    });
    expect(inngestSendMock).toHaveBeenCalledWith({
      name: "post/retry.requested",
      data: { postJobId: "job-1", userId: "user-1", platforms: ["tiktok"] },
    });
  });

  it("resolves the reconnect-preflight connection lookup from the context's workspace, not resolveWorkspaceForUser (Task 2 bridge removed)", async () => {
    postJobFindFirstMock.mockResolvedValue(
      makeJob([{ platform: "instagram", status: "failed" }]),
    );
    resultUpdateManyMock.mockResolvedValue({ count: 1 });
    getWorkspaceContextMock.mockResolvedValue(makeWorkspaceContext({ workspaceId: "ws-42" }));

    await POST(req({ platform: "instagram" }), ctx("job-1"));

    expect(connectionFindUniqueMock).toHaveBeenCalledWith({
      where: { workspaceId_platform: { workspaceId: "ws-42", platform: "instagram" } },
      select: { needsReconnect: true },
    });
  });

  it("retryAllFailed: claims every failed platform, skips reconnect preflight, emits one event", async () => {
    postJobFindFirstMock.mockResolvedValue(
      makeJob([
        { platform: "tiktok", status: "failed" },
        { platform: "youtube", status: "failed" },
        { platform: "x", status: "success" },
      ]),
    );
    resultUpdateManyMock.mockResolvedValue({ count: 1 });

    const res = await POST(req({ retryAllFailed: true }), ctx("job-1"));
    const body = (await res.json()) as { retrying?: string[] };

    expect(res.status).toBe(202);
    expect(body.retrying).toEqual(["tiktok", "youtube"]);
    // The already-succeeded platform is never claimed.
    expect(resultUpdateManyMock).toHaveBeenCalledTimes(2);
    // The all-failed path does not run the per-connection reconnect preflight.
    expect(connectionFindUniqueMock).not.toHaveBeenCalled();
    expect(inngestSendMock).toHaveBeenCalledWith({
      name: "post/retry.requested",
      data: { postJobId: "job-1", userId: "user-1", platforms: ["tiktok", "youtube"] },
    });
  });

  it("retryAllFailed: only the platforms actually claimed (count>0) go into the event", async () => {
    postJobFindFirstMock.mockResolvedValue(
      makeJob([
        { platform: "tiktok", status: "failed" },
        { platform: "youtube", status: "failed" },
      ]),
    );
    // tiktok flips, youtube was already claimed by a concurrent retry.
    resultUpdateManyMock
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });

    const res = await POST(req({ retryAllFailed: true }), ctx("job-1"));
    const body = (await res.json()) as { retrying?: string[] };

    expect(res.status).toBe(202);
    expect(body.retrying).toEqual(["tiktok"]);
    expect(inngestSendMock).toHaveBeenCalledWith({
      name: "post/retry.requested",
      data: { postJobId: "job-1", userId: "user-1", platforms: ["tiktok"] },
    });
  });
});
