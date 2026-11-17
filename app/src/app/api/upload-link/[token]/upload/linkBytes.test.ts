import { beforeEach, describe, expect, it, vi } from "vitest";

const { upsertMock, updateMock, updateManyMock } = vi.hoisted(() => ({
  upsertMock: vi.fn(),
  updateMock: vi.fn(),
  updateManyMock: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: { rateLimitEntry: { upsert: upsertMock, update: updateMock, updateMany: updateManyMock } },
}));

import { UPLOAD_LINK_BYTES_PER_DAY } from "@/lib/uploadLink";

import { consumeUploadLinkDayBytes, releaseUploadLinkReservation } from "./linkBytes";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 10, 14, 15, 0, 0);
const BUCKET = Math.floor(NOW / DAY_MS);

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
  updateMock.mockImplementation(
    async ({ where, data }: { where: { key: string }; data: { count: { decrement: number } } }) => {
      const count = (rows.get(where.key) ?? 0) - data.count.decrement;
      rows.set(where.key, count);
      return { key: where.key, count };
    },
  );
  return rows;
}

beforeEach(() => {
  upsertMock.mockReset();
  updateMock.mockReset();
  updateManyMock.mockReset();
  updateManyMock.mockResolvedValue({ count: 1 });
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("consumeUploadLinkDayBytes", () => {
  it("is 20 GB a day", () => {
    expect(UPLOAD_LINK_BYTES_PER_DAY).toBe(20 * 1024 * 1024 * 1024);
  });

  it("counts in kilobytes under one key per link and UTC day, ending at midnight UTC", async () => {
    countingStore();
    await expect(consumeUploadLinkDayBytes("link-1", 5000, NOW)).resolves.toEqual({ allowed: true });

    expect(upsertMock).toHaveBeenCalledWith({
      where: { key: `upload-link:link-1:upload-link/bytes-day:${BUCKET}` },
      create: { key: `upload-link:link-1:upload-link/bytes-day:${BUCKET}`, count: 5, expiresAt: new Date((BUCKET + 1) * DAY_MS) },
      update: { count: { increment: 5 } },
    });
  });

  it("refuses once the day's bytes are used, gives the refused share back, and leaves other links alone", async () => {
    const rows = countingStore();
    const big = 512 * 1024 * 1024;
    // 40 files of 512 MB = 20 GB exactly: all allowed.
    for (let i = 0; i < 40; i += 1) {
      expect((await consumeUploadLinkDayBytes("link-1", big, NOW)).allowed, `file ${i + 1}`).toBe(true);
    }
    const refused = await consumeUploadLinkDayBytes("link-1", 1024, NOW);
    expect(refused.allowed).toBe(false);
    expect(refused.retryAfterSeconds).toBe(((BUCKET + 1) * DAY_MS - NOW) / 1000);
    expect(rows.get(`upload-link:link-1:upload-link/bytes-day:${BUCKET}`)).toBe(UPLOAD_LINK_BYTES_PER_DAY / 1024);

    expect((await consumeUploadLinkDayBytes("link-2", big, NOW)).allowed).toBe(true);
  });

  it("lets a smaller file through after a large one was refused", async () => {
    countingStore();
    expect((await consumeUploadLinkDayBytes("link-1", UPLOAD_LINK_BYTES_PER_DAY - 1024 * 1024, NOW)).allowed).toBe(true);
    expect((await consumeUploadLinkDayBytes("link-1", 500 * 1024 * 1024, NOW)).allowed).toBe(false);
    expect((await consumeUploadLinkDayBytes("link-1", 1024 * 1024, NOW)).allowed).toBe(true);
  });

  // R39 client-journey L1: a store error is marked, so the route says "couldn't check", not "20 GB used".
  it("fails closed when the store is down, marked unavailable", async () => {
    upsertMock.mockRejectedValue(new Error("db down"));
    await expect(consumeUploadLinkDayBytes("link-1", 10, NOW)).resolves.toEqual({
      allowed: false,
      retryAfterSeconds: 60,
      unavailable: true,
    });
  });
});

describe("releaseUploadLinkReservation", () => {
  it("takes the file off the link's day count (checkRateLimit's key) and the bytes off its byte count", async () => {
    await releaseUploadLinkReservation("link-1", { file: true, bytes: 5000 }, NOW);

    expect(updateManyMock).toHaveBeenCalledWith({
      where: { key: `upload-link:link-1:upload-link/upload-day:${BUCKET}`, count: { gt: 0 } },
      data: { count: { decrement: 1 } },
    });
    expect(updateManyMock).toHaveBeenCalledWith({
      where: { key: `upload-link:link-1:upload-link/bytes-day:${BUCKET}`, count: { gte: 5 } },
      data: { count: { decrement: 5 } },
    });
  });

  it("leaves a request's counters as they were: consume then release adds up to nothing", async () => {
    const rows = countingStore();
    updateManyMock.mockImplementation(
      async ({ where, data }: { where: { key: string }; data: { count: { decrement: number } } }) => {
        if (!rows.has(where.key)) return { count: 0 };
        rows.set(where.key, rows.get(where.key)! - data.count.decrement);
        return { count: 1 };
      },
    );
    await consumeUploadLinkDayBytes("link-1", 2048, NOW);
    await consumeUploadLinkDayBytes("link-1", 4096, NOW);
    await releaseUploadLinkReservation("link-1", { file: false, bytes: 4096 }, NOW);
    expect(rows.get(`upload-link:link-1:upload-link/bytes-day:${BUCKET}`)).toBe(2);
  });

  it("touches only what it is told to, and never throws", async () => {
    await releaseUploadLinkReservation("link-1", { file: false, bytes: 0 }, NOW);
    expect(updateManyMock).not.toHaveBeenCalled();

    updateManyMock.mockRejectedValue(new Error("db down"));
    await expect(releaseUploadLinkReservation("link-1", { file: true, bytes: 10 }, NOW)).resolves.toBeUndefined();
  });
});
