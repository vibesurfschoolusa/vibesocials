import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 2026-11-01 audit (M2): `deleteBlobUnlessShared` compared raw storageLocation
// strings, so a legacy row spelled `U `, `HTTPS://HOST/...` or `...:443/...`
// was invisible to the live row `U` and the guard `del()`-ed the teammate's
// file. The guard now compares canonical keys. vi.mock is hoisted above imports.
const { delMock } = vi.hoisted(() => ({ delMock: vi.fn() }));
vi.mock("@vercel/blob", () => ({ del: delMock }));

import { BLOB_DELETE_TIMEOUT_MS, deleteBlobUnlessShared, type MediaBlobTx } from "./mediaBlob";

const U = "https://abc123.public.blob.vercel-storage.com/1700000000000-ab12cd34-photo-Xy9Zq1.png";

/** Every `del` is bounded by an abort signal (see "bounds the blob delete" below). */
const TIMED = { abortSignal: expect.any(AbortSignal) };

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
  // Hermetic: tests that depend on the own store set it themselves.
  vi.stubEnv("BLOB_READ_WRITE_TOKEN", "");
  vi.stubEnv("BLOB_STORE_ID", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("deleteBlobUnlessShared", () => {
  // Fix round 1 (18b): a workspace logo has no media row of its own, so a media
  // row that points at one (registered before the logos/ prefix was reserved)
  // must not be able to delete it.
  describe("a file a workspace's logo points at", () => {
    const LOGO = "https://abc123.public.blob.vercel-storage.com/logos/0123456789abcdef0123456789abcdef.png";

    function withLogos(rows: Row[], logoUrls: string[]) {
      const made = makeTx(rows);
      const workspaceCount = vi.fn(async ({ where }: { where: { logoUrl: { in: string[] } } }) =>
        logoUrls.filter((logo) => where.logoUrl.in.includes(logo)).length,
      );
      (made.tx as unknown as { workspace: unknown }).workspace = { count: workspaceCount };
      return { ...made, workspaceCount };
    }

    it("is kept while it is a live logo, even with no other media row", async () => {
      const { tx, workspaceCount } = withLogos([{ id: "attacker", storageLocation: LOGO, deletedAt: null }], [LOGO]);

      await expect(deleteBlobUnlessShared(tx, { id: "attacker", storageLocation: LOGO })).resolves.toBe("kept_shared");

      expect(delMock).not.toHaveBeenCalled();
      expect(workspaceCount).toHaveBeenCalledWith({ where: { logoUrl: { in: [LOGO] } } });
    });

    it("is matched by another spelling of the address too", async () => {
      const { tx } = withLogos([], [LOGO]);
      await expect(
        deleteBlobUnlessShared(tx, { id: "attacker", storageLocation: `${LOGO}?download=1` }),
      ).resolves.toBe("kept_shared");
      expect(delMock).not.toHaveBeenCalled();
    });

    it("is deleted once no workspace points at it any more", async () => {
      const { tx } = withLogos([], []);
      await expect(deleteBlobUnlessShared(tx, { id: "attacker", storageLocation: LOGO })).resolves.toBe("deleted");
      expect(delMock).toHaveBeenCalledWith(LOGO, TIMED);
    });

    it("asks nothing of the workspaces for an ordinary media file", async () => {
      const { tx, workspaceCount } = withLogos([], [LOGO]);
      await expect(deleteBlobUnlessShared(tx, { id: "a", storageLocation: U })).resolves.toBe("deleted");
      expect(workspaceCount).not.toHaveBeenCalled();
    });
  });

  it("deletes the blob when no other live row references it", async () => {
    const { tx } = makeTx([{ id: "a", storageLocation: U, deletedAt: null }]);

    await expect(deleteBlobUnlessShared(tx, { id: "a", storageLocation: U })).resolves.toBe("deleted");

    expect(delMock).toHaveBeenCalledTimes(1);
    expect(delMock).toHaveBeenCalledWith(U, TIMED);
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

    expect(delMock).toHaveBeenCalledWith(U, TIMED);
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
      expect(delMock).toHaveBeenCalledWith(U, TIMED);
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
    expect(delMock).toHaveBeenCalledWith(legacy, TIMED);
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

// 2026-11-02 scale audit (jobs): `del()` is the one unbounded call inside the
// retention sweep's per-item transaction and the single-delete route's. A hung
// Blob request held the row lock, the advisory lock and a pooled connection until
// the platform killed the invocation. The delete now carries an AbortSignal; an
// abort throws like any failed `del`, so the caller's transaction rolls back and
// the row stays live. The guard itself (lenient key, advisory lock, count over
// [key, raw]) is unchanged.
//
// The signal must come from an AbortController aborted with NO reason, not from
// AbortSignal.timeout(): @vercel/blob's requestApi gives up only on a DOMException
// named "AbortError", so an AbortSignal.timeout() abort (a "TimeoutError") is
// retried by the SDK's async-retry (10 retries with backoff by default) and the
// delete would run on far past the timeout. A reason-less controller.abort() has
// an AbortError reason, and the SDK fails fast with BlobRequestAbortedError.
describe("deleteBlobUnlessShared bounds the blob delete", () => {
  /** `del` that hangs until its signal aborts, then fails like the SDK does. */
  function hangingDel() {
    const seen: { signal?: AbortSignal } = {};
    delMock.mockImplementation(
      (_key: string, options: { abortSignal: AbortSignal }) =>
        new Promise<void>((_resolve, reject) => {
          seen.signal = options.abortSignal;
          options.abortSignal.addEventListener("abort", () => {
            reject(
              Object.assign(new Error("Request was aborted."), { name: "BlobRequestAbortedError" }),
            );
          });
        }),
    );
    return seen;
  }

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("pins the delete timeout at 10 s", () => {
    expect(BLOB_DELETE_TIMEOUT_MS).toBe(10_000);
  });

  it("aborts the signal passed to del() after 10 s, with an AbortError reason (the one the SDK honours)", async () => {
    const seen = hangingDel();
    const { tx } = makeTx([{ id: "a", storageLocation: U, deletedAt: null }]);

    const outcome = deleteBlobUnlessShared(tx, { id: "a", storageLocation: U }).then(
      () => null,
      (error: unknown) => error as Error,
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(delMock).toHaveBeenCalledTimes(1);
    expect(seen.signal).toBeInstanceOf(AbortSignal);
    expect(seen.signal?.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(BLOB_DELETE_TIMEOUT_MS - 1);
    expect(seen.signal?.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    expect(seen.signal?.aborted).toBe(true);
    // @vercel/blob bails out of its retries only on a DOMException named "AbortError";
    // AbortSignal.timeout() would abort with a "TimeoutError" and be retried.
    expect(seen.signal?.reason).toBeInstanceOf(DOMException);
    expect((seen.signal?.reason as DOMException).name).toBe("AbortError");

    expect((await outcome)?.name).toBe("BlobRequestAbortedError");
  });

  it("does not use AbortSignal.timeout (its TimeoutError abort is retried by the SDK, not honoured)", async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    const { tx } = makeTx([{ id: "a", storageLocation: U, deletedAt: null }]);

    await deleteBlobUnlessShared(tx, { id: "a", storageLocation: U });

    expect(timeoutSpy).not.toHaveBeenCalled();
    expect(delMock).toHaveBeenCalledWith(U, TIMED);
  });

  it("clears the timer when del() resolves first: no pending timer, and the signal is never aborted", async () => {
    let signal: AbortSignal | undefined;
    delMock.mockImplementation(async (_key: string, options: { abortSignal: AbortSignal }) => {
      signal = options.abortSignal;
    });
    const { tx } = makeTx([{ id: "a", storageLocation: U, deletedAt: null }]);

    await expect(deleteBlobUnlessShared(tx, { id: "a", storageLocation: U })).resolves.toBe("deleted");

    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(BLOB_DELETE_TIMEOUT_MS * 2);
    expect(signal?.aborted).toBe(false);
  });

  it("clears the timer when del() rejects first (any failure), and rethrows that failure", async () => {
    const failure = new Error("network error");
    delMock.mockRejectedValueOnce(failure);
    const { tx } = makeTx([{ id: "a", storageLocation: U, deletedAt: null }]);

    await expect(deleteBlobUnlessShared(tx, { id: "a", storageLocation: U })).rejects.toBe(failure);

    expect(vi.getTimerCount()).toBe(0);
  });

  it("starts no timer and no signal for a shared blob (it never calls del)", async () => {
    const { tx } = makeTx([
      { id: "a", storageLocation: U, deletedAt: null },
      { id: "b", storageLocation: U, deletedAt: null },
    ]);

    await expect(deleteBlobUnlessShared(tx, { id: "b", storageLocation: U })).resolves.toBe("kept_shared");

    expect(vi.getTimerCount()).toBe(0);
    expect(delMock).not.toHaveBeenCalled();
  });

  it("an aborted del() rejects, never returns 'deleted', and the caller's transaction rolls back (the row stays live)", async () => {
    hangingDel();
    const rows: Row[] = [{ id: "a", storageLocation: U, deletedAt: null }];
    const { tx } = makeTx(rows);
    // Prisma's $transaction: the callback's rejection rolls every write back.
    const transaction = async <T>(callback: () => Promise<T>): Promise<T> => {
      const before = rows.map((row) => ({ ...row }));
      try {
        return await callback();
      } catch (error) {
        rows.splice(0, rows.length, ...before);
        throw error;
      }
    };

    let result: string | undefined;
    const outcome = transaction(async () => {
      rows[0].deletedAt = new Date("2026-11-02T00:00:00Z"); // the caller marks the row first
      result = await deleteBlobUnlessShared(tx, { id: "a", storageLocation: U });
    }).then(
      () => null,
      (error: unknown) => error as Error,
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(rows[0].deletedAt).not.toBeNull(); // still inside the transaction

    await vi.advanceTimersByTimeAsync(BLOB_DELETE_TIMEOUT_MS);

    expect((await outcome)?.name).toBe("BlobRequestAbortedError");
    expect(result).toBeUndefined();
    expect(rows[0].deletedAt).toBeNull();
  });

  it("rejects with an AbortError the SDK might throw as a DOMException too, unchanged", async () => {
    const abortError = new DOMException("This operation was aborted", "AbortError");
    delMock.mockRejectedValueOnce(abortError);
    const { tx } = makeTx([{ id: "a", storageLocation: U, deletedAt: null }]);

    await expect(deleteBlobUnlessShared(tx, { id: "a", storageLocation: U })).rejects.toBe(abortError);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps the guard unchanged: lenient key for the lock, the delete and the count over [key, raw]", async () => {
    const variant = `${U}?x=1`;
    const { tx, executeRaw, count } = makeTx([]);

    await expect(deleteBlobUnlessShared(tx, { id: "b", storageLocation: variant })).resolves.toBe("deleted");

    expect(executeRaw.mock.calls[0].slice(1)).toEqual([U]);
    expect(count).toHaveBeenCalledWith({
      where: { storageLocation: { in: [U, variant] }, id: { not: "b" }, deletedAt: null },
    });
    expect(delMock).toHaveBeenCalledWith(U, TIMED);
  });
});

// 2026-11-01 audit (M2, ruling R6): a stored value that canonicalBlobUrl()
// REJECTS (credentials, a non-default port, a query/fragment, or another
// store's host) used to fall back to its raw spelling, so the count saw no twin
// and the guard `del()`-ed the teammate's blob. The guard now derives a lenient
// key first.
describe("deleteBlobUnlessShared lenient key (ruling R6)", () => {
  const STORE = "abc123";
  const KEY = "1700000000000-ab12cd34-photo-Xy9Zq1.png";
  const OWN = `https://${STORE}.public.blob.vercel-storage.com/${KEY}`;

  beforeEach(() => {
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", `vercel_blob_rw_${STORE}_secretvalue`);
  });

  const variants: Array<[string, string]> = [
    ["a query string", `${OWN}?x=1`],
    ["a fragment", `${OWN}#f`],
    ["a query and a fragment", `${OWN}?x=1#f`],
    ["credentials", `https://u:p@${STORE}.public.blob.vercel-storage.com/${KEY}`],
    ["a username only", `https://u@${STORE}.public.blob.vercel-storage.com/${KEY}`],
    ["a non-default port", `https://${STORE}.public.blob.vercel-storage.com:8443/${KEY}`],
    ["another store's public host", `https://zzz999.public.blob.vercel-storage.com/${KEY}`],
    ["another store's private host", `https://zzz999.private.blob.vercel-storage.com/${KEY}`],
    ["another store's host with a query, a port and an upper-case scheme", `HTTPS://ZZZ999.public.blob.vercel-storage.com:8443/${KEY}?x=1`],
    ["an own-store private host", `https://${STORE}.private.blob.vercel-storage.com/${KEY}`],
    // JS trim() strips these but WHATWG URL parsing does not (it only strips C0
    // controls and spaces), and the migration's \s never matches U+FEFF. POST
    // /api/posts used to store body.blobUrl untrimmed, so such rows can exist.
    ["a leading U+FEFF (BOM)", `\uFEFF${OWN}`],
    ["a trailing U+00A0 (no-break space)", `${OWN}\u00A0`],
    ["a trailing U+2028 (line separator)", `${OWN}\u2028`],
    ["a leading U+00A0 and a query", `\u00A0${OWN}?x=1`],
  ];

  it.each(variants)("keeps the blob when the deleted row has %s and a canonical own-store row is live", async (_label, variant) => {
    const { tx, executeRaw, count } = makeTx([
      { id: "a", storageLocation: OWN, deletedAt: null },
      { id: "b", storageLocation: variant, deletedAt: null },
    ]);

    await expect(deleteBlobUnlessShared(tx, { id: "b", storageLocation: variant })).resolves.toBe(
      "kept_shared",
    );

    expect(delMock).not.toHaveBeenCalled();
    expect(executeRaw.mock.calls[0].slice(1)).toEqual([OWN]);
    expect(count).toHaveBeenCalledWith({
      where: { storageLocation: { in: [OWN, variant] }, id: { not: "b" }, deletedAt: null },
    });
  });

  it("deletes the own-store canonical URL, not a foreign-store spelling, when it is the last reference", async () => {
    const foreign = `https://zzz999.public.blob.vercel-storage.com/${KEY}?x=1`;
    const { tx } = makeTx([{ id: "b", storageLocation: foreign, deletedAt: null }]);

    await expect(deleteBlobUnlessShared(tx, { id: "b", storageLocation: foreign })).resolves.toBe(
      "deleted",
    );

    expect(delMock).toHaveBeenCalledTimes(1);
    expect(delMock).toHaveBeenCalledWith(OWN, TIMED);
  });

  it("still matches a canonical twin when the stored value is an own-store canonical URL", async () => {
    const { tx } = makeTx([
      { id: "a", storageLocation: OWN, deletedAt: null },
      { id: "b", storageLocation: OWN, deletedAt: null },
    ]);

    await expect(deleteBlobUnlessShared(tx, { id: "b", storageLocation: OWN })).resolves.toBe("kept_shared");
  });

  it("strips credentials, query and port but keeps the port on local dev hosts", async () => {
    const mock = "http://localhost:9366/x.png";
    const variant = "http://u:p@LOCALHOST:9366/x.png?pathname=x#f";
    const { tx, executeRaw } = makeTx([{ id: "a", storageLocation: mock, deletedAt: null }]);

    await expect(deleteBlobUnlessShared(tx, { id: "b", storageLocation: variant })).resolves.toBe(
      "kept_shared",
    );

    expect(executeRaw.mock.calls[0].slice(1)).toEqual([mock]);
    expect(delMock).not.toHaveBeenCalled();
  });

  it("uses the raw value when it cannot be parsed as a URL", async () => {
    const { tx, executeRaw, count } = makeTx([]);

    await expect(deleteBlobUnlessShared(tx, { id: "a", storageLocation: "not a url" })).resolves.toBe("deleted");

    expect(executeRaw.mock.calls[0].slice(1)).toEqual(["not a url"]);
    expect(count).toHaveBeenCalledWith({
      where: { storageLocation: { in: ["not a url"] }, id: { not: "a" }, deletedAt: null },
    });
    expect(delMock).toHaveBeenCalledWith("not a url", TIMED);
  });

  it("falls back to the raw value when the cleaned URL is still not canonicalizable (disallowed host)", async () => {
    const legacy = "https://x.example/blob-key?x=1";
    const { tx, executeRaw } = makeTx([]);

    await expect(deleteBlobUnlessShared(tx, { id: "a", storageLocation: legacy })).resolves.toBe("deleted");

    expect(executeRaw.mock.calls[0].slice(1)).toEqual([legacy]);
    expect(delMock).toHaveBeenCalledWith(legacy, TIMED);
  });

  describe("when the own store id is unknown", () => {
    beforeEach(() => {
      vi.stubEnv("BLOB_READ_WRITE_TOKEN", "");
    });

    it("still strips credentials, query, fragment and port, but does not rewrite the host", async () => {
      const variant = `https://u:p@${STORE}.public.blob.vercel-storage.com:8443/${KEY}?x=1#f`;
      const { tx } = makeTx([{ id: "a", storageLocation: OWN, deletedAt: null }]);

      await expect(deleteBlobUnlessShared(tx, { id: "b", storageLocation: variant })).resolves.toBe(
        "kept_shared",
      );
      expect(delMock).not.toHaveBeenCalled();

      const foreign = `https://zzz999.public.blob.vercel-storage.com/${KEY}`;
      const other = makeTx([{ id: "a", storageLocation: OWN, deletedAt: null }]);
      await expect(deleteBlobUnlessShared(other.tx, { id: "b", storageLocation: foreign })).resolves.toBe(
        "deleted",
      );
      expect(delMock).toHaveBeenCalledWith(foreign, TIMED);
    });
  });
});
