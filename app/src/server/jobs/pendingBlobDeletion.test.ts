import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  del: vi.fn(),
  findMany: vi.fn(),
  deleteRow: vi.fn(),
  updateRow: vi.fn(),
  mediaCount: vi.fn(),
  logoCount: vi.fn(),
  loggerInfo: vi.fn(),
}));

vi.mock("@vercel/blob", () => ({ del: m.del }));
vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: m.loggerInfo, warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@/lib/db", () => ({
  prisma: {
    pendingBlobDeletion: { findMany: m.findMany, deleteMany: m.deleteRow, updateMany: m.updateRow },
    mediaItem: { count: m.mediaCount },
    workspace: { count: m.logoCount },
  },
}));

import {
  DRAIN_BATCH_SIZE,
  DRAIN_BUDGET_MS,
  deleteBlobsWithTimeout,
  drainPendingBlobDeletions,
} from "./pendingBlobDeletion";

const url = (name: string) => `https://abc123.public.blob.vercel-storage.com/${name}.png`;
const row = (id: string, attempts = 0) => ({ id, url: url(id), attempts, createdAt: new Date() });

beforeEach(() => {
  for (const mock of Object.values(m)) mock.mockReset();
  m.del.mockResolvedValue(undefined);
  m.deleteRow.mockResolvedValue({ count: 1 });
  m.updateRow.mockResolvedValue({ count: 1 });
  m.mediaCount.mockResolvedValue(0);
  m.logoCount.mockResolvedValue(0);
  vi.stubEnv("BLOB_READ_WRITE_TOKEN", "");
  vi.stubEnv("BLOB_STORE_ID", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("drainPendingBlobDeletions", () => {
  // Fix round 1 (18b): a workspace's live logo counts as in use.
  it("after a logo is replaced, deletes the old file and keeps the live one", async () => {
    const old = url("logos/0123456789abcdef0123456789abcdef");
    const live = url("logos/fedcba9876543210fedcba9876543210");
    m.findMany.mockResolvedValue([
      { id: "old", url: old, attempts: 0, createdAt: new Date() },
      { id: "live", url: live, attempts: 0, createdAt: new Date() },
    ]);
    m.logoCount.mockImplementation(async ({ where }: { where: { logoUrl: { in: string[] } } }) =>
      where.logoUrl.in.includes(live) ? 1 : 0,
    );

    await expect(drainPendingBlobDeletions()).resolves.toEqual({ deleted: 1, kept: 1, left: 0 });

    expect(m.del).toHaveBeenCalledTimes(1);
    expect(m.del).toHaveBeenCalledWith(old, { abortSignal: expect.any(AbortSignal) });
    expect(m.deleteRow).toHaveBeenCalledWith({ where: { id: "live" } });
  });

  it("asks nothing of the workspaces for an ordinary media file", async () => {
    m.findMany.mockResolvedValue([row("a")]);
    await drainPendingBlobDeletions();
    expect(m.logoCount).not.toHaveBeenCalled();
  });

  it("takes up to 200 rows, fewest attempts first, then oldest", async () => {
    m.findMany.mockResolvedValue([]);

    await drainPendingBlobDeletions();

    expect(DRAIN_BATCH_SIZE).toBe(200);
    expect(m.findMany).toHaveBeenCalledWith({
      orderBy: [{ attempts: "asc" }, { createdAt: "asc" }, { id: "asc" }],
      take: 200,
      select: { id: true, url: true },
    });
  });

  it("deletes the file and then its row", async () => {
    m.findMany.mockResolvedValue([row("a")]);
    const order: string[] = [];
    m.del.mockImplementation(async () => void order.push("del"));
    m.deleteRow.mockImplementation(async () => void order.push("row"));

    await expect(drainPendingBlobDeletions()).resolves.toEqual({ deleted: 1, kept: 0, left: 0 });

    expect(m.del).toHaveBeenCalledWith(url("a"), { abortSignal: expect.any(AbortSignal) });
    expect(m.deleteRow).toHaveBeenCalledWith({ where: { id: "a" } });
    expect(order).toEqual(["del", "row"]);
  });

  it("drops the row but keeps the file when a live media item uses it again", async () => {
    m.findMany.mockResolvedValue([row("a")]);
    m.mediaCount.mockResolvedValue(1);

    await expect(drainPendingBlobDeletions()).resolves.toEqual({ deleted: 0, kept: 1, left: 0 });

    expect(m.mediaCount).toHaveBeenCalledWith({
      where: { storageLocation: { in: [url("a")] }, deletedAt: null },
    });
    expect(m.del).not.toHaveBeenCalled();
    expect(m.deleteRow).toHaveBeenCalledWith({ where: { id: "a" } });
  });

  it("counts an attempt and keeps the row when the delete fails", async () => {
    m.findMany.mockResolvedValue([row("a"), row("b")]);
    m.del.mockRejectedValueOnce(new Error("blob down"));

    await expect(drainPendingBlobDeletions()).resolves.toEqual({ deleted: 1, kept: 0, left: 1 });

    expect(m.updateRow).toHaveBeenCalledWith({
      where: { id: "a" },
      data: { attempts: { increment: 1 } },
    });
    expect(m.deleteRow).toHaveBeenCalledTimes(1);
    expect(m.deleteRow).toHaveBeenCalledWith({ where: { id: "b" } });
  });

  it("stops at 60 seconds and leaves the rest queued", async () => {
    m.findMany.mockResolvedValue([row("a"), row("b"), row("c")]);
    let clock = 0;
    // Each delete takes 35 s, so the second one ends past the budget.
    m.del.mockImplementation(async () => {
      clock += 35_000;
    });

    const result = await drainPendingBlobDeletions({ now: () => clock });

    expect(DRAIN_BUDGET_MS).toBe(60_000);
    expect(result).toEqual({ deleted: 2, kept: 0, left: 1 });
    expect(m.del).toHaveBeenCalledTimes(2);
  });

  it("never lets one delete run past the budget", async () => {
    m.findMany.mockResolvedValue([row("a")]);
    // The run starts at 0; the delete starts at 55 s, with 5 s of budget left.
    let calls = 0;
    const now = () => (calls++ === 0 ? 0 : 55_000);
    const spy = vi.spyOn(globalThis, "setTimeout");

    await drainPendingBlobDeletions({ now });

    expect(spy.mock.calls.map((call) => call[1])).toContain(5_000);
    spy.mockRestore();
  });

  it("is not thrown off by a row already removed (by a request's own cleanup)", async () => {
    m.findMany.mockResolvedValue([row("a"), row("b"), row("c")]);
    m.deleteRow.mockResolvedValue({ count: 0 });
    m.updateRow.mockResolvedValue({ count: 0 });
    m.mediaCount.mockResolvedValueOnce(1).mockResolvedValue(0);
    m.del.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("blob down"));

    await expect(drainPendingBlobDeletions()).resolves.toEqual({ deleted: 1, kept: 1, left: 1 });

    expect(m.deleteRow).toHaveBeenCalledWith({ where: { id: "a" } });
    expect(m.deleteRow).toHaveBeenCalledWith({ where: { id: "b" } });
    expect(m.updateRow).toHaveBeenCalledWith({
      where: { id: "c" },
      data: { attempts: { increment: 1 } },
    });
  });

  it("logs how many were deleted, kept and left", async () => {
    m.findMany.mockResolvedValue([row("a"), row("b")]);
    m.mediaCount.mockResolvedValueOnce(1).mockResolvedValueOnce(0);

    await drainPendingBlobDeletions();

    expect(m.loggerInfo).toHaveBeenCalledWith("[pendingBlobDeletion] Drain complete", {
      deleted: 1,
      kept: 1,
      left: 0,
    });
  });
});

describe("deleteBlobsWithTimeout", () => {
  it("passes an abort signal and the keys to del", async () => {
    await deleteBlobsWithTimeout([url("a"), url("b")], 10_000);

    expect(m.del).toHaveBeenCalledWith([url("a"), url("b")], { abortSignal: expect.any(AbortSignal) });
  });
});
