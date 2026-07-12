import type { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// vi.mock + vi.hoisted are hoisted above imports (mirrors media/[id]/route.test.ts).
// route.ts imports `@/lib/auth`, `@/lib/db`, `@/lib/inngest`, `@/lib/rateLimit`,
// and (Task 2 bridge) `@/lib/workspace` at module scope, so all five must be
// mocked before route.ts is imported.
const {
  getCurrentUserMock,
  postJobFindFirstMock,
  postJobUpdateMock,
  resultUpdateManyMock,
  connectionFindUniqueMock,
  inngestSendMock,
  checkRateLimitMock,
  resolveWorkspaceForUserMock,
} = vi.hoisted(() => ({
  getCurrentUserMock: vi.fn(),
  postJobFindFirstMock: vi.fn(),
  postJobUpdateMock: vi.fn(),
  resultUpdateManyMock: vi.fn(),
  connectionFindUniqueMock: vi.fn(),
  inngestSendMock: vi.fn(),
  checkRateLimitMock: vi.fn(),
  resolveWorkspaceForUserMock: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    postJob: { findFirst: postJobFindFirstMock, update: postJobUpdateMock },
    postJobResult: { updateMany: resultUpdateManyMock },
    socialConnection: { findUnique: connectionFindUniqueMock },
  },
}));

vi.mock("@/lib/auth", () => ({ getCurrentUser: getCurrentUserMock }));
vi.mock("@/lib/inngest", () => ({ inngest: { send: inngestSendMock } }));
vi.mock("@/lib/rateLimit", () => ({ checkRateLimit: checkRateLimitMock }));
// Task 2 green-build bridge: the reconnect preflight resolves `workspaceId`
// via `resolveWorkspaceForUser` (see @/lib/workspace, unit-tested separately
// in workspace.test.ts) — mocked here so this suite stays a pure route unit test.
vi.mock("@/lib/workspace", () => ({
  resolveWorkspaceForUser: resolveWorkspaceForUserMock,
}));

import { POST, parseRetryBody } from "./route";

const OWNER = { id: "user-1", email: "owner@example.com" };

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
  getCurrentUserMock.mockReset();
  postJobFindFirstMock.mockReset();
  postJobUpdateMock.mockReset();
  resultUpdateManyMock.mockReset();
  connectionFindUniqueMock.mockReset();
  inngestSendMock.mockReset();
  checkRateLimitMock.mockReset();
  resolveWorkspaceForUserMock.mockReset();

  // Sensible defaults for the happy path; individual tests override.
  getCurrentUserMock.mockResolvedValue(OWNER);
  checkRateLimitMock.mockResolvedValue({ allowed: true });
  postJobUpdateMock.mockResolvedValue({});
  inngestSendMock.mockResolvedValue(undefined);
  connectionFindUniqueMock.mockResolvedValue({ needsReconnect: false });
  resolveWorkspaceForUserMock.mockResolvedValue("workspace-1");
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
    getCurrentUserMock.mockResolvedValue(null);

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

  it("returns 404 when the job isn't owned by the caller", async () => {
    postJobFindFirstMock.mockResolvedValue(null);

    const res = await POST(req({ platform: "tiktok" }), ctx("job-1"));

    expect(res.status).toBe(404);
    expect(postJobFindFirstMock).toHaveBeenCalledWith({
      where: { id: "job-1", userId: "user-1" },
      select: expect.any(Object),
    });
    expect(resultUpdateManyMock).not.toHaveBeenCalled();
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
