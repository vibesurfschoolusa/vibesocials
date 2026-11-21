import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  findActiveUploadLinkMock,
  checkRateLimitMock,
  handleUploadMock,
  checkStorageLimitMock,
  consumeBytesMock,
  releaseMock,
} =
  vi.hoisted(() => ({
    findActiveUploadLinkMock: vi.fn(),
    checkRateLimitMock: vi.fn(),
    handleUploadMock: vi.fn(),
    checkStorageLimitMock: vi.fn(),
    consumeBytesMock: vi.fn(),
    releaseMock: vi.fn(),
  }));

vi.mock("@/server/uploadLink", () => ({ findActiveUploadLink: findActiveUploadLinkMock }));
vi.mock("@/lib/rateLimit", () => ({ checkRateLimit: checkRateLimitMock }));
vi.mock("@vercel/blob/client", () => ({ handleUpload: handleUploadMock }));
vi.mock("@/server/usage/workspaceUsage", () => ({ checkStorageLimit: checkStorageLimitMock }));
vi.mock("./linkBytes", () => ({
  consumeUploadLinkDayBytes: consumeBytesMock,
  releaseUploadLinkReservation: releaseMock,
}));

import { LIMIT_UNCHECKED_MESSAGE } from "@/lib/limitUnchecked";
import { MAX_MEDIA_BYTES } from "@/lib/mediaInput";
import { UNKNOWN_TYPE_MESSAGE } from "@/lib/prepareUploadFile";
import {
  UPLOAD_LINK_BYTES_LIMIT_MESSAGE,
  UPLOAD_LINK_DAILY_LIMIT_MESSAGE,
  UPLOAD_LINK_INACTIVE_MESSAGE,
  UPLOAD_LINK_STORAGE_FULL_MESSAGE,
} from "@/lib/uploadLink";

import { uploadLimitText } from "@/app/u/[token]/send-file";

import { POST } from "./route";

const TOKEN = "T".repeat(43);
const LINK = { id: "link-1", workspaceId: "ws-1", createdById: "owner-1", workspaceName: "Surf Co" };

function tokenRequest(
  overrides: {
    pathname?: string;
    contentType?: unknown;
    size?: unknown;
    type?: string;
    ip?: string;
    body?: unknown;
  } = {},
): Request {
  const body =
    overrides.body ??
    {
      type: overrides.type ?? "blob.generate-client-token",
      payload: {
        pathname: overrides.pathname ?? "IMG_1.jpg",
        clientPayload: JSON.stringify({
          contentType: overrides.contentType ?? "image/jpeg",
          size: "size" in overrides ? overrides.size : 4_000_000,
        }),
        multipart: false,
      },
    };
  return new Request(`http://localhost/api/upload-link/${TOKEN}/upload`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-forwarded-for": overrides.ip ?? "203.0.113.9, 10.0.0.1",
    },
    body: JSON.stringify(body),
  });
}

function call(request: Request, token = TOKEN) {
  return POST(request, { params: Promise.resolve({ token }) });
}

type BeforeGenerate = (pathname: string, clientPayload: string | null, multipart: boolean) => Promise<unknown>;

beforeEach(() => {
  findActiveUploadLinkMock.mockReset();
  checkRateLimitMock.mockReset();
  handleUploadMock.mockReset();
  checkStorageLimitMock.mockReset();
  consumeBytesMock.mockReset();
  consumeBytesMock.mockResolvedValue({ allowed: true });
  releaseMock.mockReset();
  releaseMock.mockResolvedValue(undefined);
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});

  findActiveUploadLinkMock.mockResolvedValue(LINK);
  checkRateLimitMock.mockResolvedValue({ allowed: true });
  checkStorageLimitMock.mockResolvedValue(null);
  handleUploadMock.mockImplementation(
    async ({ body, onBeforeGenerateToken }: { body: { payload: { pathname: string } }; onBeforeGenerateToken: BeforeGenerate }) => {
      await onBeforeGenerateToken(body.payload.pathname, null, false);
      return { type: "blob.generate-client-token", clientToken: "client-tok" };
    },
  );
});

describe("an inactive link", () => {
  it("answers unknown and revoked with the same 404, and issues nothing", async () => {
    findActiveUploadLinkMock.mockResolvedValue(null);

    const unknown = await call(tokenRequest(), "unknown");
    const revoked = await call(tokenRequest());

    expect(unknown.status).toBe(404);
    expect(revoked.status).toBe(404);
    const unknownBody = await unknown.json();
    expect(unknownBody).toEqual({ error: UPLOAD_LINK_INACTIVE_MESSAGE });
    expect(await revoked.json()).toEqual(unknownBody);
    expect(handleUploadMock).not.toHaveBeenCalled();
  });
});

describe("issuing a token", () => {
  it("signs a path under ul/<link id>/ whatever path the browser asked for", async () => {
    const response = await call(tokenRequest({ pathname: "../ul/link-2/evil.jpg" }));

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.clientToken).toBe("client-tok");
    expect(body.pathname).toMatch(/^ul\/link-1\/[0-9a-f]{16}-evil\.jpg$/);

    const passed = handleUploadMock.mock.calls[0][0].body.payload.pathname;
    expect(passed).toBe(body.pathname);
  });

  it("allows only the file's own type, from the shared list, and no more than the size it asked for", async () => {
    await call(tokenRequest({ contentType: "video/quicktime", pathname: "clip.MOV", size: 300_000_000 }));

    const { onBeforeGenerateToken } = handleUploadMock.mock.calls[0][0] as { onBeforeGenerateToken: BeforeGenerate };
    const options = await onBeforeGenerateToken("ul/link-1/abc-clip.MOV", null, false);
    expect(options).toMatchObject({
      allowedContentTypes: ["video/quicktime"],
      maximumSizeInBytes: 300_000_000,
      addRandomSuffix: false,
      allowOverwrite: false,
    });
    expect(options).not.toHaveProperty("callbackUrl");
  });

  it("refuses to sign any path outside the prefix", async () => {
    await call(tokenRequest());
    const { onBeforeGenerateToken } = handleUploadMock.mock.calls[0][0] as { onBeforeGenerateToken: BeforeGenerate };
    await expect(onBeforeGenerateToken("ul/link-2/x.jpg", null, false)).rejects.toThrow();
    await expect(onBeforeGenerateToken("x.jpg", null, false)).rejects.toThrow();
  });

  it("refuses a type that is not on the list, before counting or signing", async () => {
    for (const contentType of ["image/heic", "application/pdf", "text/html", 5, undefined]) {
      handleUploadMock.mockClear();
      const response = await call(
        tokenRequest({ body: {
          type: "blob.generate-client-token",
          payload: { pathname: "a.jpg", clientPayload: JSON.stringify({ contentType }), multipart: false },
        } }),
      );
      expect(response.status, String(contentType)).toBe(400);
      expect(handleUploadMock).not.toHaveBeenCalled();
    }
    // Only the IP limit ran: the per-link day count was not spent.
    expect(checkRateLimitMock.mock.calls.every(([opts]) => opts.route === "upload-link/upload")).toBe(true);
  });

  // R45 client-journey L1.
  it("signs a file with no type for the type its name tells", async () => {
    const response = await call(tokenRequest({ contentType: "", pathname: "IMG_0042.MP4" }));
    expect(response.status).toBe(200);
    const { onBeforeGenerateToken } = handleUploadMock.mock.calls[0][0] as { onBeforeGenerateToken: BeforeGenerate };
    const options = await onBeforeGenerateToken("ul/link-1/abc-IMG_0042.MP4", null, false);
    expect(options).toMatchObject({ allowedContentTypes: ["video/mp4"] });
  });

  it("refuses a file whose type can't be told with the plain sentence, before counting", async () => {
    for (const contentType of ["", undefined]) {
      const response = await call(tokenRequest({ body: {
        type: "blob.generate-client-token",
        payload: { pathname: "IMG_0042", clientPayload: JSON.stringify({ contentType }), multipart: false },
      } }));
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({ error: UNKNOWN_TYPE_MESSAGE });
    }
    expect(handleUploadMock).not.toHaveBeenCalled();
    expect(checkRateLimitMock.mock.calls.every(([opts]) => opts.route === "upload-link/upload")).toBe(true);
  });

  it("refuses any other event type, including the upload-completed callback", async () => {
    const response = await call(tokenRequest({ type: "blob.upload-completed" }));
    expect(response.status).toBe(400);
    expect(handleUploadMock).not.toHaveBeenCalled();
  });

  it("refuses a body that is not JSON", async () => {
    const request = new Request(`http://localhost/api/upload-link/${TOKEN}/upload`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{",
    });
    expect((await call(request)).status).toBe(400);
  });

  it("refuses when the workspace's storage is full, with the sentence", async () => {
    checkStorageLimitMock.mockResolvedValue({ error: "full", code: "WORKSPACE_STORAGE_FULL" });

    const response = await call(tokenRequest());

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: UPLOAD_LINK_STORAGE_FULL_MESSAGE,
      code: "WORKSPACE_STORAGE_FULL",
    });
    expect(checkStorageLimitMock).toHaveBeenCalledWith("ws-1");
    expect(handleUploadMock).not.toHaveBeenCalled();
  });

  it("gives a 400 when the storage SDK refuses", async () => {
    handleUploadMock.mockRejectedValue(new Error("bad"));
    expect((await call(tokenRequest())).status).toBe(400);
  });
});

describe("limits", () => {
  it("allows 300 tokens an hour per IP, by the first x-forwarded-for entry, failing closed, before the lookup", async () => {
    await call(tokenRequest());

    expect(checkRateLimitMock).toHaveBeenNthCalledWith(1, {
      userId: "ip:203.0.113.9",
      route: "upload-link/upload",
      limit: 300,
      windowMs: 60 * 60 * 1000,
      failClosed: true,
    });

    checkRateLimitMock.mockReset();
    checkRateLimitMock.mockResolvedValueOnce({ allowed: false, retryAfterSeconds: 300 });
    findActiveUploadLinkMock.mockClear();
    handleUploadMock.mockClear();
    const response = await call(tokenRequest());
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("300");
    expect(findActiveUploadLinkMock).not.toHaveBeenCalled();
    expect(handleUploadMock).not.toHaveBeenCalled();
  });

  it("allows 200 files a day per link, failing closed, with the sentence", async () => {
    await call(tokenRequest());
    expect(checkRateLimitMock).toHaveBeenNthCalledWith(2, {
      userId: "upload-link:link-1",
      route: "upload-link/upload-day",
      limit: 200,
      windowMs: 24 * 60 * 60 * 1000,
      failClosed: true,
    });

    checkRateLimitMock.mockReset();
    checkRateLimitMock
      .mockResolvedValueOnce({ allowed: true })
      .mockResolvedValueOnce({ allowed: false, retryAfterSeconds: 3600 });
    handleUploadMock.mockClear();
    const response = await call(tokenRequest());
    expect(response.status).toBe(429);
    await expect(response.json()).resolves.toMatchObject({ error: UPLOAD_LINK_DAILY_LIMIT_MESSAGE });
    expect(handleUploadMock).not.toHaveBeenCalled();
  });
});

describe("a full shoot through one link", () => {
  /** A limiter that really counts, per key, as the database one does. */
  function countingLimiter() {
    const counts = new Map<string, number>();
    checkRateLimitMock.mockImplementation(
      async ({ userId, route, limit }: { userId: string; route: string; limit: number }) => {
        const key = `${userId}:${route}`;
        const count = (counts.get(key) ?? 0) + 1;
        counts.set(key, count);
        return count > limit ? { allowed: false, retryAfterSeconds: 60 } : { allowed: true };
      },
    );
  }

  it("accepts 80 photos in an hour from one network", async () => {
    countingLimiter();
    for (let i = 0; i < 80; i += 1) {
      const response = await call(tokenRequest({ pathname: `IMG_${i}.jpg` }));
      expect(response.status, `photo ${i + 1}`).toBe(200);
    }
  });

  it("refuses the 201st file of the day with the day's sentence, and other links still work", async () => {
    countingLimiter();
    for (let i = 0; i < 200; i += 1) {
      const response = await call(tokenRequest({ ip: `198.51.100.${i % 4}` }));
      expect(response.status, `file ${i + 1}`).toBe(200);
    }
    const refused = await call(tokenRequest({ ip: "198.51.100.9" }));
    expect(refused.status).toBe(429);
    await expect(refused.json()).resolves.toMatchObject({ error: UPLOAD_LINK_DAILY_LIMIT_MESSAGE });

    findActiveUploadLinkMock.mockResolvedValue({ ...LINK, id: "link-2" });
    expect((await call(tokenRequest({ ip: "198.51.100.9" }))).status).toBe(200);
  });
});

describe("the bytes a link takes in a day", () => {
  it("counts the size the browser asked for against the link", async () => {
    await call(tokenRequest({ size: 7_500_000 }));
    expect(consumeBytesMock).toHaveBeenCalledWith("link-1", 7_500_000);
  });

  it("counts the largest file when the browser names no size", async () => {
    await call(tokenRequest({ size: undefined }));
    expect(consumeBytesMock).toHaveBeenCalledWith("link-1", MAX_MEDIA_BYTES);
    const { onBeforeGenerateToken } = handleUploadMock.mock.calls[0][0] as { onBeforeGenerateToken: BeforeGenerate };
    await expect(onBeforeGenerateToken("ul/link-1/abc-IMG_1.jpg", null, false)).resolves.toMatchObject({
      maximumSizeInBytes: MAX_MEDIA_BYTES,
    });
  });

  it("refuses a size that is not a whole number of bytes from 1 to 512 MB, before counting", async () => {
    for (const size of [0, -5, 1.5, "100", MAX_MEDIA_BYTES + 1]) {
      consumeBytesMock.mockClear();
      handleUploadMock.mockClear();
      const response = await call(tokenRequest({ size }));
      expect(response.status, String(size)).toBe(400);
      expect(consumeBytesMock).not.toHaveBeenCalled();
      expect(handleUploadMock).not.toHaveBeenCalled();
    }
  });

  // R44 pages-a L5: an empty file is told it is empty, as on the signed-in path.
  it("an empty file is told it is empty, not too large", async () => {
    const response = await call(tokenRequest({ size: 0 }));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "This file is empty." });
  });

  it("refuses with a plain sentence once the link's day is full, and signs nothing", async () => {
    consumeBytesMock.mockResolvedValue({ allowed: false, retryAfterSeconds: 5000 });

    const response = await call(tokenRequest());

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("5000");
    await expect(response.json()).resolves.toMatchObject({ error: UPLOAD_LINK_BYTES_LIMIT_MESSAGE });
    expect(handleUploadMock).not.toHaveBeenCalled();
  });
});

// R62 pages-a-2 L1: only this file doesn't fit; /u names what still can.
describe("a file that would take the link past its 20 GB day", () => {
  const LEFT = (20 * 1024 * 1024 - Math.round(19.7 * 1024 * 1024)) * 1024;
  const PAST =
    "This file would take this link past today's 20 GB upload limit. A file under 307 MB can still go today; the limit resets at midnight UTC.";

  it("19.7 GB used plus a 400 MB file: the \"would take this link past\" sentence, which /u shows as it is", async () => {
    consumeBytesMock.mockResolvedValue({ allowed: false, retryAfterSeconds: 5000, leftBytes: LEFT });
    const response = await call(tokenRequest({ size: 400 * 1024 * 1024 }));
    expect(response.status).toBe(429);
    await expect(response.json()).resolves.toMatchObject({ error: PAST });
    expect(uploadLimitText(PAST, 5000)).toBe(PAST);
    expect(handleUploadMock).not.toHaveBeenCalled();
  });

  it("exactly at 20 GB: the \"used\" sentence", async () => {
    consumeBytesMock.mockResolvedValue({ allowed: false, retryAfterSeconds: 5000, leftBytes: 0 });
    const response = await call(tokenRequest());
    await expect(response.json()).resolves.toMatchObject({ error: UPLOAD_LINK_BYTES_LIMIT_MESSAGE });
  });
});

describe("a request refused after it counted", () => {
  it("gives back the file and the bytes when the workspace's storage is full", async () => {
    checkStorageLimitMock.mockResolvedValue({ error: "full", code: "WORKSPACE_STORAGE_FULL" });
    await call(tokenRequest({ size: 9_000 }));
    expect(releaseMock).toHaveBeenCalledWith("link-1", { file: true, bytes: 9_000 });
  });

  it("gives back the file and the bytes when storage refuses to sign", async () => {
    handleUploadMock.mockRejectedValue(new Error("bad"));
    await call(tokenRequest({ size: 9_000 }));
    expect(releaseMock).toHaveBeenCalledWith("link-1", { file: true, bytes: 9_000 });
  });

  it("gives back the file when the bytes are refused (the byte counter gives back its own)", async () => {
    consumeBytesMock.mockResolvedValue({ allowed: false, retryAfterSeconds: 60 });
    await call(tokenRequest({ size: 9_000 }));
    expect(releaseMock).toHaveBeenCalledWith("link-1", { file: true, bytes: 0 });
  });

  // R39 client-journey L1: the byte counter's store failed, so no limit was reached.
  it("a byte counter that couldn't be read answers couldn't-check, gives back the file, and signs nothing", async () => {
    consumeBytesMock.mockResolvedValue({ allowed: false, retryAfterSeconds: 60, unavailable: true });
    const response = await call(tokenRequest({ size: 9_000 }));
    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("60");
    await expect(response.json()).resolves.toEqual({ error: LIMIT_UNCHECKED_MESSAGE });
    expect(releaseMock).toHaveBeenCalledWith("link-1", { file: true, bytes: 0 });
    expect(checkStorageLimitMock).not.toHaveBeenCalled();
    expect(handleUploadMock).not.toHaveBeenCalled();
  });

  it("gives back nothing for a token it signed", async () => {
    await call(tokenRequest());
    expect(releaseMock).not.toHaveBeenCalled();
  });
});
