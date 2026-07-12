import type { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { makeWorkspaceContext } from "../../__test-helpers__/workspaceContextMock";

// vi.mock + vi.hoisted are hoisted above imports by vitest (mirrors
// settings/route.test.ts). route.ts imports `@/lib/db`, `@/lib/workspace`,
// and `@vercel/blob` at module scope, so all three must be mocked before
// route.ts is imported below.
const {
  findFirstMock,
  transactionMock,
  postJobCountMock,
  mediaItemUpdateMock,
  delMock,
  getWorkspaceContextMock,
} = vi.hoisted(() => ({
  findFirstMock: vi.fn(),
  transactionMock: vi.fn(),
  postJobCountMock: vi.fn(),
  mediaItemUpdateMock: vi.fn(),
  delMock: vi.fn(),
  getWorkspaceContextMock: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    mediaItem: {
      findFirst: findFirstMock,
    },
    $transaction: transactionMock,
  },
}));

// Team Workspaces (Task 4): getCurrentUser -> getWorkspaceContext.
vi.mock("@/lib/workspace", () => ({
  getWorkspaceContext: getWorkspaceContextMock,
}));

vi.mock("@vercel/blob", () => ({
  del: delMock,
}));

import { DELETE, GET, isMediaDeletable } from "./route";

// The handlers never read `_request`, so an empty stub is enough — avoids
// constructing a real NextRequest in the node test environment.
const dummyRequest = {} as NextRequest;

function ctx(id: string) {
  return { params: Promise.resolve({ id }) };
}

/**
 * A media row as the DELETE handler's permission check needs it: `userId` is
 * the uploader (Team Workspaces, Task 4 — required for the
 * uploader-or-owner delete gate; NOT the same as the caller's own id, which
 * comes from the mocked workspace context instead).
 */
function makeItemRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "media-1",
    userId: "user-1",
    storageLocation: "https://example.public.blob.vercel-storage.com/foo.jpg",
    originalFilename: "foo.jpg",
    mimeType: "image/jpeg",
    sizeBytes: 2048,
    baseCaption: "hello",
    perPlatformOverrides: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

beforeEach(() => {
  findFirstMock.mockReset();
  transactionMock.mockReset();
  postJobCountMock.mockReset();
  mediaItemUpdateMock.mockReset();
  delMock.mockReset();
  getWorkspaceContextMock.mockReset();
  getWorkspaceContextMock.mockResolvedValue(makeWorkspaceContext());

  // Default transaction implementation: invoke the callback with a `tx`
  // whose methods are the same spies the tests assert against, so
  // `mediaItemUpdateMock`/`postJobCountMock` record calls made via `tx.*`.
  transactionMock.mockImplementation(async (callback: (tx: unknown) => unknown) =>
    callback({
      $executeRaw: vi.fn(),
      postJob: { count: postJobCountMock },
      mediaItem: { update: mediaItemUpdateMock },
    }),
  );
});

describe("isMediaDeletable (pure 409 predicate)", () => {
  it("is deletable when there are zero non-terminal referencing jobs", () => {
    expect(isMediaDeletable(0)).toBe(true);
  });

  it("is NOT deletable when at least one non-terminal job references it", () => {
    expect(isMediaDeletable(1)).toBe(false);
    expect(isMediaDeletable(5)).toBe(false);
  });
});

describe("GET /api/media/[id]", () => {
  it("returns 401 and never touches the database when unauthenticated", async () => {
    getWorkspaceContextMock.mockResolvedValue(null);

    const response = await GET(dummyRequest, ctx("media-1"));

    expect(response.status).toBe(401);
    expect(findFirstMock).not.toHaveBeenCalled();
  });

  it("returns 404 when the item doesn't exist, isn't in the caller's workspace, or was soft-deleted", async () => {
    findFirstMock.mockResolvedValue(null);

    const response = await GET(dummyRequest, ctx("missing"));

    expect(response.status).toBe(404);
    expect(findFirstMock).toHaveBeenCalledWith({
      where: { id: "missing", workspaceId: "ws-1", deletedAt: null },
      select: expect.any(Object),
    });
  });

  it("cross-workspace isolation: an item in another workspace 404s, not 403 (no existence oracle)", async () => {
    findFirstMock.mockResolvedValue(null); // ws-1's WHERE wouldn't match a ws-2 item
    const response = await GET(dummyRequest, ctx("foreign-item"));
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "Not found" });
  });

  it("any member can view an item they didn't upload (shared library, not owner-only)", async () => {
    getWorkspaceContextMock.mockResolvedValue(
      makeWorkspaceContext({ userId: "user-2", role: "member" }),
    );
    findFirstMock.mockResolvedValue(makeItemRow({ userId: "user-1" })); // uploaded by someone else

    const response = await GET(dummyRequest, ctx("media-1"));

    expect(response.status).toBe(200);
  });

  it("returns a display-only DTO (no userId) on success", async () => {
    findFirstMock.mockResolvedValue(makeItemRow());

    const response = await GET(dummyRequest, ctx("media-1"));
    const body = (await response.json()) as { item: Record<string, unknown> };

    expect(response.status).toBe(200);
    expect(body.item).toMatchObject({
      id: "media-1",
      storageLocation: "https://example.public.blob.vercel-storage.com/foo.jpg",
      originalFilename: "foo.jpg",
    });
    expect(body.item).not.toHaveProperty("userId");
  });
});

describe("DELETE /api/media/[id]", () => {
  it("returns 401 and never touches the database when unauthenticated", async () => {
    getWorkspaceContextMock.mockResolvedValue(null);

    const response = await DELETE(dummyRequest, ctx("media-1"));

    expect(response.status).toBe(401);
    expect(findFirstMock).not.toHaveBeenCalled();
  });

  it("returns 404 when the item doesn't exist, isn't in the caller's workspace, or was already deleted", async () => {
    findFirstMock.mockResolvedValue(null);

    const response = await DELETE(dummyRequest, ctx("media-1"));

    expect(response.status).toBe(404);
    expect(transactionMock).not.toHaveBeenCalled();
  });

  it("scopes the lookup to workspaceId (not userId) and selects userId for the permission gate", async () => {
    findFirstMock.mockResolvedValue(makeItemRow());
    postJobCountMock.mockResolvedValue(0);

    await DELETE(dummyRequest, ctx("media-1"));

    expect(findFirstMock).toHaveBeenCalledWith({
      where: { id: "media-1", workspaceId: "ws-1", deletedAt: null },
      select: { id: true, userId: true, storageLocation: true },
    });
  });

  it("cross-workspace isolation: an item in another workspace 404s, not 403 (no existence oracle)", async () => {
    findFirstMock.mockResolvedValue(null); // ws-1's WHERE wouldn't match a ws-2 item
    const response = await DELETE(dummyRequest, ctx("foreign-item"));
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "Not found" });
    expect(transactionMock).not.toHaveBeenCalled();
  });

  describe("member-vs-owner delete matrix (Team Workspaces, Task 4)", () => {
    it("a member CAN delete their own upload", async () => {
      getWorkspaceContextMock.mockResolvedValue(
        makeWorkspaceContext({ userId: "user-2", role: "member" }),
      );
      findFirstMock.mockResolvedValue(makeItemRow({ userId: "user-2" }));
      postJobCountMock.mockResolvedValue(0);

      const response = await DELETE(dummyRequest, ctx("media-1"));

      expect(response.status).toBe(200);
      expect(delMock).toHaveBeenCalled();
    });

    it("a member CANNOT delete someone else's upload — 403 with the exact copy, and never touches the transaction", async () => {
      getWorkspaceContextMock.mockResolvedValue(
        makeWorkspaceContext({ userId: "user-2", role: "member" }),
      );
      findFirstMock.mockResolvedValue(makeItemRow({ userId: "user-1" })); // uploaded by someone else

      const response = await DELETE(dummyRequest, ctx("media-1"));
      const body = (await response.json()) as { error?: string };

      expect(response.status).toBe(403);
      expect(body).toEqual({
        error: "Only the uploader or the workspace owner can delete this.",
      });
      expect(transactionMock).not.toHaveBeenCalled();
      expect(delMock).not.toHaveBeenCalled();
    });

    it("the OWNER CAN delete another member's upload", async () => {
      getWorkspaceContextMock.mockResolvedValue(
        makeWorkspaceContext({ userId: "user-1", role: "owner" }),
      );
      findFirstMock.mockResolvedValue(makeItemRow({ userId: "user-2" })); // uploaded by a member
      postJobCountMock.mockResolvedValue(0);

      const response = await DELETE(dummyRequest, ctx("media-1"));

      expect(response.status).toBe(200);
      expect(delMock).toHaveBeenCalled();
    });

    it("the OWNER CAN delete their own upload (trivial case, still gated correctly)", async () => {
      getWorkspaceContextMock.mockResolvedValue(
        makeWorkspaceContext({ userId: "user-1", role: "owner" }),
      );
      findFirstMock.mockResolvedValue(makeItemRow({ userId: "user-1" }));
      postJobCountMock.mockResolvedValue(0);

      const response = await DELETE(dummyRequest, ctx("media-1"));

      expect(response.status).toBe(200);
    });
  });

  it("returns 409 and performs neither the blob delete nor the row update when a non-terminal job references it", async () => {
    findFirstMock.mockResolvedValue(makeItemRow());
    postJobCountMock.mockResolvedValue(1);

    const response = await DELETE(dummyRequest, ctx("media-1"));
    const body = (await response.json()) as { code?: string };

    expect(response.status).toBe(409);
    expect(body.code).toBe("MEDIA_IN_USE");
    expect(mediaItemUpdateMock).not.toHaveBeenCalled();
    expect(delMock).not.toHaveBeenCalled();
  });

  it("queries the non-terminal count scoped to this mediaItemId with the terminal statuses excluded", async () => {
    findFirstMock.mockResolvedValue(makeItemRow({ id: "media-42" }));
    postJobCountMock.mockResolvedValue(0);

    await DELETE(dummyRequest, ctx("media-42"));

    expect(postJobCountMock).toHaveBeenCalledWith({
      where: {
        mediaItemId: "media-42",
        // Roadmap Phase 5 added `cancelled` to the terminal set.
        status: { notIn: ["completed", "failed", "cancelled"] },
      },
    });
  });

  it("on success: marks deletedAt on the row, deletes the blob, and returns 200", async () => {
    findFirstMock.mockResolvedValue(
      makeItemRow({ id: "media-1", storageLocation: "https://x.example/blob-key" }),
    );
    postJobCountMock.mockResolvedValue(0);

    const before = Date.now();
    const response = await DELETE(dummyRequest, ctx("media-1"));
    const after = Date.now();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });

    expect(mediaItemUpdateMock).toHaveBeenCalledTimes(1);
    const updateArgs = mediaItemUpdateMock.mock.calls[0][0] as {
      where: { id: string };
      data: { deletedAt: Date };
    };
    expect(updateArgs.where).toEqual({ id: "media-1" });
    expect(updateArgs.data.deletedAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(updateArgs.data.deletedAt.getTime()).toBeLessThanOrEqual(after);

    expect(delMock).toHaveBeenCalledWith("https://x.example/blob-key");
  });

  it("returns 500 (and never a partial success) when the blob delete throws inside the transaction", async () => {
    findFirstMock.mockResolvedValue(makeItemRow());
    postJobCountMock.mockResolvedValue(0);
    delMock.mockRejectedValue(new Error("network error"));
    // A real Prisma $transaction propagates the callback's rejection; mirror
    // that so the route's try/catch is exercised the same way it would be
    // against a real client.
    transactionMock.mockImplementation(async (callback: (tx: unknown) => unknown) =>
      callback({
        $executeRaw: vi.fn(),
        postJob: { count: postJobCountMock },
        mediaItem: { update: mediaItemUpdateMock },
      }),
    );
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await DELETE(dummyRequest, ctx("media-1"));

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: "Failed to delete media" });

    consoleSpy.mockRestore();
  });
});
