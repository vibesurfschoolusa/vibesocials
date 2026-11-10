import { beforeEach, describe, expect, it, vi } from "vitest";

const { findActiveUploadLinkMock, checkRateLimitMock, handleUploadMock, checkStorageLimitMock } = vi.hoisted(
  () => ({
    findActiveUploadLinkMock: vi.fn(),
    checkRateLimitMock: vi.fn(),
    handleUploadMock: vi.fn(),
    checkStorageLimitMock: vi.fn(),
  }),
);

vi.mock("@/server/uploadLink", () => ({ findActiveUploadLink: findActiveUploadLinkMock }));
vi.mock("@/lib/rateLimit", () => ({ checkRateLimit: checkRateLimitMock }));
vi.mock("@vercel/blob/client", () => ({ handleUpload: handleUploadMock }));
vi.mock("@/server/usage/workspaceUsage", () => ({ checkStorageLimit: checkStorageLimitMock }));

import { MAX_MEDIA_BYTES } from "@/lib/mediaInput";
import {
  UPLOAD_LINK_DAILY_LIMIT_MESSAGE,
  UPLOAD_LINK_INACTIVE_MESSAGE,
  UPLOAD_LINK_STORAGE_FULL_MESSAGE,
} from "@/lib/uploadLink";

import { POST } from "./route";

const TOKEN = "T".repeat(43);
const LINK = { id: "link-1", workspaceId: "ws-1", createdById: "owner-1", workspaceName: "Surf Co" };

function tokenRequest(
  overrides: { pathname?: string; contentType?: unknown; type?: string; ip?: string; body?: unknown } = {},
): Request {
  const body =
    overrides.body ??
    {
      type: overrides.type ?? "blob.generate-client-token",
      payload: {
        pathname: overrides.pathname ?? "IMG_1.jpg",
        clientPayload: JSON.stringify({ contentType: overrides.contentType ?? "image/jpeg" }),
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

  it("allows only the file's own type, from the shared list, and the shared size limit", async () => {
    await call(tokenRequest({ contentType: "video/quicktime", pathname: "clip.MOV" }));

    const { onBeforeGenerateToken } = handleUploadMock.mock.calls[0][0] as { onBeforeGenerateToken: BeforeGenerate };
    const options = await onBeforeGenerateToken("ul/link-1/abc-clip.MOV", null, false);
    expect(options).toMatchObject({
      allowedContentTypes: ["video/quicktime"],
      maximumSizeInBytes: MAX_MEDIA_BYTES,
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
  it("allows 60 tokens an hour per IP, by the first x-forwarded-for entry, failing closed, before the lookup", async () => {
    await call(tokenRequest());

    expect(checkRateLimitMock).toHaveBeenNthCalledWith(1, {
      userId: "ip:203.0.113.9",
      route: "upload-link/upload",
      limit: 60,
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
