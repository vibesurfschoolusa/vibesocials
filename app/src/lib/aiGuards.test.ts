import { beforeEach, describe, expect, it, vi } from "vitest";

// 2026-11-01 scale audit (W6): the three AI routes cap their prompt fields,
// share a per-workspace daily quota and time out the provider call. These are
// the shared pieces. `checkRateLimit` is mocked so the real limiter (and with
// it Prisma / DATABASE_URL) is never loaded.
const { checkRateLimitMock, memberFindManyMock } = vi.hoisted(() => ({
  checkRateLimitMock: vi.fn(),
  memberFindManyMock: vi.fn(),
}));

vi.mock("@/lib/rateLimit", () => ({ checkRateLimit: checkRateLimitMock }));
vi.mock("@/lib/db", () => ({ prisma: { workspaceMember: { findMany: memberFindManyMock } } }));

import {
  AI_LIMITS,
  AI_PROVIDER_TIMEOUT_MS,
  aiInputTooLongResponse,
  aiTimeoutResponse,
  aiWorkspaceLimitResponse,
  checkWorkspaceAiQuota,
  findOverlongAiField,
  isAiTimeoutError,
} from "./aiGuards";

beforeEach(() => {
  checkRateLimitMock.mockReset();
  memberFindManyMock.mockReset();
  memberFindManyMock.mockResolvedValue([]);
  vi.unstubAllEnvs();
});

describe("AI_LIMITS", () => {
  it("pins the audited numbers", () => {
    expect(AI_LIMITS).toEqual({
      caption: 2200,
      shortField: 40,
      reviewComment: 5000,
      name: 200,
      workspaceDailyCalls: 200,
      ownerDailyCalls: 400,
    });
    expect(AI_PROVIDER_TIMEOUT_MS).toBe(20_000);
  });
});

describe("findOverlongAiField", () => {
  it("passes a string of exactly max characters", () => {
    expect(
      findOverlongAiField([{ field: "caption", value: "a".repeat(2200), max: AI_LIMITS.caption }]),
    ).toBeNull();
  });

  it("fails a string one character over max and names the field", () => {
    expect(
      findOverlongAiField([{ field: "caption", value: "a".repeat(2201), max: AI_LIMITS.caption }]),
    ).toEqual({ field: "caption", max: 2200 });
  });

  it("ignores non-strings (existing type validation owns them)", () => {
    expect(
      findOverlongAiField([
        { field: "tone", value: undefined, max: 40 },
        { field: "tone", value: null, max: 40 },
        { field: "tone", value: 12345678901234567890, max: 3 },
        { field: "tone", value: ["x".repeat(100)], max: 3 },
        { field: "tone", value: { a: "x".repeat(100) }, max: 3 },
      ]),
    ).toBeNull();
  });

  it("returns the first offender when several are over", () => {
    expect(
      findOverlongAiField([
        { field: "platform", value: "ok", max: 40 },
        { field: "language", value: "x".repeat(41), max: 40 },
        { field: "tone", value: "y".repeat(99), max: 40 },
      ]),
    ).toEqual({ field: "language", max: 40 });
  });
});

describe("aiInputTooLongResponse", () => {
  it("is a 400 { code, error } with the field and limit in the message", async () => {
    const response = aiInputTooLongResponse({ field: "comment", max: 5000 });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      code: "AI_INPUT_TOO_LONG",
      error: "comment is too long (max 5000 characters).",
    });
  });
});

describe("checkWorkspaceAiQuota", () => {
  it("counts per workspace against the daily limit in a 24 h window, failing closed", async () => {
    checkRateLimitMock.mockResolvedValue({ allowed: true });

    await expect(checkWorkspaceAiQuota("ws-1")).resolves.toEqual({ allowed: true });

    expect(checkRateLimitMock).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "ai:workspace:ws-1",
        limit: AI_LIMITS.workspaceDailyCalls,
        windowMs: 24 * 60 * 60 * 1000,
        failClosed: true,
      }),
    );
  });

  it("passes the limiter's retryAfterSeconds through when the quota is spent", async () => {
    checkRateLimitMock.mockResolvedValue({ allowed: false, retryAfterSeconds: 4321 });

    await expect(checkWorkspaceAiQuota("ws-1")).resolves.toEqual({
      allowed: false,
      retryAfterSeconds: 4321,
    });
  });

  it("keeps workspaces apart (different workspace, different key)", async () => {
    checkRateLimitMock.mockResolvedValue({ allowed: true });

    await checkWorkspaceAiQuota("ws-a");
    await checkWorkspaceAiQuota("ws-b");

    const keys = checkRateLimitMock.mock.calls.map(([opts]) => opts.userId);
    expect(keys).toEqual(["ai:workspace:ws-a", "ai:workspace:ws-b"]);
  });

  // R5-security M1: a person's workspaces share one AI budget as well, so
  // making more workspaces does not make more AI calls.
  it("counts each owner of the workspace too, against one budget across all their workspaces", async () => {
    checkRateLimitMock.mockResolvedValue({ allowed: true });
    memberFindManyMock.mockResolvedValue([
      { userId: "owner-1", user: { email: "one@example.com", emailVerifiedAt: null } },
      { userId: "owner-2", user: { email: "two@example.com", emailVerifiedAt: null } },
    ]);

    await expect(checkWorkspaceAiQuota("ws-1")).resolves.toEqual({ allowed: true });

    expect(memberFindManyMock).toHaveBeenCalledWith({
      where: { workspaceId: "ws-1", role: "owner" },
      select: { userId: true, user: { select: { email: true, emailVerifiedAt: true } } },
    });
    expect(checkRateLimitMock.mock.calls.map(([opts]) => opts)).toEqual([
      expect.objectContaining({ userId: "ai:workspace:ws-1" }),
      {
        userId: "ai:owner:owner-1",
        route: "ai/owner-daily",
        limit: 400,
        windowMs: 24 * 60 * 60 * 1000,
        failClosed: true,
      },
      expect.objectContaining({ userId: "ai:owner:owner-2", limit: 400 }),
    ]);
  });

  it("refuses once an owner's budget is spent, even in a workspace with calls left", async () => {
    memberFindManyMock.mockResolvedValue([{ userId: "owner-1", user: { email: "one@example.com", emailVerifiedAt: null } }]);
    checkRateLimitMock.mockImplementation(async ({ userId }: { userId: string }) =>
      userId.startsWith("ai:owner:") ? { allowed: false, retryAfterSeconds: 99 } : { allowed: true },
    );

    await expect(checkWorkspaceAiQuota("ws-new")).resolves.toEqual({ allowed: false, retryAfterSeconds: 99 });
  });

  it("does not count an owner when the workspace's own budget already refused", async () => {
    checkRateLimitMock.mockResolvedValue({ allowed: false, retryAfterSeconds: 5 });
    await checkWorkspaceAiQuota("ws-1");
    expect(memberFindManyMock).not.toHaveBeenCalled();
    expect(checkRateLimitMock).toHaveBeenCalledTimes(1);
  });

  it("never limits the operator's workspaces by the owner budget", async () => {
    vi.stubEnv("ADMIN_EMAILS", "ops@example.com");
    checkRateLimitMock.mockResolvedValue({ allowed: true });
    memberFindManyMock.mockResolvedValue([
      { userId: "ops-1", user: { email: "ops@example.com", emailVerifiedAt: new Date("2026-10-01T00:00:00Z") } },
    ]);

    await checkWorkspaceAiQuota("ws-ops");
    expect(checkRateLimitMock.mock.calls.map(([opts]) => opts.userId)).toEqual(["ai:workspace:ws-ops"]);
  });

  it("an owner lookup that fails leaves the workspace's own budget in charge", async () => {
    // The workspace check above reads the same database and fails closed, so
    // spend stays bounded per workspace.
    vi.spyOn(console, "error").mockImplementation(() => {});
    checkRateLimitMock.mockResolvedValue({ allowed: true });
    memberFindManyMock.mockRejectedValue(new Error("db down"));
    await expect(checkWorkspaceAiQuota("ws-1")).resolves.toEqual({ allowed: true });
  });
});

describe("aiWorkspaceLimitResponse", () => {
  it("is a 429 with the code, message, retryAfterSeconds and a Retry-After header", async () => {
    const response = aiWorkspaceLimitResponse(777);

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("777");
    await expect(response.json()).resolves.toEqual({
      code: "AI_WORKSPACE_DAILY_LIMIT",
      error: "Your workspace has reached today's AI limit. Try again tomorrow.",
      retryAfterSeconds: 777,
    });
  });
});

describe("isAiTimeoutError / aiTimeoutResponse", () => {
  it("recognises AbortSignal.timeout and manual aborts, and nothing else", () => {
    expect(isAiTimeoutError(new DOMException("timed out", "TimeoutError"))).toBe(true);
    expect(isAiTimeoutError(new DOMException("aborted", "AbortError"))).toBe(true);
    expect(isAiTimeoutError(new Error("boom"))).toBe(false);
    expect(isAiTimeoutError(new TypeError("fetch failed"))).toBe(false);
    expect(isAiTimeoutError("TimeoutError")).toBe(false);
    expect(isAiTimeoutError(null)).toBe(false);
  });

  it("answers 504 AI_TIMEOUT", async () => {
    const response = aiTimeoutResponse();

    expect(response.status).toBe(504);
    await expect(response.json()).resolves.toEqual({
      error: "The AI service took too long. Try again.",
      code: "AI_TIMEOUT",
    });
  });
});
