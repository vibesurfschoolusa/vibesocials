import { beforeEach, describe, expect, it, vi } from "vitest";

// vi.mock + vi.hoisted are hoisted above imports by vitest (mirrors
// settings/route.test.ts / media/[id]/route.test.ts / posts/route.test.ts).
// route.ts imports `@/lib/db`, `@/lib/auth`, and (Task 2 bridge) `@/lib/workspace`
// at module scope, so all three must be mocked before route.ts is imported below.
const { findManyMock, createMock, getCurrentUserMock, resolveWorkspaceForUserMock } =
  vi.hoisted(() => ({
    findManyMock: vi.fn(),
    createMock: vi.fn(),
    getCurrentUserMock: vi.fn(),
    resolveWorkspaceForUserMock: vi.fn(),
  }));

vi.mock("@/lib/db", () => ({
  prisma: {
    mediaItem: {
      findMany: findManyMock,
      create: createMock,
    },
  },
}));

vi.mock("@/lib/auth", () => ({
  getCurrentUser: getCurrentUserMock,
}));

// Task 2 green-build bridge: route.ts stamps `workspaceId` on create via
// `resolveWorkspaceForUser` (see @/lib/workspace, unit-tested separately in
// workspace.test.ts) — mocked here so this suite stays a pure route unit test.
vi.mock("@/lib/workspace", () => ({
  resolveWorkspaceForUser: resolveWorkspaceForUserMock,
}));

import { GET, POST } from "./route";

const USER = { id: "user-1", email: "user@example.com" };

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
  getCurrentUserMock.mockReset();
  resolveWorkspaceForUserMock.mockReset();
  getCurrentUserMock.mockResolvedValue(USER);
  resolveWorkspaceForUserMock.mockResolvedValue("workspace-1");
});

describe("POST /api/media", () => {
  it("returns 401 and never touches the database when unauthenticated", async () => {
    getCurrentUserMock.mockResolvedValue(null);

    const response = await POST(jsonRequest({ blobUrl: "https://blob.example/x" }));

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
        blobUrl: "https://blob.example/x",
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
        blobUrl: "https://blob.example/x",
        mimeType: "image/png",
        sizeBytes: 600 * 1024 * 1024,
      }),
    );
    const body = (await response.json()) as { error?: string };

    expect(response.status).toBe(400);
    expect(body.error).toBe("File is too large (max 512 MB).");
    expect(createMock).not.toHaveBeenCalled();
  });

  it("creates the MediaItem and returns 201 on the happy path", async () => {
    const created = {
      id: "media-1",
      storageLocation: "https://blob.example/x",
      originalFilename: "cat.png",
      mimeType: "image/png",
      sizeBytes: 1234,
      baseCaption: "hello",
    };
    createMock.mockResolvedValue(created);

    const response = await POST(
      jsonRequest({
        blobUrl: "https://blob.example/x",
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
        // Task 2 bridge — stamped via resolveWorkspaceForUser (mocked above).
        workspaceId: "workspace-1",
        storageLocation: "https://blob.example/x",
        originalFilename: "cat.png",
        mimeType: "image/png",
        sizeBytes: 1234,
        baseCaption: "hello",
      },
    });
    expect(body.mediaItem).toEqual(created);
  });
});

describe("GET /api/media", () => {
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
      where: { userId: "user-1", deletedAt: null },
      orderBy: { createdAt: "desc" },
      select: expect.objectContaining({ lastUsedAt: true }),
    });
    expect(body.items[0].lastUsedAt).toBe("2026-01-02T00:00:00.000Z");
    expect(body.items[1].lastUsedAt).toBeNull();
  });
});
