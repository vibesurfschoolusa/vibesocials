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
  readUploadRefusal,
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

  it("forgets it after 10 minutes, after a clear, and for another person", async () => {
    store();
    await recordUploadRefusal("user-1", "day-limit", NOW);

    await expect(readUploadRefusal("user-1", NOW + 10 * 60 * 1000)).resolves.toBeNull();
    await expect(readUploadRefusal("user-2", NOW)).resolves.toBeNull();

    await clearUploadRefusal("user-1");
    await expect(readUploadRefusal("user-1", NOW)).resolves.toBeNull();
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
