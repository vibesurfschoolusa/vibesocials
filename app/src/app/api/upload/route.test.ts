import { beforeEach, describe, expect, it, vi } from "vitest";

import { makeWorkspaceContext } from "../__test-helpers__/workspaceContextMock";

const { getWorkspaceContextMock, checkRateLimitMock, handleUploadMock, checkStorageLimitMock } = vi.hoisted(
  () => ({
    getWorkspaceContextMock: vi.fn(),
    checkRateLimitMock: vi.fn(),
    handleUploadMock: vi.fn(),
    checkStorageLimitMock: vi.fn(),
  }),
);

vi.mock("@/lib/workspace", () => ({ getWorkspaceContext: getWorkspaceContextMock }));
vi.mock("@/lib/rateLimit", () => ({ checkRateLimit: checkRateLimitMock }));
vi.mock("@vercel/blob/client", () => ({ handleUpload: handleUploadMock }));
// Usage limits (2026-11-10): the storage sum has its own suite (workspaceUsage.test.ts).
vi.mock("@/server/usage/workspaceUsage", () => ({ checkStorageLimit: checkStorageLimitMock }));

import { COVER_ADDRESS_REFUSED_MESSAGE } from "@/lib/coverBlobPath";
import { LOGO_ADDRESS_RESERVED_MESSAGE } from "@/lib/workspaceLogo";

import { GET, POST } from "./route";

const FULL =
  "This workspace's media storage is full (5.0 GB). Delete media you no longer need on the Media page, then upload again.";

function tokenRequest(): Request {
  return new Request("http://localhost/api/upload", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      type: "blob.generate-client-token",
      payload: { pathname: "a.jpg", clientPayload: null, multipart: false },
    }),
  });
}

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
        new Request("http://localhost/api/upload", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            type: "blob.generate-client-token",
            payload: { pathname, clientPayload: null, multipart: false },
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
      new Request("http://localhost/api/upload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "blob.generate-client-token",
          payload: { pathname, clientPayload: null, multipart: false },
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

describe("GET /api/upload — why an upload was refused", () => {
  it("401s when signed out", async () => {
    getWorkspaceContextMock.mockResolvedValue(null);
    const res = await GET();
    expect(res.status).toBe(401);
  });

  it("says nothing is wrong under the limit", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ storageFull: false });
  });

  it("is rate limited per user at 60 per 5 minutes", async () => {
    await GET();

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

    const res = await GET();

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ storageFull: false });
    expect(checkStorageLimitMock).not.toHaveBeenCalled();
  });

  it("gives the storage sentence when the workspace is full", async () => {
    checkStorageLimitMock.mockResolvedValue({ error: FULL, code: "WORKSPACE_STORAGE_FULL" });

    const res = await GET();

    await expect(res.json()).resolves.toEqual({
      storageFull: true,
      error: FULL,
      code: "WORKSPACE_STORAGE_FULL",
    });
  });
});
