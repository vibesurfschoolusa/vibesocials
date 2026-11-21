import { beforeEach, describe, expect, it, vi } from "vitest";

const { upsertMock, updateMock, updateManyMock } = vi.hoisted(() => ({
  upsertMock: vi.fn(),
  updateMock: vi.fn(),
  updateManyMock: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: { rateLimitEntry: { upsert: upsertMock, update: updateMock, updateMany: updateManyMock } },
}));

import {
  UPLOAD_BYTES_PER_DAY,
  UPLOAD_EMPTY_MESSAGE,
  UPLOAD_SIZE_MISSING_MESSAGE,
  UPLOAD_TOO_LARGE_MESSAGE,
  consumeUploadDayBytes,
  declaredUploadSize,
  releaseUploadDayBytes,
} from "./uploadBudget";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 10, 14, 15, 0, 0);
const BUCKET = Math.floor(NOW / DAY_MS);
const KEY = `user-1:upload/bytes-day:${BUCKET}`;
const MB = 1024 * 1024;

/** A store that really adds up, per key, as the database row does. */
function countingStore() {
  const rows = new Map<string, number>();
  upsertMock.mockImplementation(
    async ({ where, create, update }: { where: { key: string }; create: { count: number }; update: { count: { increment: number } } }) => {
      const count = rows.has(where.key) ? rows.get(where.key)! + update.count.increment : create.count;
      rows.set(where.key, count);
      return { key: where.key, count };
    },
  );
  const decrement = async ({ where, data }: { where: { key: string; count?: { gte?: number } }; data: { count: { decrement: number } } }) => {
    const current = rows.get(where.key) ?? 0;
    if (where.count?.gte !== undefined && current < where.count.gte) return { count: 0 };
    rows.set(where.key, current - data.count.decrement);
    return { key: where.key, count: current - data.count.decrement };
  };
  updateMock.mockImplementation(decrement);
  updateManyMock.mockImplementation(decrement);
  return rows;
}

beforeEach(() => {
  upsertMock.mockReset();
  updateMock.mockReset();
  updateManyMock.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("declaredUploadSize", () => {
  it("reads the size the page sent with the token request", () => {
    expect(declaredUploadSize(JSON.stringify({ size: 2 * MB }))).toEqual({ ok: true, size: 2 * MB });
    expect(declaredUploadSize(JSON.stringify({ size: 512 * MB }))).toEqual({ ok: true, size: 512 * MB });
  });

  it("refuses a missing or unreadable size with a plain sentence", () => {
    for (const payload of [null, undefined, "", "not json", "{}", JSON.stringify({ size: "2" }), JSON.stringify({ size: 1.5 }), JSON.stringify({ size: -4 }), "5"]) {
      expect(declaredUploadSize(payload), String(payload)).toEqual({ ok: false, error: UPLOAD_SIZE_MISSING_MESSAGE, reason: "out-of-date" });
    }
  });

  it("refuses an empty file and one over 512 MB", () => {
    expect(declaredUploadSize(JSON.stringify({ size: 0 }))).toEqual({ ok: false, error: UPLOAD_EMPTY_MESSAGE, reason: "empty" });
    expect(declaredUploadSize(JSON.stringify({ size: 512 * MB + 1 }))).toEqual({ ok: false, error: UPLOAD_TOO_LARGE_MESSAGE, reason: "too-large" });
  });
});

describe("consumeUploadDayBytes", () => {
  it("is 20 GB a day", () => {
    expect(UPLOAD_BYTES_PER_DAY).toBe(20 * 1024 * 1024 * 1024);
  });

  it("counts in kilobytes under one key per person and UTC day, ending at midnight UTC", async () => {
    countingStore();
    await expect(consumeUploadDayBytes("user-1", 5000, NOW)).resolves.toEqual({ allowed: true });
    expect(upsertMock).toHaveBeenCalledWith({
      where: { key: KEY },
      create: { key: KEY, count: 5, expiresAt: new Date((BUCKET + 1) * DAY_MS) },
      update: { count: { increment: 5 } },
    });
  });

  it("refuses the file that would go over the day and gives its share back, so a smaller one still fits", async () => {
    const rows = countingStore();
    rows.set(KEY, UPLOAD_BYTES_PER_DAY / 1024 - 1024);

    const refused = await consumeUploadDayBytes("user-1", 2 * MB, NOW);
    expect(refused.allowed).toBe(false);
    expect(refused.retryAfterSeconds).toBe(9 * 60 * 60);
    expect(rows.get(KEY)).toBe(UPLOAD_BYTES_PER_DAY / 1024 - 1024);

    await expect(consumeUploadDayBytes("user-1", MB, NOW)).resolves.toEqual({ allowed: true });
  });

  // R62 pages-a-2 L1: the refusal says what is left, so the sentence can name it.
  it("19.7 GB used plus a 400 MB file: refused, naming the bytes left before it", async () => {
    const rows = countingStore();
    const usedKib = Math.round(19.7 * 1024 * 1024);
    rows.set(KEY, usedKib);
    await expect(consumeUploadDayBytes("user-1", 400 * MB, NOW)).resolves.toEqual({
      allowed: false,
      retryAfterSeconds: 9 * 60 * 60,
      leftBytes: (UPLOAD_BYTES_PER_DAY / 1024 - usedKib) * 1024,
    });
  });

  it("exactly at 20 GB: refused with nothing left", async () => {
    const rows = countingStore();
    rows.set(KEY, UPLOAD_BYTES_PER_DAY / 1024);
    await expect(consumeUploadDayBytes("user-1", MB, NOW)).resolves.toMatchObject({ allowed: false, leftBytes: 0 });
  });

  it("fails closed when the counter cannot be reached, saying so apart from a used-up day", async () => {
    upsertMock.mockRejectedValue(new Error("db down"));
    await expect(consumeUploadDayBytes("user-1", MB, NOW)).resolves.toEqual({
      allowed: false,
      retryAfterSeconds: 60,
      unavailable: true,
    });
  });
});

describe("releaseUploadDayBytes", () => {
  it("gives back what a later refusal counted, never below zero, never throwing", async () => {
    const rows = countingStore();
    await consumeUploadDayBytes("user-1", 2 * MB, NOW);
    await releaseUploadDayBytes("user-1", 2 * MB, NOW);
    expect(rows.get(KEY)).toBe(0);

    await releaseUploadDayBytes("user-1", 2 * MB, NOW);
    expect(rows.get(KEY)).toBe(0);

    updateManyMock.mockRejectedValue(new Error("db down"));
    await expect(releaseUploadDayBytes("user-1", MB, NOW)).resolves.toBeUndefined();
  });
});
