import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Handler-level test for the daily media retention sweep's blob deletion. The
// sweep and `DELETE /api/media/[id]` share `deleteBlobUnlessShared`; this pins
// that the sweep ALSO never destroys a blob another live MediaItem still uses
// (2026-11-01 audit, Task 8). vi.mock is hoisted above the imports.
const db = vi.hoisted(() => ({
  findMany: vi.fn(),
  findUnique: vi.fn(),
  update: vi.fn(),
  count: vi.fn(),
  postJobCount: vi.fn(),
  executeRaw: vi.fn(),
  transaction: vi.fn(),
}));
const { delMock } = vi.hoisted(() => ({ delMock: vi.fn() }));

vi.mock("@/lib/db", () => ({
  prisma: {
    mediaItem: { findMany: db.findMany },
    $transaction: db.transaction,
  },
}));
vi.mock("@/server/platforms", () => ({ getPlatformClient: vi.fn() }));
vi.mock("@vercel/blob", () => ({ del: delMock }));
vi.mock("@/server/jobs/failPendingResults", () => ({ failPendingPostJobResults: vi.fn() }));

import { mediaRetentionSweep } from "./inngest-functions";

const STALE = new Date("2025-01-01T00:00:00Z");

type SweepSummary = { candidates: number; swept: number; skipped: number; errors: number };

function runSweep(): Promise<SweepSummary> {
  const step = {
    run: async (_id: string, cb: () => Promise<unknown>) => cb(),
  };
  const handler = (mediaRetentionSweep as unknown as {
    fn: (args: { step: typeof step }) => Promise<SweepSummary>;
  }).fn;
  return handler({ step });
}

afterEach(() => {
  vi.unstubAllEnvs();
});

beforeEach(() => {
  // Hermetic: the shared-blob guard rewrites Vercel Blob hosts to the own store.
  vi.stubEnv("BLOB_READ_WRITE_TOKEN", "");
  vi.stubEnv("BLOB_STORE_ID", "");
  for (const mock of Object.values(db)) mock.mockReset();
  delMock.mockReset();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});

  db.findMany.mockResolvedValue([{ id: "media-1" }]);
  db.findUnique.mockResolvedValue({
    storageLocation: "https://example.public.blob.vercel-storage.com/a.mp4",
    deletedAt: null,
    lastUsedAt: STALE,
    createdAt: STALE,
    _count: { postJobs: 1 },
  });
  db.postJobCount.mockResolvedValue(0);
  db.count.mockResolvedValue(0);
  db.transaction.mockImplementation(async (callback: (tx: unknown) => unknown) =>
    callback({
      $executeRaw: db.executeRaw,
      postJob: { count: db.postJobCount },
      mediaItem: { findUnique: db.findUnique, update: db.update, count: db.count },
    }),
  );
});

describe("mediaRetentionSweep blob deletion", () => {
  it("soft-deletes the row and removes the blob when nothing else references the URL", async () => {
    const summary = await runSweep();

    expect(summary).toMatchObject({ candidates: 1, swept: 1, skipped: 0, errors: 0 });
    expect(db.update).toHaveBeenCalledTimes(1);
    expect(delMock).toHaveBeenCalledWith("https://example.public.blob.vercel-storage.com/a.mp4");
  });

  it("soft-deletes the row but KEEPS the blob when another live MediaItem shares the URL", async () => {
    db.count.mockResolvedValue(1);

    const summary = await runSweep();

    expect(summary).toMatchObject({ candidates: 1, swept: 1, skipped: 0, errors: 0 });
    expect(db.update).toHaveBeenCalledTimes(1);
    expect(db.count).toHaveBeenCalledWith({
      where: {
        storageLocation: { in: ["https://example.public.blob.vercel-storage.com/a.mp4"] },
        id: { not: "media-1" },
        deletedAt: null,
      },
    });
    expect(delMock).not.toHaveBeenCalled();
  });

  it("touches neither the row nor the blob when the item is no longer eligible", async () => {
    db.postJobCount.mockResolvedValue(1); // a non-terminal job appeared

    const summary = await runSweep();

    expect(summary).toMatchObject({ swept: 0, skipped: 1 });
    expect(db.update).not.toHaveBeenCalled();
    expect(delMock).not.toHaveBeenCalled();
  });
});
