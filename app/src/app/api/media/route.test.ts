import { beforeEach, describe, expect, it, vi } from "vitest";

import { makeWorkspaceContext } from "../__test-helpers__/workspaceContextMock";

// vi.mock + vi.hoisted are hoisted above imports by vitest (mirrors
// settings/route.test.ts / media/[id]/route.test.ts / posts/route.test.ts).
// route.ts imports `@/lib/db` and `@/lib/workspace` at module scope, so both
// must be mocked before route.ts is imported below.
const { findManyMock, createMock, getWorkspaceContextMock } = vi.hoisted(() => ({
  findManyMock: vi.fn(),
  createMock: vi.fn(),
  getWorkspaceContextMock: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    mediaItem: {
      findMany: findManyMock,
      create: createMock,
    },
  },
}));

// Team Workspaces (Task 4): getCurrentUser -> getWorkspaceContext, and
// route.ts now stamps `workspaceId` straight from `context.workspace.id`
// instead of the Task 2 `resolveWorkspaceForUser` bridge.
vi.mock("@/lib/workspace", () => ({
  getWorkspaceContext: getWorkspaceContextMock,
}));

import { GET, POST } from "./route";

function jsonRequest(body: unknown): Request {
  return new Request("http://localhost/api/media", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function multipartRequest(): Request {
  return new Request("http://localhost/api/media", {
    method: "POST",
    headers: { "Content-Type": "multipart/form-data; boundary=abc" },
    body: "irrelevant-body",
  });
}

// GET never reads `_request`, so an empty stub is enough (mirrors
// media/[id]/route.test.ts's `dummyRequest`).
const dummyGetRequest = {} as Request;

beforeEach(() => {
  findManyMock.mockReset();
  createMock.mockReset();
  getWorkspaceContextMock.mockReset();
  getWorkspaceContextMock.mockResolvedValue(makeWorkspaceContext());
});

describe("POST /api/media", () => {
  it("returns 401 and never touches the database when unauthenticated", async () => {
    getWorkspaceContextMock.mockResolvedValue(null);

    const response = await POST(jsonRequest({ blobUrl: "https://test.public.blob.vercel-storage.com/x" }));

    expect(response.status).toBe(401);
    expect(createMock).not.toHaveBeenCalled();
  });

  it("returns 400 (mentioning application/json) for a multipart content type", async () => {
    const response = await POST(multipartRequest());
    const body = (await response.json()) as { error?: string };

    expect(response.status).toBe(400);
    expect(body.error).toContain("application/json");
    expect(createMock).not.toHaveBeenCalled();
  });

  it("returns 400 'blobUrl is required' when blobUrl is missing", async () => {
    const response = await POST(
      jsonRequest({ mimeType: "image/png", sizeBytes: 1234 }),
    );
    const body = (await response.json()) as { error?: string };

    expect(response.status).toBe(400);
    expect(body.error).toBe("blobUrl is required");
    expect(createMock).not.toHaveBeenCalled();
  });

  it("returns 400 when mimeType is neither image/* nor video/*", async () => {
    const response = await POST(
      jsonRequest({
        blobUrl: "https://test.public.blob.vercel-storage.com/x",
        mimeType: "application/pdf",
        sizeBytes: 1234,
      }),
    );
    const body = (await response.json()) as { error?: string };

    expect(response.status).toBe(400);
    expect(body.error).toBe("Only image or video files can be added to the library.");
    expect(createMock).not.toHaveBeenCalled();
  });

  it("returns 400 when sizeBytes exceeds the 512MB cap", async () => {
    const response = await POST(
      jsonRequest({
        blobUrl: "https://test.public.blob.vercel-storage.com/x",
        mimeType: "image/png",
        sizeBytes: 600 * 1024 * 1024,
      }),
    );
    const body = (await response.json()) as { error?: string };

    expect(response.status).toBe(400);
    expect(body.error).toBe("File is too large (max 512 MB).");
    expect(createMock).not.toHaveBeenCalled();
  });

  it("creates the MediaItem and returns 201 with the display-safe DTO, dropping internal fields (SEC-1)", async () => {
    // Full raw-row fixture (incl. userId/workspaceId/metadata/deletedAt) so
    // the negative assertions below actually bite — a minimal fixture would
    // pass trivially even with no projection at all.
    const createdAt = new Date("2026-01-01T00:00:00Z");
    const created = {
      id: "media-1",
      userId: "user-1",
      workspaceId: "ws-1",
      storageLocation: "https://test.public.blob.vercel-storage.com/x",
      originalFilename: "cat.png",
      mimeType: "image/png",
      sizeBytes: 1234,
      baseCaption: "hello",
      perPlatformOverrides: null,
      metadata: null,
      createdAt,
      deletedAt: null,
      lastUsedAt: null,
    };
    createMock.mockResolvedValue(created);

    const response = await POST(
      jsonRequest({
        blobUrl: "https://test.public.blob.vercel-storage.com/x",
        filename: "cat.png",
        mimeType: "image/png",
        sizeBytes: 1234,
        baseCaption: "hello",
      }),
    );
    const body = (await response.json()) as { mediaItem?: unknown };

    expect(response.status).toBe(201);
    expect(createMock).toHaveBeenCalledWith({
      data: {
        userId: "user-1",
        // Team Workspaces (Task 4) — stamped straight from context.workspace.id.
        workspaceId: "ws-1",
        storageLocation: "https://test.public.blob.vercel-storage.com/x",
        originalFilename: "cat.png",
        mimeType: "image/png",
        sizeBytes: 1234,
        baseCaption: "hello",
      },
    });
    // SEC-1 (post-release review Task C): the echo is the display DTO, not
    // the raw row — media-library.tsx types this response as
    // { mediaItem: MediaItemDto } and prepends it into the (already-DTO'd)
    // list, so the wire shape must actually match that type.
    expect(body.mediaItem).toEqual({
      id: "media-1",
      storageLocation: "https://test.public.blob.vercel-storage.com/x",
      originalFilename: "cat.png",
      mimeType: "image/png",
      sizeBytes: 1234,
      baseCaption: "hello",
      perPlatformOverrides: null,
      createdAt: createdAt.toISOString(),
      lastUsedAt: null,
    });

    const raw = JSON.stringify(body);
    expect(raw).not.toContain("userId");
    expect(raw).not.toContain("workspaceId");
    expect(raw).not.toContain("deletedAt");
    expect(raw).not.toContain("metadata");
  });

  it("stamps the caller's ACTIVE workspace (not necessarily their personal one)", async () => {
    getWorkspaceContextMock.mockResolvedValue(makeWorkspaceContext({ workspaceId: "ws-team" }));
    // toMediaItemDto (applied to the response) requires a real createdAt —
    // this test only cares about the create() call args, but the fixture
    // still needs to satisfy the DTO projection so POST doesn't throw.
    createMock.mockResolvedValue({ id: "media-2", createdAt: new Date("2026-01-01T00:00:00Z") });

    await POST(
      jsonRequest({
        blobUrl: "https://test.public.blob.vercel-storage.com/x",
        mimeType: "image/png",
        sizeBytes: 10,
      }),
    );

    expect(createMock).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ workspaceId: "ws-team" }) }),
    );
  });
});

describe("GET /api/media", () => {
  it("401s and never queries when unauthenticated", async () => {
    getWorkspaceContextMock.mockResolvedValue(null);

    const response = await GET(dummyGetRequest);

    expect(response.status).toBe(401);
    expect(findManyMock).not.toHaveBeenCalled();
  });

  it("cross-workspace isolation: scopes the library to the active workspace (not the uploader) — any member sees the whole shared library", async () => {
    getWorkspaceContextMock.mockResolvedValue(makeWorkspaceContext({ workspaceId: "ws-shared" }));
    findManyMock.mockResolvedValue([]);

    await GET(dummyGetRequest);

    expect(findManyMock).toHaveBeenCalledWith(
      expect.objectContaining({ where: { workspaceId: "ws-shared", deletedAt: null } }),
    );
  });

  it("selects lastUsedAt and returns items with it mapped to an ISO string or null", async () => {
    findManyMock.mockResolvedValue([
      {
        id: "media-1",
        storageLocation: "https://blob.example/a",
        originalFilename: "a.png",
        mimeType: "image/png",
        sizeBytes: 10,
        baseCaption: "",
        perPlatformOverrides: null,
        createdAt: new Date("2026-01-01T00:00:00Z"),
        lastUsedAt: new Date("2026-01-02T00:00:00Z"),
      },
      {
        id: "media-2",
        storageLocation: "https://blob.example/b",
        originalFilename: "b.png",
        mimeType: "image/png",
        sizeBytes: 20,
        baseCaption: "",
        perPlatformOverrides: null,
        createdAt: new Date("2026-01-01T00:00:00Z"),
        lastUsedAt: null,
      },
    ]);

    const response = await GET(dummyGetRequest);
    const body = (await response.json()) as { items: Array<{ lastUsedAt: string | null }> };

    expect(response.status).toBe(200);
    expect(findManyMock).toHaveBeenCalledWith({
      where: { workspaceId: "ws-1", deletedAt: null },
      orderBy: { createdAt: "desc" },
      select: expect.objectContaining({ lastUsedAt: true }),
    });
    expect(body.items[0].lastUsedAt).toBe("2026-01-02T00:00:00.000Z");
    expect(body.items[1].lastUsedAt).toBeNull();
  });
});
