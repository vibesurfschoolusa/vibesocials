import { beforeEach, describe, expect, it, vi } from "vitest";

const { upsertMock, findUniqueMock, deleteManyMock } = vi.hoisted(() => ({
  upsertMock: vi.fn(),
  findUniqueMock: vi.fn(),
  deleteManyMock: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: { rateLimitEntry: { upsert: upsertMock, findUnique: findUniqueMock, deleteMany: deleteManyMock } },
}));

import {
  UPLOAD_DAY_LIMIT_MESSAGE,
  UPLOAD_PAGE_OUT_OF_DATE_MESSAGE,
  UPLOAD_REFUSAL_MEMORY_MS,
  clearUploadRefusal,
  dayLimitRefusalMessage,
  readUploadRefusal,
  recordDayLimitRefusal,
  recordUploadRefusal,
} from "./uploadRefusal";

const NOW = Date.UTC(2026, 10, 14, 15, 0, 0);
const KEY = "user-1:upload/refusal";

/** A store that keeps one row per key, as RateLimitEntry does. */
function store() {
  const rows = new Map<string, { key: string; count: number; expiresAt: Date }>();
  upsertMock.mockImplementation(
    async ({ where, create, update }: { where: { key: string }; create: { key: string; count: number; expiresAt: Date }; update: { count: number; expiresAt: Date } }) => {
      const row = rows.has(where.key) ? { ...rows.get(where.key)!, ...update } : create;
      rows.set(where.key, row);
      return row;
    },
  );
  findUniqueMock.mockImplementation(async ({ where }: { where: { key: string } }) => rows.get(where.key) ?? null);
  deleteManyMock.mockImplementation(async ({ where }: { where: { key: string } }) => {
    const had = rows.delete(where.key);
    return { count: had ? 1 : 0 };
  });
  return rows;
}

beforeEach(() => {
  upsertMock.mockReset();
  findUniqueMock.mockReset();
  deleteManyMock.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("upload refusal memory", () => {
  it("remembers why a person's last token was refused for 10 minutes, in one row per person", async () => {
    const rows = store();
    expect(UPLOAD_REFUSAL_MEMORY_MS).toBe(10 * 60 * 1000);

    await recordUploadRefusal("user-1", "out-of-date", NOW);

    expect(rows.get(KEY)?.expiresAt).toEqual(new Date(NOW + 10 * 60 * 1000));
    await expect(readUploadRefusal("user-1", NOW + 60_000)).resolves.toEqual({
      error: UPLOAD_PAGE_OUT_OF_DATE_MESSAGE,
      code: "UPLOAD_PAGE_OUT_OF_DATE",
    });
  });

  it("gives the plain sentence for each reason", async () => {
    store();
    expect(UPLOAD_PAGE_OUT_OF_DATE_MESSAGE).toBe("This page is out of date. Reload it, then try again.");
    expect(UPLOAD_DAY_LIMIT_MESSAGE).toBe("You've uploaded 20 GB today. Uploads start again at midnight UTC.");

    await recordUploadRefusal("user-1", "day-limit", NOW);
    await expect(readUploadRefusal("user-1", NOW)).resolves.toEqual({
      error: UPLOAD_DAY_LIMIT_MESSAGE,
      code: "UPLOAD_DAY_LIMIT",
    });
    await recordUploadRefusal("user-1", "empty", NOW);
    await expect(readUploadRefusal("user-1", NOW)).resolves.toMatchObject({ error: "This file is empty." });
    await recordUploadRefusal("user-1", "too-large", NOW);
    await expect(readUploadRefusal("user-1", NOW)).resolves.toMatchObject({ error: "File is too large (max 512 MB)." });
  });

  // R62 pages-a-2 L1: only this file may not fit; a smaller one still can.
  describe("a file that would go past the day's 20 GB", () => {
    const MB = 1024 * 1024;
    // 19.7 GB used: 314,573 KiB left, 307.2 MB.
    const LEFT = (20 * 1024 * 1024 - Math.round(19.7 * 1024 * 1024)) * 1024;
    const SMALLER =
      "This file would take you past today's 20 GB upload limit. A smaller file may still go today; the limit resets at midnight UTC.";
    const PAST =
      "This file would take you past today's 20 GB upload limit. A file under 307 MB can still go today; the limit resets at midnight UTC.";

    it("19.7 GB used plus a 400 MB file: the \"would take you past\" sentence, naming what is left", async () => {
      expect(dayLimitRefusalMessage(LEFT)).toBe(PAST);
      store();
      // Remembered, it keeps no number: the day may have changed by the page's question.
      await recordDayLimitRefusal("user-1", LEFT, NOW);
      await expect(readUploadRefusal("user-1", NOW)).resolves.toEqual({ error: SMALLER, code: "UPLOAD_DAY_LIMIT" });
    });

    it("exactly at 20 GB: the \"used\" sentence", async () => {
      expect(dayLimitRefusalMessage(0)).toBe(UPLOAD_DAY_LIMIT_MESSAGE);
      expect(dayLimitRefusalMessage(MB - 1)).toBe(UPLOAD_DAY_LIMIT_MESSAGE);
      store();
      await recordDayLimitRefusal("user-1", 0, NOW);
      await expect(readUploadRefusal("user-1", NOW)).resolves.toEqual({ error: UPLOAD_DAY_LIMIT_MESSAGE, code: "UPLOAD_DAY_LIMIT" });
    });

    it("what is left not known: a smaller file may still go", () => {
      expect(dayLimitRefusalMessage(undefined)).toBe(
        "This file would take you past today's 20 GB upload limit. A smaller file may still go today; the limit resets at midnight UTC.",
      );
    });

    it("is remembered for 10 minutes as a reason number, like the other reasons", async () => {
      const rows = store();
      await recordDayLimitRefusal("user-1", LEFT, NOW);
      expect(rows.get(KEY)?.expiresAt).toEqual(new Date(NOW + UPLOAD_REFUSAL_MEMORY_MS));
      expect(rows.get(KEY)?.count).toBe(10);
    });
  });

  it("forgets it after 10 minutes, after a clear, and for another person", async () => {
    store();
    await recordUploadRefusal("user-1", "day-limit", NOW);

    await expect(readUploadRefusal("user-1", NOW + 10 * 60 * 1000)).resolves.toBeNull();
    await expect(readUploadRefusal("user-2", NOW)).resolves.toBeNull();

    await clearUploadRefusal("user-1");
    await expect(readUploadRefusal("user-1", NOW)).resolves.toBeNull();
  });

  // R44 review: the upload limit counts in fixed 15-minute blocks, so its wait
  // can be up to 900 s. The remembered wait lasts until the reset itself.
  describe("the token limit's wait is remembered until the limit resets", () => {
    const refusedWith = async (seconds: number) => {
      const rows = store();
      await recordUploadRefusal("user-1", "rate-limited", NOW, new Date(NOW + seconds * 1000));
      return rows;
    };

    it("780 s left reads 13 minutes, and is still remembered at 11 minutes", async () => {
      await refusedWith(780);
      await expect(readUploadRefusal("user-1", NOW)).resolves.toEqual({
        error: "Too many tries. Wait 13 minutes, then try again.",
        code: "UPLOAD_RATE_LIMITED",
        retryAfterSeconds: 780,
      });
      await expect(readUploadRefusal("user-1", NOW + 11 * 60 * 1000)).resolves.toMatchObject({
        error: "Too many tries. Wait 2 minutes, then try again.",
        retryAfterSeconds: 120,
      });
    });

    it("900 s left reads 15 minutes", async () => {
      await refusedWith(900);
      await expect(readUploadRefusal("user-1", NOW)).resolves.toMatchObject({
        error: "Too many tries. Wait 15 minutes, then try again.",
      });
    });

    it("is forgotten once the limit resets", async () => {
      const rows = await refusedWith(900);
      expect(rows.get(KEY)?.expiresAt).toEqual(new Date(NOW + 900_000));
      await expect(readUploadRefusal("user-1", NOW + 900_000)).resolves.toBeNull();
    });

    it("the other reasons keep their 10 minutes", async () => {
      const rows = store();
      for (const reason of ["out-of-date", "day-limit", "limit-unchecked"] as const) {
        await recordUploadRefusal("user-1", reason, NOW);
        expect(rows.get(KEY)?.expiresAt, reason).toEqual(new Date(NOW + UPLOAD_REFUSAL_MEMORY_MS));
      }
    });
  });

  it("never throws: a store error only means no sentence", async () => {
    upsertMock.mockRejectedValue(new Error("db down"));
    findUniqueMock.mockRejectedValue(new Error("db down"));
    deleteManyMock.mockRejectedValue(new Error("db down"));

    await expect(recordUploadRefusal("user-1", "out-of-date", NOW)).resolves.toBeUndefined();
    await expect(readUploadRefusal("user-1", NOW)).resolves.toBeNull();
    await expect(clearUploadRefusal("user-1")).resolves.toBeUndefined();
  });

  it("ignores a row with a reason it does not know", async () => {
    findUniqueMock.mockResolvedValue({ key: KEY, count: 99, expiresAt: new Date(NOW + 60_000) });
    await expect(readUploadRefusal("user-1", NOW)).resolves.toBeNull();
  });
});
