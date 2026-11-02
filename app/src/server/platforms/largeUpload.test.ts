import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const logger = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));
vi.mock("@/lib/logger", () => ({ logger }));

import {
  BLOB_READ_FAILED_CODE,
  DEFAULT_LARGE_UPLOAD_PLATFORMS,
  LARGE_UPLOAD_CHUNK_WINDOW_MS,
  LARGE_UPLOAD_MAX_PART_BYTES,
  LARGE_UPLOAD_REQUEST_TIMEOUT_MS,
  LARGE_VIDEO_THRESHOLD_BYTES,
  largeUploadPlatforms,
  MEDIA_SIZE_MISMATCH_CODE,
  openBlobChunkStream,
  usesLargeUploadPath,
} from "./largeUpload";
import { PUBLISH_BUDGET_EXCEEDED_CODE, PUBLISH_STEP_BUDGET_MS } from "./publishBudget";

const MIB = 1024 * 1024;
const TOTAL = 300 * MIB; // the "300 MB" video the blob holds
const OFFSET = 100 * MIB; // where the step resumes
const SOURCE_CHUNK = 1_000_000; // deliberately not a divisor of the offset or of a 16 MiB read
const URL = "https://store.public.blob.vercel-storage.com/video.mp4";

/** The byte the fake blob holds at absolute position `p`. */
function byteAt(p: number): number {
  return Math.imul(p, 2654435761) >>> 24;
}

function expectedBytes(start: number, length: number): Buffer {
  const out = Buffer.allocUnsafe(length);
  for (let i = 0; i < length; i += 1) out[i] = byteAt(start + i);
  return out;
}

/**
 * A lazily generated response body: bytes `start..total-1` of the blob, produced
 * only when the reader asks for them (highWaterMark 0: no read-ahead), so the
 * test can see exactly how much the stream pulled. Nothing near 300 MB is ever
 * allocated.
 */
function lazySource(opts: { start: number; total: number; failAt?: number }) {
  let produced = 0; // bytes handed to the reader, counted from `start`
  let cancelled = false;
  const length = opts.total - opts.start;
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (opts.failAt !== undefined && produced >= opts.failAt) {
          controller.error(new TypeError("terminated"));
          return;
        }
        const size = Math.min(SOURCE_CHUNK, length - produced);
        if (size <= 0) {
          controller.close();
          return;
        }
        controller.enqueue(new Uint8Array(expectedBytes(opts.start + produced, size)));
        produced += size;
      },
      cancel() {
        cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  return { stream, pulled: () => produced, cancelled: () => cancelled };
}

function range206(source: ReturnType<typeof lazySource>, total = TOTAL, start = OFFSET) {
  return new Response(source.stream, {
    status: 206,
    headers: { "Content-Range": `bytes ${start}-${total - 1}/${total}` },
  });
}

function full200(source: ReturnType<typeof lazySource>, length = TOTAL) {
  return new Response(source.stream, {
    status: 200,
    headers: { "Content-Length": String(length) },
  });
}

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  logger.info.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("constants", () => {
  it("pins the threshold, the chunk window, the request timeout and the part cap", () => {
    expect(LARGE_VIDEO_THRESHOLD_BYTES).toBe(52_428_800);
    expect(LARGE_UPLOAD_CHUNK_WINDOW_MS).toBe(60_000);
    expect(LARGE_UPLOAD_REQUEST_TIMEOUT_MS).toBe(120_000);
    expect(LARGE_UPLOAD_MAX_PART_BYTES).toBe(67_108_864);
  });

  it("names the two error codes", () => {
    expect(MEDIA_SIZE_MISMATCH_CODE).toBe("MEDIA_SIZE_MISMATCH");
    expect(BLOB_READ_FAILED_CODE).toBe("BLOB_READ_FAILED");
  });
});

describe("openBlobChunkStream", () => {
  describe("when the blob answers 206", () => {
    it("asks for bytes from the offset, hands out exact reads and pulls lazily", async () => {
      const source = lazySource({ start: OFFSET, total: TOTAL });
      fetchMock.mockResolvedValueOnce(range206(source));

      const stream = await openBlobChunkStream(URL, { offset: OFFSET, totalBytes: TOTAL });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [calledUrl, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(calledUrl).toBe(URL);
      expect(new Headers(init.headers).get("Range")).toBe("bytes=104857600-");
      expect(stream.position).toBe(OFFSET);
      expect(source.pulled()).toBe(0);

      const first = await stream.read(16 * MIB);
      expect(first.length).toBe(16 * MIB);
      expect(first.equals(expectedBytes(OFFSET, 16 * MIB))).toBe(true);
      expect(stream.position).toBe(OFFSET + 16 * MIB);
      // The requested read plus at most one source chunk, never the whole blob.
      expect(source.pulled()).toBeLessThanOrEqual(16 * MIB + SOURCE_CHUNK);

      const second = await stream.read(16 * MIB);
      expect(second.equals(expectedBytes(OFFSET + 16 * MIB, 16 * MIB))).toBe(true);
      expect(stream.position).toBe(OFFSET + 32 * MIB);
      expect(source.pulled()).toBeLessThanOrEqual(32 * MIB + SOURCE_CHUNK);

      await stream.close();
      expect(source.cancelled()).toBe(true);
    });

    it("pulls nothing beyond what a read needs when it ends on a source chunk boundary", async () => {
      const source = lazySource({ start: OFFSET, total: TOTAL });
      fetchMock.mockResolvedValueOnce(range206(source));

      const stream = await openBlobChunkStream(URL, { offset: OFFSET, totalBytes: TOTAL });
      await stream.read(5 * SOURCE_CHUNK);

      expect(source.pulled()).toBe(5 * SOURCE_CHUNK);
      await stream.close();
    });

    it("does not log range_ignored", async () => {
      fetchMock.mockResolvedValueOnce(range206(lazySource({ start: OFFSET, total: TOTAL })));
      const stream = await openBlobChunkStream(URL, { offset: OFFSET, totalBytes: TOTAL });
      await stream.close();
      expect(logger.info).not.toHaveBeenCalled();
    });

    it("returns fewer bytes only at the end, then an empty buffer", async () => {
      const total = 5_000_000;
      const offset = 4_000_000;
      fetchMock.mockResolvedValueOnce(range206(lazySource({ start: offset, total }), total, offset));

      const stream = await openBlobChunkStream(URL, { offset, totalBytes: total });
      const tail = await stream.read(3_000_000);

      expect(tail.length).toBe(1_000_000);
      expect(tail.equals(expectedBytes(offset, 1_000_000))).toBe(true);
      expect(stream.position).toBe(total);
      expect((await stream.read(1024)).length).toBe(0);
      await stream.close();
    });

    it("fails with MEDIA_SIZE_MISMATCH when the blob's total is not the recorded size, before reading", async () => {
      const source = lazySource({ start: OFFSET, total: TOTAL + 1 });
      fetchMock.mockResolvedValueOnce(range206(source, TOTAL + 1));

      await expect(
        openBlobChunkStream(URL, { offset: OFFSET, totalBytes: TOTAL }),
      ).rejects.toMatchObject({ code: MEDIA_SIZE_MISMATCH_CODE });
      expect(source.pulled()).toBe(0);
      expect(source.cancelled()).toBe(true);
    });

    it.each([
      ["a range that starts elsewhere", `bytes 0-${TOTAL - 1}/${TOTAL}`],
      ["a range that stops early", `bytes ${OFFSET}-${TOTAL - 2}/${TOTAL}`],
      ["an unknown total", `bytes ${OFFSET}-${TOTAL - 1}/*`],
      ["a malformed header", "garbage"],
    ])("fails with BLOB_READ_FAILED on %s", async (_name, contentRange) => {
      const source = lazySource({ start: OFFSET, total: TOTAL });
      fetchMock.mockResolvedValueOnce(
        new Response(source.stream, { status: 206, headers: { "Content-Range": contentRange } }),
      );

      await expect(
        openBlobChunkStream(URL, { offset: OFFSET, totalBytes: TOTAL }),
      ).rejects.toMatchObject({ code: BLOB_READ_FAILED_CODE, status: 206 });
      expect(source.cancelled()).toBe(true);
    });

    it("fails with BLOB_READ_FAILED when the 206 has no Content-Range", async () => {
      fetchMock.mockResolvedValueOnce(
        new Response(lazySource({ start: OFFSET, total: TOTAL }).stream, { status: 206 }),
      );
      await expect(
        openBlobChunkStream(URL, { offset: OFFSET, totalBytes: TOTAL }),
      ).rejects.toMatchObject({ code: BLOB_READ_FAILED_CODE, status: 206 });
    });
  });

  describe("when the blob ignores Range and answers 200", () => {
    it("discards the prefix and returns the same bytes as the 206 case", async () => {
      const source = lazySource({ start: 0, total: TOTAL });
      fetchMock.mockResolvedValueOnce(full200(source));

      const stream = await openBlobChunkStream(URL, { offset: OFFSET, totalBytes: TOTAL });

      expect(stream.position).toBe(OFFSET);
      // The prefix was skipped as it streamed by: the offset plus at most one source chunk.
      expect(source.pulled()).toBeLessThanOrEqual(OFFSET + SOURCE_CHUNK);

      const first = await stream.read(16 * MIB);
      expect(first.length).toBe(16 * MIB);
      expect(first.equals(expectedBytes(OFFSET, 16 * MIB))).toBe(true);
      expect(source.pulled()).toBeLessThanOrEqual(OFFSET + 16 * MIB + SOURCE_CHUNK);

      const second = await stream.read(16 * MIB);
      expect(second.equals(expectedBytes(OFFSET + 16 * MIB, 16 * MIB))).toBe(true);
      await stream.close();
    });

    it("logs range_ignored once per process", async () => {
      vi.resetModules();
      const fresh = await import("./largeUpload");
      for (let i = 0; i < 2; i += 1) {
        fetchMock.mockResolvedValueOnce(full200(lazySource({ start: 0, total: 2_500_000 }), 2_500_000));
        const stream = await fresh.openBlobChunkStream(URL, { offset: 1_200_000, totalBytes: 2_500_000 });
        await stream.close();
      }
      const ignored = logger.info.mock.calls.filter(([message]) => message === "range_ignored");
      expect(ignored).toHaveLength(1);
    });

    it("needs no discarding and logs nothing when the offset is 0", async () => {
      const total = 3_000_000;
      fetchMock.mockResolvedValueOnce(full200(lazySource({ start: 0, total }), total));

      const stream = await openBlobChunkStream(URL, { offset: 0, totalBytes: total });
      const all = await stream.read(total + 1);

      expect(all.length).toBe(total);
      expect(all.equals(expectedBytes(0, total))).toBe(true);
      expect(logger.info).not.toHaveBeenCalled();
      await stream.close();
    });

    it("fails with MEDIA_SIZE_MISMATCH when Content-Length is not the recorded size", async () => {
      const source = lazySource({ start: 0, total: TOTAL });
      fetchMock.mockResolvedValueOnce(full200(source, TOTAL - 1));
      await expect(
        openBlobChunkStream(URL, { offset: OFFSET, totalBytes: TOTAL }),
      ).rejects.toMatchObject({ code: MEDIA_SIZE_MISMATCH_CODE });
      expect(source.pulled()).toBe(0);
      expect(source.cancelled()).toBe(true);
    });

    it("fails with BLOB_READ_FAILED when the size can't be checked", async () => {
      fetchMock.mockResolvedValueOnce(
        new Response(lazySource({ start: 0, total: TOTAL }).stream, { status: 200 }),
      );
      await expect(
        openBlobChunkStream(URL, { offset: OFFSET, totalBytes: TOTAL }),
      ).rejects.toMatchObject({ code: BLOB_READ_FAILED_CODE, status: 200 });
    });

    it("fails with BLOB_READ_FAILED when the body ends inside the prefix", async () => {
      fetchMock.mockResolvedValueOnce(
        full200(lazySource({ start: 0, total: 2_000_000 }), TOTAL),
      );
      await expect(
        openBlobChunkStream(URL, { offset: OFFSET, totalBytes: TOTAL }),
      ).rejects.toMatchObject({ code: BLOB_READ_FAILED_CODE });
    });
  });

  describe("when the blob answers anything else", () => {
    it.each([404, 416, 500, 503])("fails with BLOB_READ_FAILED carrying status %i", async (status) => {
      fetchMock.mockResolvedValueOnce(new Response("nope", { status }));
      await expect(
        openBlobChunkStream(URL, { offset: OFFSET, totalBytes: TOTAL }),
      ).rejects.toMatchObject({ code: BLOB_READ_FAILED_CODE, status });
    });

    it("never puts the blob URL in the error message", async () => {
      fetchMock.mockResolvedValueOnce(new Response("nope", { status: 404 }));
      const error = await openBlobChunkStream(URL, { offset: OFFSET, totalBytes: TOTAL }).catch(
        (e: unknown) => e as Error,
      );
      expect((error as Error).message).not.toContain("blob.vercel-storage.com");
    });

    it("lets a connection failure through unchanged so the usual retry rules classify it", async () => {
      const failure = new TypeError("fetch failed");
      fetchMock.mockRejectedValueOnce(failure);
      await expect(openBlobChunkStream(URL, { offset: OFFSET, totalBytes: TOTAL })).rejects.toBe(
        failure,
      );
    });
  });

  describe("the step deadline", () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(1_800_000_000_000);
    });

    it("bounds the request by the time left in the step", async () => {
      const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
      const deadline = Date.now() + 40_000;
      fetchMock.mockResolvedValueOnce(range206(lazySource({ start: OFFSET, total: TOTAL })));

      const stream = await openBlobChunkStream(URL, { offset: OFFSET, totalBytes: TOTAL, deadline });

      const timeouts = timeoutSpy.mock.calls.map(([ms]) => ms);
      expect(timeouts.length).toBeGreaterThan(0);
      for (const ms of timeouts) expect(ms).toBeLessThanOrEqual(40_000);
      expect(Math.max(...timeouts)).toBe(40_000);
      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(init.signal).toBeInstanceOf(AbortSignal);
      await stream.close();
    });

    it("never waits longer than one whole step, however far the deadline is", async () => {
      const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
      fetchMock.mockResolvedValueOnce(range206(lazySource({ start: OFFSET, total: TOTAL })));

      const stream = await openBlobChunkStream(URL, {
        offset: OFFSET,
        totalBytes: TOTAL,
        deadline: Date.now() + 3_600_000,
      });

      expect(Math.max(...timeoutSpy.mock.calls.map(([ms]) => ms))).toBe(PUBLISH_STEP_BUDGET_MS);
      await stream.close();
    });

    it("applies the same bound when there is no deadline", async () => {
      const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
      fetchMock.mockResolvedValueOnce(range206(lazySource({ start: OFFSET, total: TOTAL })));

      const stream = await openBlobChunkStream(URL, { offset: OFFSET, totalBytes: TOTAL });

      expect(Math.max(...timeoutSpy.mock.calls.map(([ms]) => ms))).toBe(PUBLISH_STEP_BUDGET_MS);
      await stream.close();
    });

    it("throws PUBLISH_TIME_BUDGET_EXCEEDED before fetching when 4 s are left", async () => {
      await expect(
        openBlobChunkStream(URL, {
          offset: OFFSET,
          totalBytes: TOTAL,
          deadline: Date.now() + 4_000,
        }),
      ).rejects.toMatchObject({ code: PUBLISH_BUDGET_EXCEEDED_CODE });
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe("reading", () => {
    it("throws instead of returning a short read when the body ends before the recorded size", async () => {
      const total = 3_000_000;
      // The server promised 3,000,000 bytes but the body holds 2,000,000.
      fetchMock.mockResolvedValueOnce(full200(lazySource({ start: 0, total: 2_000_000 }), total));

      const stream = await openBlobChunkStream(URL, { offset: 0, totalBytes: total });
      await expect(stream.read(total)).rejects.toMatchObject({ code: BLOB_READ_FAILED_CODE });
      // The stream is spent: it doesn't pretend to carry on.
      await expect(stream.read(1)).rejects.toMatchObject({ code: BLOB_READ_FAILED_CODE });
      expect(stream.position).toBe(0);
    });

    it("wraps a body error in BLOB_READ_FAILED and keeps the cause", async () => {
      const total = 3_000_000;
      fetchMock.mockResolvedValueOnce(
        full200(lazySource({ start: 0, total, failAt: 1_000_000 }), total),
      );

      const stream = await openBlobChunkStream(URL, { offset: 0, totalBytes: total });
      const error = await stream.read(total).catch((e: unknown) => e as Error & { code: string });

      expect((error as { code: string }).code).toBe(BLOB_READ_FAILED_CODE);
      expect((error as { cause?: unknown }).cause).toBeInstanceOf(TypeError);
    });

    it("reads nothing for a zero-byte request and rejects an invalid size", async () => {
      fetchMock.mockResolvedValueOnce(range206(lazySource({ start: OFFSET, total: TOTAL })));
      const stream = await openBlobChunkStream(URL, { offset: OFFSET, totalBytes: TOTAL });

      expect((await stream.read(0)).length).toBe(0);
      await expect(stream.read(-1)).rejects.toBeInstanceOf(RangeError);
      await expect(stream.read(1.5)).rejects.toBeInstanceOf(RangeError);
      expect(stream.position).toBe(OFFSET);
      await stream.close();
    });

    it("refuses to read once it is closed", async () => {
      fetchMock.mockResolvedValueOnce(range206(lazySource({ start: OFFSET, total: TOTAL })));
      const stream = await openBlobChunkStream(URL, { offset: OFFSET, totalBytes: TOTAL });
      await stream.close();
      await expect(stream.read(1024)).rejects.toMatchObject({ code: BLOB_READ_FAILED_CODE });
    });

    it("closes more than once without failing", async () => {
      fetchMock.mockResolvedValueOnce(range206(lazySource({ start: OFFSET, total: TOTAL })));
      const stream = await openBlobChunkStream(URL, { offset: OFFSET, totalBytes: TOTAL });
      await stream.close();
      await expect(stream.close()).resolves.toBeUndefined();
    });
  });

  it.each([
    ["a negative offset", -1, TOTAL],
    ["a fractional offset", 1.5, TOTAL],
    ["an offset at the end", TOTAL, TOTAL],
    ["a zero total", 0, 0],
  ])("rejects %s before fetching", async (_name, offset, totalBytes) => {
    await expect(openBlobChunkStream(URL, { offset, totalBytes })).rejects.toBeInstanceOf(RangeError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("largeUploadPlatforms", () => {
  it("is empty by default: the new path is off everywhere until a platform is listed", () => {
    expect(DEFAULT_LARGE_UPLOAD_PLATFORMS.size).toBe(0);
    expect(largeUploadPlatforms({}).size).toBe(0);
    expect(largeUploadPlatforms({ LARGE_UPLOAD_PLATFORMS: "" }).size).toBe(0);
    expect(largeUploadPlatforms({ LARGE_UPLOAD_PLATFORMS: "   " }).size).toBe(0);
  });

  it("lists exactly the platforms named", () => {
    expect([...largeUploadPlatforms({ LARGE_UPLOAD_PLATFORMS: "youtube" })]).toEqual(["youtube"]);
    expect(
      new Set(largeUploadPlatforms({ LARGE_UPLOAD_PLATFORMS: "youtube,x,tiktok,linkedin" })),
    ).toEqual(new Set(["youtube", "x", "tiktok", "linkedin"]));
  });

  it("ignores case, spaces, repeats and empty entries", () => {
    expect(
      new Set(largeUploadPlatforms({ LARGE_UPLOAD_PLATFORMS: " YouTube , x,,X " })),
    ).toEqual(new Set(["youtube", "x"]));
  });

  it("ignores unknown names and platforms that have no large-upload path", () => {
    expect([...largeUploadPlatforms({ LARGE_UPLOAD_PLATFORMS: "youtube,vimeo,instagram" })]).toEqual([
      "youtube",
    ]);
    expect(largeUploadPlatforms({ LARGE_UPLOAD_PLATFORMS: "vimeo" }).size).toBe(0);
    expect(largeUploadPlatforms({ LARGE_UPLOAD_PLATFORMS: "1" }).size).toBe(0);
  });

  it("treats none as off for every platform, wherever it appears", () => {
    expect(largeUploadPlatforms({ LARGE_UPLOAD_PLATFORMS: "none" }).size).toBe(0);
    expect(largeUploadPlatforms({ LARGE_UPLOAD_PLATFORMS: "NONE" }).size).toBe(0);
    expect(largeUploadPlatforms({ LARGE_UPLOAD_PLATFORMS: "youtube,none" }).size).toBe(0);
  });

  it("reads process.env when no env is passed", () => {
    vi.stubEnv("LARGE_UPLOAD_PLATFORMS", "tiktok");
    expect([...largeUploadPlatforms()]).toEqual(["tiktok"]);
  });
});

describe("usesLargeUploadPath", () => {
  const ALL = { LARGE_UPLOAD_PLATFORMS: "youtube,x,tiktok,linkedin" };
  const base = {
    platform: "youtube" as const,
    mimeType: "video/mp4",
    sizeBytes: LARGE_VIDEO_THRESHOLD_BYTES + 1,
    hasState: false,
    hasStore: true,
    env: ALL,
  };

  it("keeps 50 MiB on today's path and moves 50 MiB + 1 to the new one", () => {
    expect(usesLargeUploadPath({ ...base, sizeBytes: 52_428_800 })).toBe(false);
    expect(usesLargeUploadPath({ ...base, sizeBytes: 52_428_801 })).toBe(true);
  });

  it("uses the new path only for videos", () => {
    expect(usesLargeUploadPath({ ...base, mimeType: "image/jpeg" })).toBe(false);
    expect(usesLargeUploadPath({ ...base, mimeType: "" })).toBe(false);
  });

  it("needs a store to save its progress in, even for a result with saved state", () => {
    expect(usesLargeUploadPath({ ...base, hasStore: false })).toBe(false);
    expect(usesLargeUploadPath({ ...base, hasStore: false, hasState: true })).toBe(false);
  });

  it("is off for every platform with no LARGE_UPLOAD_PLATFORMS set", () => {
    for (const platform of ["youtube", "x", "tiktok", "linkedin", "instagram", "facebook_page"] as const) {
      expect(usesLargeUploadPath({ ...base, platform, env: {} })).toBe(false);
      expect(usesLargeUploadPath({ ...base, platform, env: { LARGE_UPLOAD_PLATFORMS: "" } })).toBe(false);
    }
  });

  it("is on only for the listed platform", () => {
    const env = { LARGE_UPLOAD_PLATFORMS: "youtube" };
    expect(usesLargeUploadPath({ ...base, platform: "youtube", env })).toBe(true);
    expect(usesLargeUploadPath({ ...base, platform: "x", env })).toBe(false);
    expect(usesLargeUploadPath({ ...base, platform: "tiktok", env })).toBe(false);
  });

  it("keeps a result with saved state on the new path after the platform is switched off", () => {
    const env = { LARGE_UPLOAD_PLATFORMS: "youtube" };
    expect(usesLargeUploadPath({ ...base, platform: "x", env, hasState: true })).toBe(true);
    expect(usesLargeUploadPath({ ...base, platform: "x", env: { LARGE_UPLOAD_PLATFORMS: "none" }, hasState: true })).toBe(true);
    expect(usesLargeUploadPath({ ...base, platform: "x", env: {}, hasState: true })).toBe(true);
  });

  it("turns every platform off with none", () => {
    for (const platform of ["youtube", "x", "tiktok", "linkedin"] as const) {
      expect(usesLargeUploadPath({ ...base, platform, env: { LARGE_UPLOAD_PLATFORMS: "none" } })).toBe(false);
    }
  });

  it("never enables a platform without a large-upload path", () => {
    const env = { LARGE_UPLOAD_PLATFORMS: "instagram,facebook_page,google_business_profile" };
    expect(usesLargeUploadPath({ ...base, platform: "instagram", env })).toBe(false);
  });

  it("reads process.env when no env is passed", () => {
    vi.stubEnv("LARGE_UPLOAD_PLATFORMS", "linkedin");
    const args = { ...base, env: undefined };
    expect(usesLargeUploadPath({ ...args, platform: "linkedin" })).toBe(true);
    expect(usesLargeUploadPath({ ...args, platform: "youtube" })).toBe(false);
  });
});
