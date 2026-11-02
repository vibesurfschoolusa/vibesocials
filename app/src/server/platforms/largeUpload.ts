import type { Platform } from "@prisma/client";

import { FETCH_TIMEOUT_CODE, fetchWithTimeout } from "@/lib/fetchWithTimeout";
import { logger } from "@/lib/logger";

import { budgetedTimeout, PUBLISH_BUDGET_EXCEEDED_CODE, PUBLISH_STEP_BUDGET_MS } from "./publishBudget";

/**
 * 2026-11-02 scale audit (jobs B3): primitives for uploading a large video
 * without holding it in memory.
 *
 * Today every platform client downloads the whole video into one buffer: up to
 * 512 MB, and YouTube keeps a second copy for its multipart body. Above
 * {@link LARGE_VIDEO_THRESHOLD_BYTES} the clients read the blob through
 * {@link openBlobChunkStream} instead and send it in parts of at most
 * {@link LARGE_UPLOAD_MAX_PART_BYTES}, across several steps. This file holds only
 * the shared pieces: the stream, the size threshold and the per-platform switch.
 */

/**
 * Videos above this many bytes (50 MiB) take the chunked path; anything up to it
 * keeps today's buffered path, which is proven and covers most posts. At the
 * threshold the buffered path peaks at about 100 MB per step (YouTube's second
 * copy) and fits the 120 s request timeouts at 0.42 MB/s, while X needs only ten
 * APPEND calls.
 */
export const LARGE_VIDEO_THRESHOLD_BYTES = 52_428_800;

/**
 * A chunk that does not commit the upload starts only with this much of the step
 * left, so it has time to finish and to save its progress. The commit call (the
 * last request, which publishes) is exempt: it never crosses a step boundary.
 */
export const LARGE_UPLOAD_CHUNK_WINDOW_MS = 60_000;

/**
 * Timeout of each request a chunked upload sends to a platform. Always passed
 * through `budgetedTimeout`, so a request started late still ends by the deadline.
 */
export const LARGE_UPLOAD_REQUEST_TIMEOUT_MS = 120_000;

/**
 * The most media (64 MiB) a chunked upload holds in memory for one request. A
 * part the vendor chooses (LinkedIn) that is larger than this is refused before
 * any upload starts.
 */
export const LARGE_UPLOAD_MAX_PART_BYTES = 67_108_864;

/** The blob's size is not the size recorded for the media. Nothing was uploaded. */
export const MEDIA_SIZE_MISMATCH_CODE = "MEDIA_SIZE_MISMATCH";

/** The blob could not be read: an unexpected status, an unusable range, or a body that failed or ended early. */
export const BLOB_READ_FAILED_CODE = "BLOB_READ_FAILED";

/**
 * Platforms that have a chunked upload path. The switch below can only name
 * these; every other platform keeps the buffered path.
 */
const LARGE_UPLOAD_CAPABLE_PLATFORMS: readonly Platform[] = ["youtube", "x", "tiktok", "linkedin"];

/**
 * Platforms on the chunked path when `LARGE_UPLOAD_PLATFORMS` is unset or has no
 * usable name: none. The streamed paths rely on vendor behaviour that could not
 * be confirmed from the vendors' documentation (whether Vercel Blob honours
 * Range, the YouTube session lifetime, X's v1.1 APPEND limits, LinkedIn's
 * multipart calls, how TikTok reports an out-of-sync chunk), so a platform is
 * switched on only after a ~100 MB test video went through its sandbox account
 * (docs/STAGING_SETUP.md).
 */
export const DEFAULT_LARGE_UPLOAD_PLATFORMS: ReadonlySet<Platform> = new Set();

/**
 * The platforms on the chunked path, from `LARGE_UPLOAD_PLATFORMS`: a comma list
 * of `youtube`, `x`, `tiktok` and `linkedin`, case and spacing ignored.
 *
 * - `none`, anywhere in the list, turns every platform off.
 * - Unknown names, and platforms with no chunked path, are ignored.
 * - A missing or empty value, or one with no usable name, gives
 *   {@link DEFAULT_LARGE_UPLOAD_PLATFORMS}.
 *
 * It is read at call time, so a change takes effect at the next deploy.
 */
export function largeUploadPlatforms(
  env: Record<string, string | undefined> = process.env,
): ReadonlySet<Platform> {
  const names = (env.LARGE_UPLOAD_PLATFORMS ?? "")
    .split(",")
    .map((name) => name.trim().toLowerCase())
    .filter((name) => name !== "");
  if (names.includes("none")) return new Set();
  const listed = LARGE_UPLOAD_CAPABLE_PLATFORMS.filter((platform) => names.includes(platform));
  return listed.length > 0 ? new Set(listed) : DEFAULT_LARGE_UPLOAD_PLATFORMS;
}

/**
 * Should this platform upload this media on the chunked path?
 *
 * - No store (a direct caller, a test): no. Progress has nowhere to be saved.
 * - A result that already has saved state for this run: yes, whatever the switch
 *   says, so switching a platform off never strands an upload that has started.
 * - Otherwise: only a video above {@link LARGE_VIDEO_THRESHOLD_BYTES} on a
 *   platform that {@link largeUploadPlatforms} lists.
 */
export function usesLargeUploadPath(args: {
  platform: Platform;
  mimeType: string;
  sizeBytes: number;
  hasState: boolean;
  hasStore: boolean;
  env?: Record<string, string | undefined>;
}): boolean {
  if (!args.hasStore) return false;
  if (args.hasState) return true;
  if (!args.mimeType.startsWith("video/")) return false;
  if (!(args.sizeBytes > LARGE_VIDEO_THRESHOLD_BYTES)) return false;
  return largeUploadPlatforms(args.env).has(args.platform);
}

/**
 * Did a request of a chunked upload fail in a way that says nothing about the upload: a 5xx, a
 * timeout, a dropped connection, or no time left to send it? The same request can simply be made
 * again later, so the step saves its place and pauses instead of failing. Shared by the streamed
 * clients (YouTube, TikTok, X, LinkedIn).
 *
 * Only undici's own network failures count among the TypeErrors (`fetch failed`, `terminated`):
 * any other TypeError is a bug and must surface. A 4xx, a rate limit or an error we do not
 * recognise says something definite and is not this.
 */
export function isTransientUploadFailure(error: unknown): boolean {
  if (error instanceof TypeError) return error.message === "fetch failed" || error.message === "terminated";
  const { code, status } = (error ?? {}) as { code?: unknown; status?: unknown };
  return (
    code === FETCH_TIMEOUT_CODE ||
    code === PUBLISH_BUDGET_EXCEEDED_CODE ||
    (typeof status === "number" && status >= 500)
  );
}

type CodedError = Error & { code: string; status?: number };

function codedError(
  code: string,
  message: string,
  extra: { status?: number; cause?: unknown } = {},
): CodedError {
  const error = new Error(message, extra.cause === undefined ? undefined : { cause: extra.cause }) as CodedError;
  error.code = code;
  if (extra.status !== undefined) error.status = extra.status;
  return error;
}

function blobReadFailed(message: string, extra: { status?: number; cause?: unknown } = {}): CodedError {
  return codedError(BLOB_READ_FAILED_CODE, message, extra);
}

function sizeMismatch(): CodedError {
  return codedError(
    MEDIA_SIZE_MISMATCH_CODE,
    "The stored video's size doesn't match the size recorded for it. Nothing was uploaded.",
  );
}

/** A sequential reader over a blob's bytes that never holds more than the read asked for plus one source chunk. */
export interface BlobChunkStream {
  /**
   * The next `bytes` bytes. It returns fewer only at the end of the blob (and an
   * empty buffer after it); a body that ends before the recorded size throws
   * {@link BLOB_READ_FAILED_CODE} instead of returning a short read that would
   * look like the end. Reads must not overlap.
   */
  read(bytes: number): Promise<Buffer>;
  /** Absolute offset in the blob of the next byte `read` returns. */
  readonly position: number;
  /** Stops the download. Safe to call more than once. */
  close(): Promise<void>;
}

let rangeIgnoredLogged = false;

class BlobBodyStream implements BlobChunkStream {
  position: number;
  private leftover: Buffer | null = null;
  private closed = false;
  private failure: CodedError | null = null;

  constructor(
    private readonly reader: ReadableStreamDefaultReader<Uint8Array>,
    offset: number,
    private readonly totalBytes: number,
  ) {
    this.position = offset;
  }

  async read(bytes: number): Promise<Buffer> {
    if (!Number.isSafeInteger(bytes) || bytes < 0) {
      throw new RangeError("read() needs a whole, non-negative number of bytes");
    }
    if (this.failure) throw this.failure;
    if (this.closed) throw blobReadFailed("The stored video's stream was already closed.");
    const want = Math.min(bytes, this.totalBytes - this.position);
    if (want === 0) return Buffer.alloc(0);

    // Every byte of `out` is written before it is returned; on a failure it is dropped.
    const out = Buffer.allocUnsafe(want);
    await this.take(want, out);
    this.position += want;
    return out;
  }

  /** Discards `bytes` bytes from the front of the body (used when Range was ignored). */
  async skip(bytes: number): Promise<void> {
    await this.take(bytes, null);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.leftover = null;
    await this.reader.cancel().catch(() => undefined);
  }

  /** Moves `want` bytes from the body into `out` (or drops them), pulling the reader only when it has to. */
  private async take(want: number, out: Buffer | null): Promise<void> {
    try {
      let done = 0;
      while (done < want) {
        if (this.leftover === null) this.leftover = await this.pull();
        const available = this.leftover.length;
        const count = Math.min(available, want - done);
        if (out) this.leftover.copy(out, done, 0, count);
        this.leftover = count === available ? null : this.leftover.subarray(count);
        done += count;
      }
    } catch (error) {
      // A partly consumed stream can't be resumed: every later read fails the same way.
      this.failure =
        (error as Partial<CodedError> | null)?.code === BLOB_READ_FAILED_CODE
          ? (error as CodedError)
          : blobReadFailed("Reading the stored video failed part-way through.", { cause: error });
      throw this.failure;
    }
  }

  private async pull(): Promise<Buffer> {
    const { done, value } = await this.reader.read();
    if (done) {
      throw blobReadFailed("The stored video ended before its recorded size. Nothing more was uploaded.");
    }
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }
}

/** The bytes of a `Content-Range: bytes first-last/total` header, or null when it isn't that. */
function parseContentRange(header: string | null): { first: number; last: number; total: number } | null {
  const match = /^bytes (\d+)-(\d+)\/(\d+)$/i.exec(header?.trim() ?? "");
  if (!match) return null;
  const [first, last, total] = [Number(match[1]), Number(match[2]), Number(match[3])];
  return [first, last, total].every(Number.isSafeInteger) ? { first, last, total } : null;
}

async function discardBody(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

/**
 * Opens the blob at `url` for reading from `offset`, with one `GET` for the whole
 * step: `Range: bytes=<offset>-`, aborted by the time left before `deadline`
 * (never more than one step's budget, and a spent budget throws
 * PUBLISH_TIME_BUDGET_EXCEEDED before the request). `totalBytes` is the size
 * recorded for the media.
 *
 * Whether Vercel Blob honours Range is unconfirmed (its docs don't say;
 * https://vercel.com/docs/vercel-blob), so both answers are accepted:
 * - 206 whose `Content-Range` is `bytes <offset>-<total-1>/<total>`;
 * - 200 whose `Content-Length` is `totalBytes`: the first `offset` bytes are read
 *   and dropped as they stream by (logged once per process as `range_ignored`).
 *
 * A total or length that isn't `totalBytes` throws {@link MEDIA_SIZE_MISMATCH_CODE};
 * any other answer throws {@link BLOB_READ_FAILED_CODE} (with `status`), all before
 * a single byte is uploaded. A failure of the request itself is rethrown as is, so
 * the transient-retry rules classify it. The reader is pulled only when `read`
 * needs bytes, so memory stays at the read plus one source chunk whatever the
 * blob's size.
 */
export async function openBlobChunkStream(
  url: string,
  opts: { offset: number; totalBytes: number; deadline?: number },
): Promise<BlobChunkStream> {
  const { offset, totalBytes, deadline } = opts;
  if (!Number.isSafeInteger(totalBytes) || totalBytes <= 0) {
    throw new RangeError("totalBytes must be a positive whole number");
  }
  if (!Number.isSafeInteger(offset) || offset < 0 || offset >= totalBytes) {
    throw new RangeError("offset must be a whole number inside the blob");
  }

  const timeoutMs = budgetedTimeout(PUBLISH_STEP_BUDGET_MS, deadline);
  const response = await fetchWithTimeout(
    url,
    { headers: { Range: `bytes=${offset}-` }, signal: AbortSignal.timeout(timeoutMs) },
    timeoutMs,
  );

  try {
    if (response.status === 206) {
      const range = parseContentRange(response.headers.get("Content-Range"));
      if (!range) throw blobReadFailed("The stored video's range answer was unreadable.", { status: 206 });
      if (range.total !== totalBytes) throw sizeMismatch();
      if (range.first !== offset || range.last !== totalBytes - 1) {
        throw blobReadFailed("The stored video answered a different range than asked for.", { status: 206 });
      }
    } else if (response.status === 200) {
      const header = response.headers.get("Content-Length");
      const length = header !== null && /^\d+$/.test(header.trim()) ? Number(header) : null;
      if (length === null) {
        throw blobReadFailed("The stored video's size couldn't be checked.", { status: 200 });
      }
      if (length !== totalBytes) throw sizeMismatch();
    } else {
      throw blobReadFailed(`The stored video couldn't be read (status ${response.status}).`, {
        status: response.status,
      });
    }
    if (!response.body) throw blobReadFailed("The stored video had no content.", { status: response.status });
  } catch (error) {
    await discardBody(response);
    throw error;
  }

  const stream = new BlobBodyStream(response.body.getReader(), offset, totalBytes);
  if (response.status === 200 && offset > 0) {
    if (!rangeIgnoredLogged) {
      rangeIgnoredLogged = true;
      logger.info("range_ignored", { offset, totalBytes });
    }
    try {
      await stream.skip(offset);
    } catch (error) {
      await stream.close();
      throw error;
    }
  }
  return stream;
}
