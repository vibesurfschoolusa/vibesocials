import type { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// vitest hoists vi.mock above imports. route.ts imports auth, db, inngest,
// rateLimit, and posting at module scope; `@/lib/scheduling` stays REAL (pure
// guards/validation the handler relies on).
const {
  getCurrentUserMock,
  checkRateLimitMock,
  findFirstMock,
  updateManyMock,
  connectionCountMock,
  inngestSendMock,
  prepareDispatchMock,
} = vi.hoisted(() => ({
  getCurrentUserMock: vi.fn(),
  checkRateLimitMock: vi.fn(),
  findFirstMock: vi.fn(),
  updateManyMock: vi.fn(),
  connectionCountMock: vi.fn(),
  inngestSendMock: vi.fn(),
  prepareDispatchMock: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ getCurrentUser: getCurrentUserMock }));
vi.mock("@/lib/rateLimit", () => ({ checkRateLimit: checkRateLimitMock }));
vi.mock("@/lib/inngest", () => ({ inngest: { send: inngestSendMock } }));
vi.mock("@/lib/db", () => ({
  prisma: {
    postJob: { findFirst: findFirstMock, updateMany: updateManyMock },
    socialConnection: { count: connectionCountMock },
  },
}));
vi.mock("@/server/jobs/posting", () => ({
  prepareDeferredPostJobDispatch: prepareDispatchMock,
}));

import { POST } from "./route";

const OWNER = { id: "user-1", email: "owner@example.com" };
const FUTURE = new Date(Date.now() + 60 * 60 * 1000).toISOString();

function ctx(postJobId: string) {
  return { params: Promise.resolve({ postJobId }) };
}
function req(body: unknown): NextRequest {
  return { json: async () => body } as unknown as NextRequest;
}

beforeEach(() => {
  getCurrentUserMock.mockReset();
  checkRateLimitMock.mockReset();
  findFirstMock.mockReset();
  updateManyMock.mockReset();
  connectionCountMock.mockReset();
  inngestSendMock.mockReset();
  prepareDispatchMock.mockReset();

  getCurrentUserMock.mockResolvedValue(OWNER);
  checkRateLimitMock.mockResolvedValue({ allowed: true });
  updateManyMock.mockResolvedValue({ count: 1 });
  connectionCountMock.mockResolvedValue(2);
  inngestSendMock.mockResolvedValue(undefined);
  prepareDispatchMock.mockResolvedValue({
    ok: true,
    event: { postJobId: "job-1", userId: "user-1", mediaItemId: "m1", baseCaption: "c", perPlatformOverrides: null },
  });
});

describe("POST /api/posts/[postJobId]/publish", () => {
  it("401s before any work when unauthenticated", async () => {
    getCurrentUserMock.mockResolvedValue(null);
    const res = await POST(req({}), ctx("job-1"));
    expect(res.status).toBe(401);
    expect(checkRateLimitMock).not.toHaveBeenCalled();
  });

  it("429s under the posts/publish bucket when rate limited", async () => {
    checkRateLimitMock.mockResolvedValue({ allowed: false, retryAfterSeconds: 30 });
    const res = await POST(req({}), ctx("job-1"));
    expect(res.status).toBe(429);
    expect(checkRateLimitMock).toHaveBeenCalledWith(
      expect.objectContaining({ route: "posts/publish" }),
    );
    expect(findFirstMock).not.toHaveBeenCalled();
  });

  it("404s when the job isn't the caller's", async () => {
    findFirstMock.mockResolvedValue(null);
    const res = await POST(req({}), ctx("job-1"));
    expect(res.status).toBe(404);
  });

  // --- schedule-a-draft path ---
  it("schedules a draft: draft → scheduled with the validated time", async () => {
    findFirstMock.mockResolvedValue({ status: "draft" });

    const res = await POST(req({ scheduledFor: FUTURE }), ctx("job-1"));
    const body = (await res.json()) as { status?: string };

    expect(res.status).toBe(200);
    expect(body.status).toBe("scheduled");
    expect(updateManyMock).toHaveBeenCalledWith({
      where: { id: "job-1", userId: "user-1", status: "draft" },
      data: { status: "scheduled", scheduledFor: new Date(FUTURE) },
    });
    // Scheduling sends no event now — the cron dispatches when due.
    expect(inngestSendMock).not.toHaveBeenCalled();
  });

  it("rejects scheduling a non-draft (409 NOT_A_DRAFT)", async () => {
    findFirstMock.mockResolvedValue({ status: "scheduled" });
    const res = await POST(req({ scheduledFor: FUTURE }), ctx("job-1"));
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("NOT_A_DRAFT");
  });

  it("400s on an invalid/past scheduledFor", async () => {
    findFirstMock.mockResolvedValue({ status: "draft" });
    const past = new Date(Date.now() - 1000).toISOString();
    const res = await POST(req({ scheduledFor: past }), ctx("job-1"));
    expect(res.status).toBe(400);
    expect(updateManyMock).not.toHaveBeenCalled();
  });

  // --- publish-now path ---
  it("publishes a draft now: claims {draft,scheduled}→in_progress, sends the event, 202", async () => {
    findFirstMock.mockResolvedValue({ status: "draft" });

    const res = await POST(req({}), ctx("job-1"));

    expect(res.status).toBe(202);
    expect(updateManyMock).toHaveBeenCalledWith({
      where: { id: "job-1", userId: "user-1", status: { in: ["scheduled", "draft"] } },
      data: { status: "in_progress" },
    });
    expect(prepareDispatchMock).toHaveBeenCalledWith("job-1");
    expect(inngestSendMock).toHaveBeenCalledWith({
      name: "post/publish.requested",
      data: expect.objectContaining({ postJobId: "job-1" }),
    });
  });

  it("publishes a SCHEDULED job now too (Queue 'Publish now')", async () => {
    findFirstMock.mockResolvedValue({ status: "scheduled" });
    const res = await POST(req({}), ctx("job-1"));
    expect(res.status).toBe(202);
    expect(inngestSendMock).toHaveBeenCalled();
  });

  it("400s NO_CONNECTIONS and leaves the draft intact when there are no connections", async () => {
    findFirstMock.mockResolvedValue({ status: "draft" });
    connectionCountMock.mockResolvedValue(0);

    const res = await POST(req({}), ctx("job-1"));

    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("NO_CONNECTIONS");
    expect(updateManyMock).not.toHaveBeenCalled();
    expect(inngestSendMock).not.toHaveBeenCalled();
  });

  it("409s NOT_PUBLISHABLE when the status isn't draft/scheduled", async () => {
    findFirstMock.mockResolvedValue({ status: "completed" });
    const res = await POST(req({}), ctx("job-1"));
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("NOT_PUBLISHABLE");
    expect(connectionCountMock).not.toHaveBeenCalled();
  });

  it("409s when the atomic claim loses the race (count 0)", async () => {
    findFirstMock.mockResolvedValue({ status: "draft" });
    updateManyMock.mockResolvedValue({ count: 0 });

    const res = await POST(req({}), ctx("job-1"));

    expect(res.status).toBe(409);
    expect(inngestSendMock).not.toHaveBeenCalled();
  });

  it("409s when a connection vanished between the count and prepare (prepare NO_CONNECTIONS)", async () => {
    findFirstMock.mockResolvedValue({ status: "draft" });
    prepareDispatchMock.mockResolvedValue({ ok: false, reason: "NO_CONNECTIONS" });

    const res = await POST(req({}), ctx("job-1"));

    expect(res.status).toBe(409);
    expect(inngestSendMock).not.toHaveBeenCalled();
  });
});
