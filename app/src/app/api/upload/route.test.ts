import { beforeEach, describe, expect, it, vi } from "vitest";

import { makeWorkspaceContext } from "../__test-helpers__/workspaceContextMock";

const {
  getWorkspaceContextMock,
  checkRateLimitMock,
  handleUploadMock,
  checkStorageLimitMock,
  consumeDayBytesMock,
  releaseDayBytesMock,
} = vi.hoisted(() => ({
  getWorkspaceContextMock: vi.fn(),
  checkRateLimitMock: vi.fn(),
  handleUploadMock: vi.fn(),
  checkStorageLimitMock: vi.fn(),
  consumeDayBytesMock: vi.fn(),
  releaseDayBytesMock: vi.fn(),
}));

/**
 * The RateLimitEntry rows the refusal memory keeps (uploadRefusal.ts runs for
 * real on them), so a refusal, the page's question and a later upload meet.
 */
const refusalRows = vi.hoisted(() => new Map<string, { key: string; count: number; expiresAt: Date }>());
vi.mock("@/lib/db", () => ({
  prisma: {
    rateLimitEntry: {
      upsert: async ({ where, create, update }: { where: { key: string }; create: { key: string; count: number; expiresAt: Date }; update: { count: number; expiresAt: Date } }) => {
        const row = refusalRows.has(where.key) ? { ...refusalRows.get(where.key)!, ...update } : create;
        refusalRows.set(where.key, row);
        return row;
      },
      findUnique: async ({ where }: { where: { key: string } }) => refusalRows.get(where.key) ?? null,
      deleteMany: async ({ where }: { where: { key: string } }) => ({ count: refusalRows.delete(where.key) ? 1 : 0 }),
    },
  },
}));

vi.mock("@/lib/workspace", () => ({ getWorkspaceContext: getWorkspaceContextMock }));
vi.mock("@/lib/rateLimit", () => ({ checkRateLimit: checkRateLimitMock }));
vi.mock("@vercel/blob/client", () => ({ handleUpload: handleUploadMock }));
// Usage limits (2026-11-10): the storage sum has its own suite (workspaceUsage.test.ts).
vi.mock("@/server/usage/workspaceUsage", () => ({ checkStorageLimit: checkStorageLimitMock }));
// The day's byte counter has its own suite (uploadBudget.test.ts); the size reader is real.
vi.mock("./uploadBudget", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./uploadBudget")>()),
  consumeUploadDayBytes: consumeDayBytesMock,
  releaseUploadDayBytes: releaseDayBytesMock,
}));

import { COVER_ADDRESS_REFUSED_MESSAGE } from "@/lib/coverBlobPath";
import { UPLOAD_PATH_REFUSED_MESSAGE } from "@/lib/blobKey";
import { LOGO_ADDRESS_RESERVED_MESSAGE } from "@/lib/workspaceLogo";
import { UPLOAD_ALLOWED_CONTENT_TYPES } from "@/lib/mediaInput";
import { COVER_IMAGE_MAX_BYTES, COVER_IMAGE_RULE, COVER_IMAGE_TYPES } from "@/lib/videoCover";

import { LIMIT_UNCHECKED_MESSAGE } from "@/lib/limitUnchecked";
import { explainUploadFailure } from "@/lib/uploadFailure";

import {
  MISSING_WORKSPACE_ID_CODE,
  WORKSPACE_CHANGED_CODE,
  WORKSPACE_CHANGED_SAVE_MESSAGE,
} from "@/lib/workspaceChanged";
import { logger } from "@/lib/logger";
import { GET, POST } from "./route";

/** R32: a read from a page drawn for `workspaceId` (the mock's own by default; null sends none). */
function req(workspaceId: string | null = "ws-1", query = ""): Request {
  const address = new URL(`http://localhost/api/upload${query}`);
  if (workspaceId !== null) address.searchParams.set("workspaceId", workspaceId);
  return new Request(address);
}
import { UPLOAD_BYTES_LIMIT_MESSAGE, UPLOAD_SIZE_MISSING_MESSAGE } from "./uploadBudget";
import { UPLOAD_DAY_LIMIT_MESSAGE, UPLOAD_PAGE_OUT_OF_DATE_MESSAGE } from "./uploadRefusal";

const FULL =
  "This workspace's media storage is full (5.0 GB). Delete media you no longer need on the Media page, then upload again.";

function tokenRequest(): Request {
  return new Request("http://localhost/api/upload?workspaceId=ws-1", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      type: "blob.generate-client-token",
      payload: { pathname: SIGNED_IN_KEY, clientPayload: SIZE_PAYLOAD, multipart: false },
    }),
  });
}

/** A key in the shape lib/blobKey.ts makes for Create, Add many and Media. */
const SIGNED_IN_KEY = "1731600000000-ab12cd34-cat.png";
const MB = 1024 * 1024;
/** What the pages send with each token request (lib/blobKey.ts uploadSizePayload). */
const SIZE_PAYLOAD = JSON.stringify({ size: 2 * MB });

beforeEach(() => {
  getWorkspaceContextMock.mockReset();
  checkRateLimitMock.mockReset();
  handleUploadMock.mockReset();
  checkStorageLimitMock.mockReset();
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});

  getWorkspaceContextMock.mockResolvedValue(makeWorkspaceContext());
  checkRateLimitMock.mockResolvedValue({ allowed: true });
  handleUploadMock.mockResolvedValue({ type: "blob.generate-client-token", clientToken: "tok" });
  checkStorageLimitMock.mockResolvedValue(null);
  consumeDayBytesMock.mockReset();
  releaseDayBytesMock.mockReset();
  consumeDayBytesMock.mockResolvedValue({ allowed: true });
  refusalRows.clear();
  releaseDayBytesMock.mockResolvedValue(undefined);
});

describe("POST /api/upload — storage limit (usage limits)", () => {
  it("401s when signed out", async () => {
    getWorkspaceContextMock.mockResolvedValue(null);
    const res = await POST(tokenRequest());
    expect(res.status).toBe(401);
    expect(handleUploadMock).not.toHaveBeenCalled();
  });

  it("issues a token under the limit", async () => {
    const res = await POST(tokenRequest());

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ type: "blob.generate-client-token", clientToken: "tok" });
    expect(checkStorageLimitMock).toHaveBeenCalledWith("ws-1");
  });

  it("refuses at the limit with the sentence, before any token is issued", async () => {
    checkStorageLimitMock.mockResolvedValue({ error: FULL, code: "WORKSPACE_STORAGE_FULL" });

    const res = await POST(tokenRequest());

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({ error: FULL, code: "WORKSPACE_STORAGE_FULL" });
    expect(handleUploadMock).not.toHaveBeenCalled();
  });
});

// Fix round 1 (18b): logos/ is the server's own; no client token may name it.
describe("POST /api/upload — the logos/ prefix is reserved", () => {
  it("refuses a token for a pathname under logos/ with a plain 400", async () => {
    for (const pathname of ["logos/0123456789abcdef0123456789abcdef.png", "/logos/x.png", "LOGOS/x.png"]) {
      const res = await POST(
        new Request("http://localhost/api/upload?workspaceId=ws-1", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            type: "blob.generate-client-token",
            payload: { pathname, clientPayload: SIZE_PAYLOAD, multipart: false },
          }),
        }),
      );
      expect(res.status, pathname).toBe(400);
      await expect(res.json()).resolves.toEqual({ error: LOGO_ADDRESS_RESERVED_MESSAGE });
    }
    expect(handleUploadMock).not.toHaveBeenCalled();
  });
});

// V1 fix round 1: a cover goes under covers/<workspace>/; no token for another's.
describe("POST /api/upload — the covers/ folder is the workspace's own", () => {
  const tokenFor = (pathname: string) =>
    POST(
      new Request("http://localhost/api/upload?workspaceId=ws-1", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "blob.generate-client-token",
          payload: { pathname, clientPayload: SIZE_PAYLOAD, multipart: false },
        }),
      }),
    );

  it("signs a token for this workspace's covers/ folder", async () => {
    expect((await tokenFor("covers/ws-1/1700-abc-cover.jpg")).status).toBe(200);
  });

  it("refuses another workspace's covers/ folder with a plain 400", async () => {
    for (const pathname of ["covers/ws-2/a.jpg", "Covers/ws-1/a.jpg", "covers/ws-1/../ws-2/a.jpg"]) {
      const res = await tokenFor(pathname);
      expect(res.status, pathname).toBe(400);
      await expect(res.json()).resolves.toEqual({ error: COVER_ADDRESS_REFUSED_MESSAGE });
    }
    expect(handleUploadMock).not.toHaveBeenCalled();
  });
});

// R2 M1: only the app's own key shapes are signed, so every signed file is one
// the orphan sweep can find and delete when nothing registers it.
describe("POST /api/upload — only the app's key shapes", () => {
  const tokenFor = (payload: unknown) =>
    POST(
      new Request("http://localhost/api/upload?workspaceId=ws-1", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "blob.generate-client-token", payload }),
      }),
    );

  it("signs a signed-in upload key and hands that pathname to the signer", async () => {
    const res = await tokenFor({ pathname: SIGNED_IN_KEY, clientPayload: SIZE_PAYLOAD, multipart: false });
    expect(res.status).toBe(200);
    expect(handleUploadMock).toHaveBeenCalledTimes(1);
  });

  it("refuses any other pathname with a plain 400 before a token is signed", async () => {
    for (const pathname of [
      "a.jpg",
      "stash/1731600000000-ab12cd34-cat.png",
      "ul/link-1/0123456789abcdef-cat.png",
      "1731600000000-ab12cd34-x/y.png",
      "",
    ]) {
      const res = await tokenFor({ pathname, clientPayload: SIZE_PAYLOAD, multipart: false });
      expect(res.status, pathname).toBe(400);
      await expect(res.json()).resolves.toEqual({ error: UPLOAD_PATH_REFUSED_MESSAGE });
    }
    expect(handleUploadMock).not.toHaveBeenCalled();
    expect(checkStorageLimitMock).not.toHaveBeenCalled();
  });

  it("refuses a token request that names no pathname", async () => {
    for (const payload of [undefined, null, {}, { pathname: 5 }]) {
      const res = await tokenFor(payload);
      expect(res.status).toBe(400);
    }
    expect(handleUploadMock).not.toHaveBeenCalled();
  });

  it("checks the pathname the signer is about to sign as well", async () => {
    let signerAnswer: Promise<unknown> | undefined;
    handleUploadMock.mockImplementation(async (options: { onBeforeGenerateToken: (p: string) => Promise<unknown> }) => {
      signerAnswer = options.onBeforeGenerateToken("elsewhere/a.jpg");
      await signerAnswer;
      return { type: "blob.generate-client-token", clientToken: "tok" };
    });
    const res = await tokenFor({ pathname: SIGNED_IN_KEY, clientPayload: SIZE_PAYLOAD, multipart: false });
    expect(res.status).toBe(400);
    await expect(signerAnswer).rejects.toThrow();
  });
});

// The size the page declares is binding (the token's maximum) and counted
// against the person's day, so neither a 1-byte claim nor many tokens can fill
// storage that is never counted.
describe("POST /api/upload — declared size and the day's bytes", () => {
  const tokenWith = (clientPayload: unknown, pathname = SIGNED_IN_KEY) =>
    POST(
      new Request("http://localhost/api/upload?workspaceId=ws-1", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "blob.generate-client-token",
          payload: { pathname, clientPayload, multipart: false },
        }),
      }),
    );

  /** What onBeforeGenerateToken answered for the signed pathname. */
  function captureTokenOptions() {
    const captured: { options?: Record<string, unknown> } = {};
    handleUploadMock.mockImplementation(
      async (opts: { body: { payload: { pathname: string; clientPayload: string | null } }; onBeforeGenerateToken: (p: string, c: string | null) => Promise<Record<string, unknown>> }) => {
        captured.options = await opts.onBeforeGenerateToken(opts.body.payload.pathname, opts.body.payload.clientPayload);
        return { type: "blob.generate-client-token", clientToken: "tok" };
      },
    );
    return captured;
  }

  it("signs a declared 2 MB file with a 2 MB maximum and counts 2 MB against the person's day", async () => {
    const captured = captureTokenOptions();
    const res = await tokenWith(JSON.stringify({ size: 2 * MB }));

    expect(res.status).toBe(200);
    expect(captured.options?.maximumSizeInBytes).toBe(2 * MB);
    expect(consumeDayBytesMock).toHaveBeenCalledWith("user-1", 2 * MB);
    expect(releaseDayBytesMock).not.toHaveBeenCalled();
  });

  it("binds a cover upload to its declared size too", async () => {
    const captured = captureTokenOptions();
    const res = await tokenWith(JSON.stringify({ size: 300_000 }), "covers/ws-1/1731600000000-ab12cd34-cover.jpg");

    expect(res.status).toBe(200);
    expect(captured.options?.maximumSizeInBytes).toBe(300_000);
  });

  // R3-security M1: a cover token takes only the cover image types and sizes.
  it("signs a cover token for JPEG images only, at most the declared size", async () => {
    const captured = captureTokenOptions();
    const res = await tokenWith(JSON.stringify({ size: 300_000 }), "covers/ws-1/1731600000000-ab12cd34-cover.jpg");

    expect(res.status).toBe(200);
    expect(captured.options?.allowedContentTypes).toEqual([...COVER_IMAGE_TYPES]);
    expect(captured.options?.maximumSizeInBytes).toBe(300_000);
  });

  it("refuses a cover token declared larger than a cover image may be (a video), counting and signing nothing", async () => {
    for (const size of [COVER_IMAGE_MAX_BYTES + 1, 400 * MB]) {
      const res = await tokenWith(JSON.stringify({ size }), "covers/ws-1/1731600000000-ab12cd34-cover.jpg");
      expect(res.status, String(size)).toBe(400);
      await expect(res.json()).resolves.toEqual({ error: COVER_IMAGE_RULE });
    }
    expect(consumeDayBytesMock).not.toHaveBeenCalled();
    expect(handleUploadMock).not.toHaveBeenCalled();
  });

  it("signs a cover of exactly the cover limit", async () => {
    const captured = captureTokenOptions();
    const res = await tokenWith(JSON.stringify({ size: COVER_IMAGE_MAX_BYTES }), "covers/ws-1/1731600000000-ab12cd34-cover.jpg");
    expect(res.status).toBe(200);
    expect(captured.options?.maximumSizeInBytes).toBe(COVER_IMAGE_MAX_BYTES);
  });

  it("a media token still takes every upload type", async () => {
    const captured = captureTokenOptions();
    await tokenWith(JSON.stringify({ size: 2 * MB }));
    expect(captured.options?.allowedContentTypes).toEqual([...UPLOAD_ALLOWED_CONTENT_TYPES]);
  });

  it("refuses a token request with no size, before anything is counted or signed", async () => {
    for (const clientPayload of [null, "{}", "not json", JSON.stringify({ size: "big" })]) {
      const res = await tokenWith(clientPayload);
      expect(res.status, String(clientPayload)).toBe(400);
      await expect(res.json()).resolves.toEqual({ error: UPLOAD_SIZE_MISSING_MESSAGE });
    }
    expect(consumeDayBytesMock).not.toHaveBeenCalled();
    expect(handleUploadMock).not.toHaveBeenCalled();
  });

  it("refuses a size over 512 MB", async () => {
    const res = await tokenWith(JSON.stringify({ size: 600 * MB }));
    expect(res.status).toBe(400);
    expect(consumeDayBytesMock).not.toHaveBeenCalled();
    expect(handleUploadMock).not.toHaveBeenCalled();
  });

  it("refuses with a plain sentence once the person's day is used up, signing nothing", async () => {
    consumeDayBytesMock.mockResolvedValue({ allowed: false, retryAfterSeconds: 32_400, leftBytes: 0 });

    const res = await tokenWith(SIZE_PAYLOAD);

    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("32400");
    await expect(res.json()).resolves.toEqual({ error: UPLOAD_BYTES_LIMIT_MESSAGE, retryAfterSeconds: 32_400 });
    expect(handleUploadMock).not.toHaveBeenCalled();
  });

  it("counts nothing when the workspace's storage is full", async () => {
    checkStorageLimitMock.mockResolvedValue({ error: FULL, code: "WORKSPACE_STORAGE_FULL" });

    const res = await tokenWith(SIZE_PAYLOAD);

    expect(res.status).toBe(403);
    expect(consumeDayBytesMock).not.toHaveBeenCalled();
  });

  it("gives the bytes back when signing then fails", async () => {
    handleUploadMock.mockRejectedValue(new Error("store said no"));

    const res = await tokenWith(SIZE_PAYLOAD);

    expect(res.status).toBe(400);
    expect(releaseDayBytesMock).toHaveBeenCalledWith("user-1", 2 * MB);
  });

  it("counts nothing for the storage's upload-completed callback", async () => {
    handleUploadMock.mockResolvedValue({ type: "blob.upload-completed", response: "ok" });
    const res = await POST(
      new Request("http://localhost/api/upload?workspaceId=ws-1", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "blob.upload-completed", payload: { blob: {}, tokenPayload: "{}" } }),
      }),
    );

    expect(res.status).toBe(200);
    expect(consumeDayBytesMock).not.toHaveBeenCalled();
  });
});

// upload() drops a refused token's body, so the page asks GET /api/upload why
// (lib/uploadFailure.ts). The route remembers the reason for 10 minutes.
describe("a refused upload's sentence reaches the person", () => {
  const BLOB_CLIENT_ERROR = new Error("Vercel Blob: Failed to  retrieve the client token");
  const tokenWith = (payload: unknown) =>
    POST(
      new Request("http://localhost/api/upload?workspaceId=ws-1", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "blob.generate-client-token", payload }),
      }),
    );
  /** What the page shows: explainUploadFailure asking this route's GET. */
  const shown = async () =>
    (await explainUploadFailure(BLOB_CLIENT_ERROR, "ws-1", (async () => GET(req())) as unknown as typeof fetch)).message;

  it("a tab opened before sizes were sent (no clientPayload) is told to reload", async () => {
    expect((await tokenWith({ pathname: SIGNED_IN_KEY, clientPayload: null, multipart: false })).status).toBe(400);
    await expect(shown()).resolves.toBe(UPLOAD_PAGE_OUT_OF_DATE_MESSAGE);
    expect(UPLOAD_SIZE_MISSING_MESSAGE).toBe(UPLOAD_PAGE_OUT_OF_DATE_MESSAGE);
  });

  it("a file name the app does not make is told to reload", async () => {
    for (const pathname of ["a.jpg", "covers/ws-2/a.jpg", "logos/x.png"]) {
      refusalRows.clear();
      expect((await tokenWith({ pathname, clientPayload: SIZE_PAYLOAD, multipart: false })).status, pathname).toBe(400);
      await expect(shown(), pathname).resolves.toBe(UPLOAD_PAGE_OUT_OF_DATE_MESSAGE);
    }
    expect(UPLOAD_PATH_REFUSED_MESSAGE).toBe(UPLOAD_PAGE_OUT_OF_DATE_MESSAGE);
  });

  it("the day's 20 GB is told when uploads start again", async () => {
    consumeDayBytesMock.mockResolvedValue({ allowed: false, retryAfterSeconds: 32_400, leftBytes: 0 });
    expect((await tokenWith({ pathname: SIGNED_IN_KEY, clientPayload: SIZE_PAYLOAD, multipart: false })).status).toBe(429);
    await expect(shown()).resolves.toBe(UPLOAD_DAY_LIMIT_MESSAGE);
    expect(UPLOAD_BYTES_LIMIT_MESSAGE).toBe(UPLOAD_DAY_LIMIT_MESSAGE);
  });

  // R62 pages-a-2 L1: only this file doesn't fit; the page names what still can.
  it("19.7 GB used plus a 400 MB file: the answer names what is left, the page says a smaller file may still go", async () => {
    const left = (20 * 1024 * 1024 - Math.round(19.7 * 1024 * 1024)) * 1024;
    consumeDayBytesMock.mockResolvedValue({ allowed: false, retryAfterSeconds: 32_400, leftBytes: left });
    const past =
      "This file would take you past today's 20 GB upload limit. A file under 307 MB can still go today; the limit resets at midnight UTC.";
    const res = await tokenWith({ pathname: SIGNED_IN_KEY, clientPayload: JSON.stringify({ size: 400 * MB }), multipart: false });
    expect(res.status).toBe(429);
    await expect(res.json()).resolves.toEqual({ error: past, retryAfterSeconds: 32_400 });
    // The page's later question gets the remembered wording, with no number.
    await expect(shown()).resolves.toBe(
      "This file would take you past today's 20 GB upload limit. A smaller file may still go today; the limit resets at midnight UTC.",
    );
  });

  it("exactly at 20 GB: the \"used\" sentence, in the answer and on the page", async () => {
    consumeDayBytesMock.mockResolvedValue({ allowed: false, retryAfterSeconds: 32_400, leftBytes: 0 });
    const res = await tokenWith({ pathname: SIGNED_IN_KEY, clientPayload: SIZE_PAYLOAD, multipart: false });
    await expect(res.json()).resolves.toEqual({ error: UPLOAD_DAY_LIMIT_MESSAGE, retryAfterSeconds: 32_400 });
    await expect(shown()).resolves.toBe(UPLOAD_DAY_LIMIT_MESSAGE);
  });

  it("an empty file and one over 512 MB get their own sentences", async () => {
    await tokenWith({ pathname: SIGNED_IN_KEY, clientPayload: JSON.stringify({ size: 0 }), multipart: false });
    await expect(shown()).resolves.toBe("This file is empty.");
    await tokenWith({ pathname: SIGNED_IN_KEY, clientPayload: JSON.stringify({ size: 600 * MB }), multipart: false });
    await expect(shown()).resolves.toBe("File is too large (max 512 MB).");
  });

  // R20 new-customer L2: a tab whose session ended, on Create, Add many or Media.
  it("signed out: the route's signed-out sentence, not the refusal one", async () => {
    getWorkspaceContextMock.mockResolvedValue(null);
    expect((await tokenWith({ pathname: SIGNED_IN_KEY, clientPayload: SIZE_PAYLOAD, multipart: false })).status).toBe(401);
    await expect(shown()).resolves.toBe("You were signed out. Sign in again.");
  });

  it("a full workspace keeps its storage sentence", async () => {
    checkStorageLimitMock.mockResolvedValue({ error: FULL, code: "WORKSPACE_STORAGE_FULL" });
    expect((await tokenWith({ pathname: SIGNED_IN_KEY, clientPayload: SIZE_PAYLOAD, multipart: false })).status).toBe(403);
    await expect(shown()).resolves.toBe(FULL);
  });

  it("a byte counter that cannot be reached says to try again shortly, not that the day is used up", async () => {
    consumeDayBytesMock.mockResolvedValue({ allowed: false, retryAfterSeconds: 60, unavailable: true });
    const res = await tokenWith({ pathname: SIGNED_IN_KEY, clientPayload: SIZE_PAYLOAD, multipart: false });
    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toEqual({ error: "Uploads aren't available right now. Try again in a minute." });
    await expect(shown()).resolves.not.toBe(UPLOAD_DAY_LIMIT_MESSAGE);
  });

  // R38 lead review: the upload limit's store couldn't answer. Create shows the
  // shared couldn't-check sentence, not the generic "The upload was refused".
  it("an upload limit that couldn't be checked: 503, remembered, and Create shows the couldn't-check sentence", async () => {
    checkRateLimitMock.mockResolvedValueOnce({ allowed: false, retryAfterSeconds: 60, unavailable: true });
    const res = await tokenWith({ pathname: SIGNED_IN_KEY, clientPayload: SIZE_PAYLOAD, multipart: false });
    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toEqual({ error: LIMIT_UNCHECKED_MESSAGE });
    await expect(shown()).resolves.toBe(LIMIT_UNCHECKED_MESSAGE);
  });

  it("a later upload that is signed clears the reason, so a new failure is not blamed on the old one", async () => {
    await tokenWith({ pathname: SIGNED_IN_KEY, clientPayload: null, multipart: false });
    expect((await tokenWith({ pathname: SIGNED_IN_KEY, clientPayload: SIZE_PAYLOAD, multipart: false })).status).toBe(200);
    await expect(GET(req()).then((r) => r.json())).resolves.toEqual({ storageFull: false });
  });

  it("a too-large cover is told the cover rule", async () => {
    await tokenWith({ pathname: "covers/ws-1/1731600000000-ab12cd34-cover.jpg", clientPayload: JSON.stringify({ size: 40 * MB }), multipart: false });
    await expect(shown()).resolves.toBe(COVER_IMAGE_RULE);
  });

  // R3-security L1: each token request forgets the last reason first, so a
  // later refusal that is not remembered is not explained by an older one.
  it("a later refusal that is not remembered does not show an older reason", async () => {
    await tokenWith({ pathname: SIGNED_IN_KEY, clientPayload: null, multipart: false });
    checkStorageLimitMock.mockResolvedValue({ error: FULL, code: "WORKSPACE_STORAGE_FULL" });
    expect((await tokenWith({ pathname: SIGNED_IN_KEY, clientPayload: SIZE_PAYLOAD, multipart: false })).status).toBe(403);
    await expect(shown()).resolves.toBe(FULL);
  });

  it("a token request refused by the token rate limit forgets the older reason too", async () => {
    consumeDayBytesMock.mockResolvedValue({ allowed: false, retryAfterSeconds: 32_400, leftBytes: 0 });
    await tokenWith({ pathname: SIGNED_IN_KEY, clientPayload: SIZE_PAYLOAD, multipart: false });
    checkRateLimitMock.mockResolvedValue({ allowed: false, retryAfterSeconds: 30 });
    expect((await tokenWith({ pathname: SIGNED_IN_KEY, clientPayload: SIZE_PAYLOAD, multipart: false })).status).toBe(429);
    checkRateLimitMock.mockResolvedValue({ allowed: true });
    await expect(shown()).resolves.not.toBe(UPLOAD_DAY_LIMIT_MESSAGE);
  });

  // R44 new-customer L5: the 121st token in a 15-minute window. The page reads
  // the limit's real wait, not "wait a few minutes".
  it("the 121st upload in 15 minutes is told the real wait", async () => {
    checkRateLimitMock.mockResolvedValueOnce({ allowed: false, retryAfterSeconds: 600 });
    const res = await tokenWith({ pathname: SIGNED_IN_KEY, clientPayload: SIZE_PAYLOAD, multipart: false });
    expect(res.status).toBe(429);
    await expect(shown()).resolves.toBe("Too many tries. Wait 10 minutes, then try again.");
    const body = await GET(req()).then((r) => r.json());
    expect(body).toMatchObject({ refused: true, code: "UPLOAD_RATE_LIMITED" });
    expect(body.retryAfterSeconds).toBeGreaterThan(590);
    expect(body.retryAfterSeconds).toBeLessThanOrEqual(600);
  });

  it("the remembered wait ends when the limit's window does", async () => {
    vi.useFakeTimers({ now: Date.UTC(2026, 10, 17, 10, 0, 0), toFake: ["Date"] });
    try {
      checkRateLimitMock.mockResolvedValueOnce({ allowed: false, retryAfterSeconds: 120 });
      await tokenWith({ pathname: SIGNED_IN_KEY, clientPayload: SIZE_PAYLOAD, multipart: false });
      vi.setSystemTime(Date.UTC(2026, 10, 17, 10, 1, 0));
      await expect(shown()).resolves.toBe("Too many tries. Wait a minute, then try again.");
      vi.setSystemTime(Date.UTC(2026, 10, 17, 10, 2, 1));
      await expect(GET(req()).then((r) => r.json())).resolves.toEqual({ storageFull: false });
    } finally {
      vi.useRealTimers();
    }
  });

  // R44 pages-a L4: a paused workspace (or a trial or plan that ended) is
  // refused before anything is remembered; the page reads the block's own sentence.
  it("a paused workspace's upload shows the pause sentence", async () => {
    getWorkspaceContextMock.mockResolvedValue(
      makeWorkspaceContext({ pausedAt: new Date("2026-11-01T00:00:00Z"), pausedReason: "owner" }),
    );
    const res = await tokenWith({ pathname: SIGNED_IN_KEY, clientPayload: SIZE_PAYLOAD, multipart: false });
    expect(res.status).toBe(403);
    const { error, code } = (await res.json()) as { error: string; code: string };
    expect(code).toBe("WORKSPACE_PAUSED");
    await expect(shown()).resolves.toBe(error);
    await expect(GET(req()).then((r) => r.json())).resolves.toEqual({ storageFull: true, refused: true, error, code });
  });

  it("the block wins over an older remembered reason", async () => {
    await tokenWith({ pathname: SIGNED_IN_KEY, clientPayload: null, multipart: false });
    getWorkspaceContextMock.mockResolvedValue(
      makeWorkspaceContext({ pausedAt: new Date("2026-11-01T00:00:00Z"), pausedReason: "owner" }),
    );
    const res = await tokenWith({ pathname: SIGNED_IN_KEY, clientPayload: SIZE_PAYLOAD, multipart: false });
    const { error } = (await res.json()) as { error: string };
    await expect(shown()).resolves.toBe(error);
  });

  it("is answered even when the storage question is rate limited, without summing storage", async () => {
    await tokenWith({ pathname: SIGNED_IN_KEY, clientPayload: null, multipart: false });
    checkRateLimitMock.mockResolvedValue({ allowed: false, retryAfterSeconds: 30 });

    await expect(GET(req()).then((r) => r.json())).resolves.toEqual({
      storageFull: true,
      refused: true,
      error: UPLOAD_PAGE_OUT_OF_DATE_MESSAGE,
      code: "UPLOAD_PAGE_OUT_OF_DATE",
    });
    expect(checkStorageLimitMock).not.toHaveBeenCalled();
  });

  it("one person's refusal is not shown to another", async () => {
    await tokenWith({ pathname: SIGNED_IN_KEY, clientPayload: null, multipart: false });
    getWorkspaceContextMock.mockResolvedValue(makeWorkspaceContext({ userId: "user-2" }));
    await expect(GET(req()).then((r) => r.json())).resolves.toEqual({ storageFull: false });
  });
});

describe("POST /api/upload — token rate limit", () => {
  it("allows 120 tokens per user per 15 minutes, so a ten-photo post fits many times", async () => {
    await POST(tokenRequest());

    expect(checkRateLimitMock).toHaveBeenCalledWith(
      expect.objectContaining({ route: "upload", limit: 120, windowMs: 15 * 60 * 1000, failClosed: true }),
    );
  });

  it("429s past the limit before any token is issued", async () => {
    checkRateLimitMock.mockResolvedValue({ allowed: false, retryAfterSeconds: 30 });

    const res = await POST(tokenRequest());

    expect(res.status).toBe(429);
    expect(handleUploadMock).not.toHaveBeenCalled();
  });
});

// R32 lead follow-up: a page drawn for another workspace (another tab
// switched) gets the switch sentence; a page that sent no id, the reload one.
describe("GET /api/upload - the page's workspace", () => {
  it("409s another workspace's id and reads nothing", async () => {
    const res = await GET(req("ws-2"));
    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toEqual({ error: WORKSPACE_CHANGED_SAVE_MESSAGE, code: WORKSPACE_CHANGED_CODE });
    expect(checkStorageLimitMock).not.toHaveBeenCalled();
    expect(checkRateLimitMock).not.toHaveBeenCalled();
  });

  it("400s a page that sent no id and reads nothing", async () => {
    const res = await GET(req(null));
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe(MISSING_WORKSPACE_ID_CODE);
    expect(checkStorageLimitMock).not.toHaveBeenCalled();
    expect(checkRateLimitMock).not.toHaveBeenCalled();
  });
});

describe("GET /api/upload — why an upload was refused", () => {
  it("401s when signed out", async () => {
    getWorkspaceContextMock.mockResolvedValue(null);
    const res = await GET(req());
    expect(res.status).toBe(401);
  });

  it("says nothing is wrong under the limit", async () => {
    const res = await GET(req());
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ storageFull: false });
  });

  it("is rate limited per user at 60 per 5 minutes", async () => {
    await GET(req());

    expect(checkRateLimitMock).toHaveBeenCalledWith({
      userId: "user-1",
      route: "upload/status",
      limit: 60,
      windowMs: 5 * 60 * 1000,
    });
  });

  it("answers as if storage is not full when the rate limit is hit, without summing storage", async () => {
    checkRateLimitMock.mockResolvedValue({ allowed: false, retryAfterSeconds: 30 });
    checkStorageLimitMock.mockResolvedValue({ error: FULL, code: "WORKSPACE_STORAGE_FULL" });

    const res = await GET(req());

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ storageFull: false });
    expect(checkStorageLimitMock).not.toHaveBeenCalled();
  });

  it("gives the storage sentence when the workspace is full", async () => {
    checkStorageLimitMock.mockResolvedValue({ error: FULL, code: "WORKSPACE_STORAGE_FULL" });

    const res = await GET(req());

    await expect(res.json()).resolves.toEqual({
      storageFull: true,
      error: FULL,
      code: "WORKSPACE_STORAGE_FULL",
    });
  });
});

// R31 (lead follow-up): a token is signed only for the workspace the page was
// drawn for (`?workspaceId=` on handleUploadUrl). upload() drops a refused
// token's body, so the reason is remembered for the page's question (GET).
describe("POST /api/upload: the page's workspace id", () => {
  const tokenAt = (query: string) =>
    POST(
      new Request(`http://localhost/api/upload${query}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "blob.generate-client-token",
          payload: { pathname: SIGNED_IN_KEY, clientPayload: SIZE_PAYLOAD, multipart: false },
        }),
      }),
    );

  it("an absent id: the 400 to reload, no token, and GET says the same sentence", async () => {
    const res = await tokenAt("");
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("MISSING_WORKSPACE_ID");
    expect(handleUploadMock).not.toHaveBeenCalled();
    expect(consumeDayBytesMock).not.toHaveBeenCalled();
    await expect((await GET(req())).json()).resolves.toMatchObject({
      refused: true,
      error: "This page is out of date. Reload it, then try again.",
      code: "MISSING_WORKSPACE_ID",
    });
  });

  it("another workspace's id: the 409, no token, and GET says the shared sentence", async () => {
    const res = await tokenAt("?workspaceId=ws-2");
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("WORKSPACE_CHANGED");
    expect(handleUploadMock).not.toHaveBeenCalled();
    expect(checkStorageLimitMock).not.toHaveBeenCalled();
    await expect((await GET(req())).json()).resolves.toMatchObject({
      refused: true,
      error: "You switched workspace in another tab. Reload this page, then try again.",
      code: "WORKSPACE_CHANGED",
    });
  });
});

// R69 security-billing L1: the signed key ends in the file's name, so the token
// log keeps only <ms>-<random> (or covers/<workspace>/<ms>-<random>).
describe("POST /api/upload: the token log", () => {
  const tokenFor = (payload: unknown) =>
    POST(
      new Request("http://localhost/api/upload?workspaceId=ws-1", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "blob.generate-client-token", payload }),
      }),
    );
  const signWith = (pathname: string, size = 2 * MB) => {
    handleUploadMock.mockImplementation(
      async (opts: { body: { payload: { pathname: string; clientPayload: string | null } }; onBeforeGenerateToken: (p: string, c: string | null) => Promise<unknown> }) => {
        await opts.onBeforeGenerateToken(opts.body.payload.pathname, opts.body.payload.clientPayload);
        return { type: "blob.generate-client-token", clientToken: "tok" };
      },
    );
    return tokenFor({ pathname, clientPayload: JSON.stringify({ size }), multipart: false });
  };

  it("has no file name for a signed-in upload, only <ms>-<random>", async () => {
    const info = vi.spyOn(logger, "info").mockImplementation(() => {});
    const res = await signWith("1731600000000-ab12cd34-Maria_Lopez_passport.jpg");

    expect(res.status).toBe(200);
    const logged = JSON.stringify(info.mock.calls);
    expect(logged).not.toMatch(/passport|Maria|Lopez/);
    expect(logged).toContain('"1731600000000-ab12cd34"');
  });

  it("has no file name for a cover either", async () => {
    const info = vi.spyOn(logger, "info").mockImplementation(() => {});
    const res = await signWith("covers/ws-1/1731600000000-ab12cd34-Smith_family.jpg", 300_000);

    expect(res.status).toBe(200);
    const logged = JSON.stringify(info.mock.calls);
    expect(logged).not.toMatch(/Smith|family/);
    expect(logged).toContain('"covers/ws-1/1731600000000-ab12cd34"');
  });

  it("has no onUploadCompleted log, which would carry the stored file's address", async () => {
    let options: { onUploadCompleted?: unknown } = {};
    handleUploadMock.mockImplementation(async (opts: { onUploadCompleted?: unknown }) => {
      options = opts;
      return { type: "blob.generate-client-token", clientToken: "tok" };
    });
    await tokenFor({ pathname: SIGNED_IN_KEY, clientPayload: SIZE_PAYLOAD, multipart: false });
    expect(options.onUploadCompleted).toBeUndefined();
  });
});
