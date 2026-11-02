import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  consumeYouTubeUploadSlot,
  DEFAULT_YOUTUBE_DAILY_UPLOAD_LIMIT,
  exhaustYouTubeUploadBudget,
  youtubeDailyUploadLimit,
} from "./youtubeQuota";

// 2026-11-01 scale audit (platform limits): YouTube videos.insert has its own
// 100-calls/day bucket that resets at midnight Pacific. No real database: the
// shared fixed-window store is mocked at prisma.
const { upsertMock, deleteManyMock } = vi.hoisted(() => ({
  upsertMock: vi.fn(),
  deleteManyMock: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    rateLimitEntry: {
      upsert: upsertMock,
      deleteMany: deleteManyMock,
    },
  },
}));

const NOW = new Date("2026-11-01T12:00:00Z");

beforeEach(() => {
  upsertMock.mockReset();
  deleteManyMock.mockReset();
  deleteManyMock.mockResolvedValue({ count: 0 });
  vi.spyOn(Math, "random").mockReturnValue(0.5);
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("youtubeDailyUploadLimit", () => {
  it("defaults to 100", () => {
    expect(DEFAULT_YOUTUBE_DAILY_UPLOAD_LIMIT).toBe(100);
    expect(youtubeDailyUploadLimit({})).toBe(100);
  });

  it("parses a non-negative integer, including 0", () => {
    expect(youtubeDailyUploadLimit({ YOUTUBE_DAILY_UPLOAD_LIMIT: "50" })).toBe(50);
    expect(youtubeDailyUploadLimit({ YOUTUBE_DAILY_UPLOAD_LIMIT: " 7 " })).toBe(7);
    expect(youtubeDailyUploadLimit({ YOUTUBE_DAILY_UPLOAD_LIMIT: "0" })).toBe(0);
  });

  it.each(["abc", "", "  ", "-1", "1.5", "1e3", "10x", "NaN", "Infinity", "99999999999999999999"])(
    "falls back to 100 for %j",
    (value) => {
      expect(youtubeDailyUploadLimit({ YOUTUBE_DAILY_UPLOAD_LIMIT: value })).toBe(100);
    },
  );

  it("reads process.env by default", () => {
    vi.stubEnv("YOUTUBE_DAILY_UPLOAD_LIMIT", "12");
    expect(youtubeDailyUploadLimit()).toBe(12);
  });
});

describe("consumeYouTubeUploadSlot", () => {
  it("counts against the Pacific-day key and expires at the next Pacific midnight", async () => {
    upsertMock.mockResolvedValue({ count: 1 });

    expect(await consumeYouTubeUploadSlot(NOW)).toEqual({ allowed: true });

    const call = upsertMock.mock.calls[0][0] as {
      where: { key: string };
      create: { key: string; count: number; expiresAt: Date };
    };
    expect(call.where.key).toBe("quota:youtube:videos.insert:2026-11-01");
    expect(call.create.expiresAt.toISOString()).toBe("2026-11-02T08:00:00.000Z");
  });

  it("rolls the key over at midnight Pacific, not at midnight UTC", async () => {
    upsertMock.mockResolvedValue({ count: 1 });

    await consumeYouTubeUploadSlot(new Date("2026-11-01T06:59:59Z"));
    await consumeYouTubeUploadSlot(new Date("2026-11-01T07:00:00Z"));

    const keys = upsertMock.mock.calls.map((c) => (c[0] as { where: { key: string } }).where.key);
    expect(keys).toEqual([
      "quota:youtube:videos.insert:2026-10-31",
      "quota:youtube:videos.insert:2026-11-01",
    ]);
  });

  it("allows the 100th upload and denies the 101st with the reset time", async () => {
    upsertMock.mockResolvedValueOnce({ count: 100 }).mockResolvedValueOnce({ count: 101 });

    expect(await consumeYouTubeUploadSlot(NOW)).toEqual({ allowed: true });
    expect(await consumeYouTubeUploadSlot(NOW)).toEqual({
      allowed: false,
      resetAt: new Date("2026-11-02T08:00:00Z"),
    });
  });

  it("honors YOUTUBE_DAILY_UPLOAD_LIMIT", async () => {
    vi.stubEnv("YOUTUBE_DAILY_UPLOAD_LIMIT", "2");
    upsertMock.mockResolvedValueOnce({ count: 2 }).mockResolvedValueOnce({ count: 3 });

    expect(await consumeYouTubeUploadSlot(NOW)).toEqual({ allowed: true });
    expect((await consumeYouTubeUploadSlot(NOW)).allowed).toBe(false);
  });

  it('YOUTUBE_DAILY_UPLOAD_LIMIT="0" denies the first call, without touching the store', async () => {
    vi.stubEnv("YOUTUBE_DAILY_UPLOAD_LIMIT", "0");
    // Even a store that would count 1 (and a failing one) cannot let an upload through.
    upsertMock.mockRejectedValue(new Error("db down"));

    expect(await consumeYouTubeUploadSlot(NOW)).toEqual({
      allowed: false,
      resetAt: new Date("2026-11-02T08:00:00Z"),
    });
    expect(upsertMock).not.toHaveBeenCalled();
  });

  it('treats an invalid limit ("abc") as the default 100', async () => {
    vi.stubEnv("YOUTUBE_DAILY_UPLOAD_LIMIT", "abc");
    upsertMock.mockResolvedValueOnce({ count: 100 }).mockResolvedValueOnce({ count: 101 });

    expect((await consumeYouTubeUploadSlot(NOW)).allowed).toBe(true);
    expect((await consumeYouTubeUploadSlot(NOW)).allowed).toBe(false);
  });

  it("fails open when the store rejects (Google's own 403 is then classified)", async () => {
    upsertMock.mockRejectedValue(new Error("db down"));

    expect(await consumeYouTubeUploadSlot(NOW)).toEqual({ allowed: true });
  });

  it("defaults now to the current time", async () => {
    upsertMock.mockResolvedValue({ count: 1 });
    await consumeYouTubeUploadSlot();
    const key = (upsertMock.mock.calls[0][0] as { where: { key: string } }).where.key;
    expect(key).toMatch(/^quota:youtube:videos\.insert:\d{4}-\d{2}-\d{2}$/);
  });
});

describe("exhaustYouTubeUploadBudget", () => {
  it("sets today's count to the limit so later uploads are denied", async () => {
    upsertMock.mockResolvedValue({ count: 100 });

    await exhaustYouTubeUploadBudget(NOW);

    expect(upsertMock).toHaveBeenCalledWith({
      where: { key: "quota:youtube:videos.insert:2026-11-01" },
      create: {
        key: "quota:youtube:videos.insert:2026-11-01",
        count: 100,
        expiresAt: new Date("2026-11-02T08:00:00Z"),
      },
      update: { count: 100 },
    });
  });

  it("uses the configured limit", async () => {
    vi.stubEnv("YOUTUBE_DAILY_UPLOAD_LIMIT", "25");
    upsertMock.mockResolvedValue({ count: 25 });

    await exhaustYouTubeUploadBudget(NOW);

    expect((upsertMock.mock.calls[0][0] as { update: unknown }).update).toEqual({ count: 25 });
  });

  it("swallows a store error", async () => {
    upsertMock.mockRejectedValue(new Error("db down"));
    await expect(exhaustYouTubeUploadBudget(NOW)).resolves.toBeUndefined();
  });
});
