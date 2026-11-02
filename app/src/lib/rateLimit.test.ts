import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  checkRateLimit,
  consumeFixedWindow,
  exhaustFixedWindow,
} from "./rateLimit";

// No real database: the limiter talks to prisma.rateLimitEntry only.
const { upsertMock, deleteManyMock } = vi.hoisted(() => ({
  upsertMock: vi.fn(),
  deleteManyMock: vi.fn(),
}));

vi.mock("./db", () => ({
  prisma: {
    rateLimitEntry: {
      upsert: upsertMock,
      deleteMany: deleteManyMock,
    },
  },
}));

const NOW = Date.UTC(2026, 10, 1, 12, 0, 0);

beforeEach(() => {
  upsertMock.mockReset();
  deleteManyMock.mockReset();
  deleteManyMock.mockResolvedValue({ count: 0 });
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  // Keep the opportunistic cleanup out of the way unless a test wants it.
  vi.spyOn(Math, "random").mockReturnValue(0.5);
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("checkRateLimit", () => {
  it("keeps keying the window <userId>:<route>:<bucket> and expiring it at the bucket end", async () => {
    upsertMock.mockResolvedValue({ count: 1 });
    const windowMs = 60_000;
    const bucket = Math.floor(NOW / windowMs);

    const result = await checkRateLimit({ userId: "u1", route: "posts/auto-caption", limit: 5, windowMs });

    expect(result).toEqual({ allowed: true });
    expect(upsertMock).toHaveBeenCalledTimes(1);
    expect(upsertMock).toHaveBeenCalledWith({
      where: { key: `u1:posts/auto-caption:${bucket}` },
      create: {
        key: `u1:posts/auto-caption:${bucket}`,
        count: 1,
        expiresAt: new Date((bucket + 1) * windowMs),
      },
      update: { count: { increment: 1 } },
    });
  });

  it("allows up to the limit and then blocks with the seconds left in the window", async () => {
    const windowMs = 60_000;
    upsertMock.mockResolvedValueOnce({ count: 5 }).mockResolvedValueOnce({ count: 6 });
    vi.setSystemTime(Math.floor(NOW / windowMs) * windowMs + 20_000); // 40 s left

    expect(await checkRateLimit({ userId: "u1", route: "r", limit: 5, windowMs })).toEqual({
      allowed: true,
    });
    expect(await checkRateLimit({ userId: "u1", route: "r", limit: 5, windowMs })).toEqual({
      allowed: false,
      retryAfterSeconds: 40,
    });
  });

  it("fails open on a store error by default", async () => {
    upsertMock.mockRejectedValue(new Error("db down"));
    expect(await checkRateLimit({ userId: "u1", route: "r", limit: 5, windowMs: 1000 })).toEqual({
      allowed: true,
    });
  });

  it("fails closed with a 60 s retry when asked to", async () => {
    upsertMock.mockRejectedValue(new Error("db down"));
    expect(
      await checkRateLimit({ userId: "u1", route: "r", limit: 5, windowMs: 1000, failClosed: true }),
    ).toEqual({ allowed: false, retryAfterSeconds: 60 });
  });

  it("sweeps expired rows on ~2% of calls without awaiting or surfacing a failure", async () => {
    upsertMock.mockResolvedValue({ count: 1 });
    deleteManyMock.mockRejectedValue(new Error("sweep failed"));
    vi.spyOn(Math, "random").mockReturnValue(0.01);

    await expect(
      checkRateLimit({ userId: "u1", route: "r", limit: 5, windowMs: 1000 }),
    ).resolves.toEqual({ allowed: true });
    expect(deleteManyMock).toHaveBeenCalledWith({ where: { expiresAt: { lt: new Date(NOW) } } });
  });
});

describe("consumeFixedWindow", () => {
  const resetAt = new Date(NOW + 90_000);

  it("upserts the explicit key with an increment and the explicit expiry", async () => {
    upsertMock.mockResolvedValue({ count: 1 });

    const result = await consumeFixedWindow({ key: "quota:test", limit: 3, resetAt });

    expect(result).toEqual({ allowed: true });
    expect(upsertMock).toHaveBeenCalledWith({
      where: { key: "quota:test" },
      create: { key: "quota:test", count: 1, expiresAt: resetAt },
      update: { count: { increment: 1 } },
    });
  });

  it("blocks once the count passes the limit, reporting the seconds until resetAt", async () => {
    upsertMock.mockResolvedValueOnce({ count: 3 }).mockResolvedValueOnce({ count: 4 });

    expect(await consumeFixedWindow({ key: "k", limit: 3, resetAt })).toEqual({ allowed: true });
    expect(await consumeFixedWindow({ key: "k", limit: 3, resetAt })).toEqual({
      allowed: false,
      retryAfterSeconds: 90,
    });
  });

  it("reports at least one second even when resetAt is already past", async () => {
    upsertMock.mockResolvedValue({ count: 9 });
    expect(
      await consumeFixedWindow({ key: "k", limit: 1, resetAt: new Date(NOW - 5_000) }),
    ).toEqual({ allowed: false, retryAfterSeconds: 1 });
  });

  it("fails open on a store error, and closed with failClosed", async () => {
    upsertMock.mockRejectedValue(new Error("db down"));

    expect(await consumeFixedWindow({ key: "k", limit: 1, resetAt })).toEqual({ allowed: true });
    expect(await consumeFixedWindow({ key: "k", limit: 1, resetAt, failClosed: true })).toEqual({
      allowed: false,
      retryAfterSeconds: 60,
    });
  });
});

describe("exhaustFixedWindow", () => {
  const resetAt = new Date(NOW + 3_600_000);

  it("upserts the count straight to the limit", async () => {
    upsertMock.mockResolvedValue({ count: 100 });

    await exhaustFixedWindow({ key: "quota:test", limit: 100, resetAt });

    expect(upsertMock).toHaveBeenCalledTimes(1);
    expect(upsertMock).toHaveBeenCalledWith({
      where: { key: "quota:test" },
      create: { key: "quota:test", count: 100, expiresAt: resetAt },
      update: { count: 100 },
    });
  });

  it("logs and swallows a store error", async () => {
    upsertMock.mockRejectedValue(new Error("db down"));

    await expect(exhaustFixedWindow({ key: "k", limit: 1, resetAt })).resolves.toBeUndefined();
    expect(console.error).toHaveBeenCalled();
  });
});
