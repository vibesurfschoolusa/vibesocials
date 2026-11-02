import { Prisma } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// vitest hoists vi.mock above imports. Only the two PostJobResult methods the
// store touches are mocked; nothing here reaches a database.
const { updateManyMock, findUniqueMock } = vi.hoisted(() => ({
  updateManyMock: vi.fn(),
  findUniqueMock: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    postJobResult: {
      updateMany: updateManyMock,
      findUnique: findUniqueMock,
    },
  },
}));

import { logger } from "@/lib/logger";
import { isSealedSecret } from "@/lib/tokenCrypto";

import {
  MAX_UPLOAD_STATE_BYTES,
  RESULT_CLAIM_LOST_CODE,
  UPLOAD_INCOMPLETE,
  UPLOAD_STATE_PLAINTEXT_URL_CODE,
  UPLOAD_STATE_TOO_LARGE_CODE,
  UPLOAD_STATE_VERSION,
  createUploadStateStore,
  type UploadStateStore,
} from "./uploadState";

const KEY_A = Buffer.alloc(32, 7).toString("base64");
const KEY_B = Buffer.alloc(32, 9).toString("base64");
const SESSION_URI = "https://upload.example/session?upload_id=capability-1";

const ARGS = { resultId: "r1", runId: "run-1", platform: "youtube" } as const;

/** The JSON the store wrote, as the next step's `findUnique` would return it. */
function lastStored(): Record<string, unknown> {
  const call = updateManyMock.mock.calls.at(-1)?.[0] as { data: { uploadState: Record<string, unknown> } };
  return call.data.uploadState;
}

function storeReturns(uploadState: unknown) {
  findUniqueMock.mockResolvedValue(uploadState === undefined ? null : { uploadState });
}

let prevKey: string | undefined;

beforeEach(() => {
  updateManyMock.mockReset();
  findUniqueMock.mockReset();
  updateManyMock.mockResolvedValue({ count: 1 });
  prevKey = process.env.TOKEN_ENCRYPTION_KEY;
  process.env.TOKEN_ENCRYPTION_KEY = KEY_A;
  vi.spyOn(logger, "warn").mockImplementation(() => {});
});

afterEach(() => {
  if (prevKey === undefined) delete process.env.TOKEN_ENCRYPTION_KEY;
  else process.env.TOKEN_ENCRYPTION_KEY = prevKey;
  vi.restoreAllMocks();
});

describe("constants", () => {
  it("pins the documented values", () => {
    expect(UPLOAD_STATE_VERSION).toBe(1);
    expect(MAX_UPLOAD_STATE_BYTES).toBe(524_288);
    expect(RESULT_CLAIM_LOST_CODE).toBe("RESULT_CLAIM_LOST");
    expect(UPLOAD_STATE_TOO_LARGE_CODE).toBe("UPLOAD_STATE_TOO_LARGE");
    expect(UPLOAD_STATE_PLAINTEXT_URL_CODE).toBe("UPLOAD_STATE_PLAINTEXT_URL");
  });

  it("words UPLOAD_INCOMPLETE so the user knows nothing was posted", () => {
    expect(UPLOAD_INCOMPLETE).toEqual({
      errorCode: "UPLOAD_INCOMPLETE",
      errorMessage: "The upload didn't finish in time. Nothing was posted — please retry.",
    });
  });
});

describe("createUploadStateStore - save", () => {
  it("writes one claim-scoped updateMany (this run's claim, still pending)", async () => {
    const store = createUploadStateStore(ARGS);

    await store.save("youtube_resumable", {
      data: { confirmed: 5 },
      secret: { sessionUri: SESSION_URI },
    });

    expect(updateManyMock).toHaveBeenCalledTimes(1);
    const call = updateManyMock.mock.calls[0][0] as { where: unknown; data: Record<string, unknown> };
    expect(call.where).toEqual({ id: "r1", claimRunId: "run-1", status: "pending" });
    expect(Object.keys(call.data)).toEqual(["uploadState"]);
  });

  it("stores { v, runId, platform, kind, savedAt, data, secret } with the capability URL only inside the sealed secret", async () => {
    const store = createUploadStateStore(ARGS);

    await store.save("youtube_resumable", {
      data: { confirmed: 5 },
      secret: { sessionUri: SESSION_URI },
    });

    const stored = lastStored();
    expect(stored).toMatchObject({
      v: 1,
      runId: "run-1",
      platform: "youtube",
      kind: "youtube_resumable",
      data: { confirmed: 5 },
    });
    expect(Number.isNaN(Date.parse(stored.savedAt as string))).toBe(false);
    // The secret is sealed (AES-GCM), so the URL does not appear anywhere in the JSON.
    expect(typeof stored.secret).toBe("string");
    expect(isSealedSecret(stored.secret as string)).toBe(true);
    expect(stored.secret).not.toBe(SESSION_URI);
    expect(JSON.stringify(stored)).not.toContain(SESSION_URI);
    expect(JSON.stringify(stored)).not.toContain("https://");
  });

  it("stamps savedAt with the current time", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-02T10:00:00.000Z"));
    try {
      await createUploadStateStore(ARGS).save("k", { data: {} });
      expect(lastStored().savedAt).toBe("2026-11-02T10:00:00.000Z");
    } finally {
      vi.useRealTimers();
    }
  });

  it("omits the secret key when the snapshot has none", async () => {
    await createUploadStateStore(ARGS).save("x_chunked", { data: { mediaId: "m1" } });

    expect(Object.keys(lastStored())).not.toContain("secret");
  });

  it("throws RESULT_CLAIM_LOST when the claim is no longer held (count 0)", async () => {
    updateManyMock.mockResolvedValue({ count: 0 });

    const failure = await createUploadStateStore(ARGS)
      .save("youtube_resumable", { data: { confirmed: 5 } })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    expect((failure as { code?: string }).code).toBe("RESULT_CLAIM_LOST");
    // The message is what lands on the result row: it says what happened and what to do.
    expect((failure as Error).message).toMatch(/nothing was posted/i);
  });

  it("throws UPLOAD_STATE_TOO_LARGE for a 600 KB state, and writes nothing", async () => {
    const failure = await createUploadStateStore(ARGS)
      .save("x_chunked", { data: { blob: "x".repeat(600 * 1024) } })
      .catch((error: unknown) => error);

    expect((failure as { code?: string }).code).toBe("UPLOAD_STATE_TOO_LARGE");
    expect((failure as Error).message).toMatch(/nothing was posted/i);
    expect(updateManyMock).not.toHaveBeenCalled();
  });

  it("counts the sealed secret toward the size cap", async () => {
    const failure = await createUploadStateStore(ARGS)
      .save("linkedin_multipart", { data: {}, secret: { parts: "u".repeat(600 * 1024) } })
      .catch((error: unknown) => error);

    expect((failure as { code?: string }).code).toBe("UPLOAD_STATE_TOO_LARGE");
  });

  it("accepts a state just under the cap", async () => {
    await createUploadStateStore(ARGS).save("x_chunked", { data: { blob: "x".repeat(400 * 1024) } });

    expect(updateManyMock).toHaveBeenCalledTimes(1);
  });

  // 2026-11-02 scale audit (jobs B3): `data` is stored readable. A capability URL
  // saved there by mistake would sit in the table in plaintext, so the store
  // refuses it; URLs belong only in the sealed `secret`.
  describe("a URL in the readable data", () => {
    const plaintextUrl = async (data: unknown) =>
      (await createUploadStateStore(ARGS)
        .save("youtube_resumable", { data, secret: { sessionUri: SESSION_URI } })
        .catch((error: unknown) => error)) as Error & { code?: string };

    it.each([
      ["a top-level field", { sessionUri: SESSION_URI }],
      ["a nested field", { session: { uri: SESSION_URI } }],
      ["an array element", { parts: [{ url: SESSION_URI }] }],
      ["a plain string", SESSION_URI],
      ["a non-https scheme", { uploadUrl: "ftp://upload.example/x" }],
    ])("is refused with UPLOAD_STATE_PLAINTEXT_URL, and nothing is written (%s)", async (_label, data) => {
      const failure = await plaintextUrl(data);

      expect(failure).toBeInstanceOf(Error);
      expect(failure.code).toBe("UPLOAD_STATE_PLAINTEXT_URL");
      expect(updateManyMock).not.toHaveBeenCalled();
    });

    it("does not put the URL in the error it throws", async () => {
      const failure = await plaintextUrl({ sessionUri: SESSION_URI });

      expect(String(failure.message)).not.toContain(SESSION_URI);
      expect(String(failure.message)).not.toContain("upload.example");
      expect(failure.message).toMatch(/nothing was posted/i);
    });

    it("accepts data with no URL, and a secret that holds one", async () => {
      await createUploadStateStore(ARGS).save("youtube_resumable", {
        data: { totalBytes: 100, confirmedBytes: 0, note: "http is fine as a word" },
        secret: { sessionUri: SESSION_URI },
      });

      expect(updateManyMock).toHaveBeenCalledTimes(1);
    });
  });

  it("does not put the capability URL in the error it throws", async () => {
    updateManyMock.mockResolvedValue({ count: 0 });

    const failure = await createUploadStateStore(ARGS)
      .save("youtube_resumable", { data: {}, secret: { sessionUri: SESSION_URI } })
      .catch((error: unknown) => error);

    expect(String((failure as Error).message)).not.toContain(SESSION_URI);
  });
});

describe("createUploadStateStore - load", () => {
  /** Save with `store`, then make the next `findUnique` return what it wrote. */
  async function saved(store: UploadStateStore, kind = "youtube_resumable") {
    await store.save(kind, { data: { confirmed: 5 }, secret: { sessionUri: SESSION_URI } });
    storeReturns(lastStored());
  }

  it("round-trips data and the unsealed secret", async () => {
    const store = createUploadStateStore(ARGS);
    await saved(store);

    const snapshot = await store.load<{ confirmed: number }, { sessionUri: string }>("youtube_resumable");

    expect(snapshot).toEqual({ data: { confirmed: 5 }, secret: { sessionUri: SESSION_URI } });
    expect(findUniqueMock).toHaveBeenCalledWith({
      where: { id: "r1" },
      select: { uploadState: true },
    });
  });

  it("returns no secret key for a snapshot saved without one", async () => {
    const store = createUploadStateStore(ARGS);
    await store.save("x_chunked", { data: { mediaId: "m1" } });
    storeReturns(lastStored());

    expect(await store.load("x_chunked")).toEqual({ data: { mediaId: "m1" } });
  });

  it("ignores state saved by another run, so a retry starts fresh", async () => {
    await saved(createUploadStateStore(ARGS));

    const otherRun = createUploadStateStore({ ...ARGS, runId: "run-2" });

    expect(await otherRun.load("youtube_resumable")).toBeNull();
  });

  it("ignores state of another kind", async () => {
    const store = createUploadStateStore(ARGS);
    await saved(store);

    expect(await store.load("tiktok_chunked")).toBeNull();
  });

  it("ignores state saved for another platform", async () => {
    await saved(createUploadStateStore(ARGS));

    expect(await createUploadStateStore({ ...ARGS, platform: "tiktok" }).load("youtube_resumable")).toBeNull();
  });

  it("ignores state of another version", async () => {
    const store = createUploadStateStore(ARGS);
    await saved(store);
    storeReturns({ ...lastStored(), v: 2 });

    expect(await store.load("youtube_resumable")).toBeNull();
  });

  it.each([
    ["no row", undefined],
    ["a null column", null],
    ["a string", "oops"],
    ["an array", [1, 2]],
    ["an object without the header", { data: { confirmed: 5 } }],
  ])("returns null for %s", async (_label, value) => {
    if (value === undefined) findUniqueMock.mockResolvedValue(null);
    else findUniqueMock.mockResolvedValue({ uploadState: value });

    expect(await createUploadStateStore(ARGS).load("youtube_resumable")).toBeNull();
  });

  it("returns null and warns, without the secret, when the secret cannot be opened (another key)", async () => {
    const store = createUploadStateStore(ARGS);
    await saved(store);
    process.env.TOKEN_ENCRYPTION_KEY = KEY_B;

    const snapshot = await store.load("youtube_resumable");

    expect(snapshot).toBeNull();
    expect(logger.warn).toHaveBeenCalledTimes(1);
    const logged = JSON.stringify(vi.mocked(logger.warn).mock.calls);
    expect(logged).toContain("r1");
    expect(logged).not.toContain(SESSION_URI);
    expect(logged).not.toContain((lastStored().secret as string).slice(0, 20));
  });

  it("returns null and warns when the secret opens to something that is not JSON", async () => {
    const store = createUploadStateStore(ARGS);
    await saved(store);
    storeReturns({ ...lastStored(), secret: "not-sealed and not json" });

    expect(await store.load("youtube_resumable")).toBeNull();
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });
});

describe("createUploadStateStore - clear", () => {
  it("nulls the column under the same claim scope", async () => {
    await createUploadStateStore(ARGS).clear();

    expect(updateManyMock).toHaveBeenCalledTimes(1);
    expect(updateManyMock).toHaveBeenCalledWith({
      where: { id: "r1", claimRunId: "run-1", status: "pending" },
      data: { uploadState: Prisma.DbNull },
    });
  });

  it("does not throw when nothing matched (the claim is gone or the state was already cleared)", async () => {
    updateManyMock.mockResolvedValue({ count: 0 });

    await expect(createUploadStateStore(ARGS).clear()).resolves.toBeUndefined();
  });
});
