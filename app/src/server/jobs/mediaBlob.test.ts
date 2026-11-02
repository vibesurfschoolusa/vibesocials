import { beforeEach, describe, expect, it, vi } from "vitest";

// 2026-11-01 audit (M2): `deleteBlobUnlessShared` compared raw storageLocation
// strings, so a legacy row spelled `U `, `HTTPS://HOST/...` or `...:443/...`
// was invisible to the live row `U` and the guard `del()`-ed the teammate's
// file. The guard now compares canonical keys. vi.mock is hoisted above imports.
const { delMock } = vi.hoisted(() => ({ delMock: vi.fn() }));
vi.mock("@vercel/blob", () => ({ del: delMock }));

import { deleteBlobUnlessShared, type MediaBlobTx } from "./mediaBlob";

const U = "https://abc123.public.blob.vercel-storage.com/1700000000000-ab12cd34-photo-Xy9Zq1.png";

type Row = { id: string; storageLocation: string; deletedAt: Date | null };

type CountArgs = {
  where: { storageLocation: { in: string[] }; id: { not: string }; deletedAt: null };
};

/**
 * A fake transaction over an in-memory MediaItem table. `count` honours the
 * guard's real filter (storageLocation IN [...], id != self, deletedAt null) so
 * the tests assert behaviour, not just call shapes.
 */
function makeTx(rows: Row[]) {
  // Tagged-template call: (strings, ...values), so the lock key is calls[0][1].
  const executeRaw = vi.fn<(...args: unknown[]) => Promise<number>>(async () => 0);
  const count = vi.fn(async ({ where }: CountArgs) =>
    rows.filter(
      (row) =>
        where.storageLocation.in.includes(row.storageLocation) &&
        row.id !== where.id.not &&
        row.deletedAt === where.deletedAt,
    ).length,
  );
  const tx = { $executeRaw: executeRaw, mediaItem: { count } } as unknown as MediaBlobTx;
  return { tx, executeRaw, count };
}

beforeEach(() => {
  delMock.mockReset();
});

describe("deleteBlobUnlessShared", () => {
  it("deletes the blob when no other live row references it", async () => {
    const { tx } = makeTx([{ id: "a", storageLocation: U, deletedAt: null }]);

    await expect(deleteBlobUnlessShared(tx, { id: "a", storageLocation: U })).resolves.toBe("deleted");

    expect(delMock).toHaveBeenCalledTimes(1);
    expect(delMock).toHaveBeenCalledWith(U);
  });

  it("keeps the blob when another live row references the same URL", async () => {
    const { tx } = makeTx([
      { id: "a", storageLocation: U, deletedAt: null },
      { id: "b", storageLocation: U, deletedAt: null },
    ]);

    await expect(deleteBlobUnlessShared(tx, { id: "b", storageLocation: U })).resolves.toBe("kept_shared");

    expect(delMock).not.toHaveBeenCalled();
  });

  it("ignores purged (soft-deleted) rows", async () => {
    const { tx } = makeTx([
      { id: "a", storageLocation: U, deletedAt: new Date("2026-01-01T00:00:00Z") },
      { id: "b", storageLocation: U, deletedAt: null },
    ]);

    await expect(deleteBlobUnlessShared(tx, { id: "b", storageLocation: U })).resolves.toBe("deleted");

    expect(delMock).toHaveBeenCalledWith(U);
  });

  describe("legacy variant rows (a non-canonical spelling of a file another row holds)", () => {
    it.each([
      ["leading whitespace", ` ${U}`],
      ["trailing whitespace", `${U} `],
      ["upper-case scheme and host", U.replace("https://abc123", "HTTPS://ABC123")],
      ["explicit :443", U.replace(".com/", ".com:443/")],
      ["dot segments", U.replace(".com/", ".com/./")],
    ])("keeps the blob when the deleted row is spelled with %s and a canonical row is live", async (_label, variant) => {
      const { tx, executeRaw } = makeTx([
        { id: "a", storageLocation: U, deletedAt: null },
        { id: "b", storageLocation: variant, deletedAt: null },
      ]);

      await expect(deleteBlobUnlessShared(tx, { id: "b", storageLocation: variant })).resolves.toBe(
        "kept_shared",
      );

      expect(delMock).not.toHaveBeenCalled();
      // The advisory lock is keyed on the canonical URL, so a concurrent delete
      // of `a` (keyed U) and of `b` (variant) serialize on the SAME lock.
      expect(executeRaw.mock.calls[0].slice(1)).toEqual([U]);
    });

    it("deletes the CANONICAL URL (not the variant) when the variant is the last live reference", async () => {
      const variant = ` ${U}`;
      const { tx } = makeTx([{ id: "b", storageLocation: variant, deletedAt: null }]);

      await expect(deleteBlobUnlessShared(tx, { id: "b", storageLocation: variant })).resolves.toBe(
        "deleted",
      );

      expect(delMock).toHaveBeenCalledTimes(1);
      expect(delMock).toHaveBeenCalledWith(U);
    });

    it("counts rows stored under either the canonical key or the raw value, deduplicated", async () => {
      const variant = `${U} `;
      const variantRun = makeTx([]);
      await deleteBlobUnlessShared(variantRun.tx, { id: "b", storageLocation: variant });
      expect(variantRun.count).toHaveBeenCalledWith({
        where: { storageLocation: { in: [U, variant] }, id: { not: "b" }, deletedAt: null },
      });

      const canonicalRun = makeTx([]);
      await deleteBlobUnlessShared(canonicalRun.tx, { id: "a", storageLocation: U });
      expect(canonicalRun.count).toHaveBeenCalledWith({
        where: { storageLocation: { in: [U] }, id: { not: "a" }, deletedAt: null },
      });
    });
  });

  it("falls back to the raw value for a stored URL that cannot be canonicalized", async () => {
    // e.g. a host that was allow-listed when the row was written but is not now.
    const legacy = "https://x.example/blob-key";
    const { tx, executeRaw, count } = makeTx([]);

    await expect(deleteBlobUnlessShared(tx, { id: "a", storageLocation: legacy })).resolves.toBe("deleted");

    expect(executeRaw.mock.calls[0].slice(1)).toEqual([legacy]);
    expect(count).toHaveBeenCalledWith({
      where: { storageLocation: { in: [legacy] }, id: { not: "a" }, deletedAt: null },
    });
    expect(delMock).toHaveBeenCalledWith(legacy);
  });

  it("takes the advisory lock before counting", async () => {
    const order: string[] = [];
    const { tx, executeRaw, count } = makeTx([]);
    executeRaw.mockImplementation(async () => {
      order.push("lock");
      return 0;
    });
    count.mockImplementation(async () => {
      order.push("count");
      return 0;
    });

    await deleteBlobUnlessShared(tx, { id: "a", storageLocation: U });

    expect(order).toEqual(["lock", "count"]);
  });
});
