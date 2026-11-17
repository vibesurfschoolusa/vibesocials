import type { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { makeWorkspaceContext } from "../../__test-helpers__/workspaceContextMock";

// vi.mock + vi.hoisted are hoisted above imports by vitest (mirrors
// settings/route.test.ts). route.ts imports `@/lib/db`, `@/lib/workspace`,
// and `@vercel/blob` at module scope, so all three must be mocked before
// route.ts is imported below.
const {
  findFirstMock,
  transactionMock,
  postJobCountMock,
  postJobMediaCountMock,
  mediaItemUpdateMock,
  mediaItemCountMock,
  executeRawMock,
  delMock,
  getWorkspaceContextMock,
} = vi.hoisted(() => ({
  postJobMediaCountMock: vi.fn(),
  findFirstMock: vi.fn(),
  transactionMock: vi.fn(),
  postJobCountMock: vi.fn(),
  mediaItemUpdateMock: vi.fn(),
  mediaItemCountMock: vi.fn(),
  executeRawMock: vi.fn(),
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

// The handlers read only the request's url (DELETE's `?workspaceId=`), so a
// stub is enough: no real NextRequest in the node test environment.
const dummyRequest = { url: "http://localhost/api/media/x?workspaceId=ws-1" } as NextRequest;

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

afterEach(() => {
  vi.unstubAllEnvs();
});

beforeEach(() => {
  // Hermetic: the shared-blob guard rewrites Vercel Blob hosts to the own store.
  vi.stubEnv("BLOB_READ_WRITE_TOKEN", "");
  vi.stubEnv("BLOB_STORE_ID", "");
  findFirstMock.mockReset();
  transactionMock.mockReset();
  postJobCountMock.mockReset();
  // 07a: by default no post uses this item as its second or later photo.
  postJobMediaCountMock.mockReset();
  postJobMediaCountMock.mockResolvedValue(0);
  mediaItemUpdateMock.mockReset();
  mediaItemCountMock.mockReset();
  // Default: no OTHER live MediaItem shares this blob URL (the common case).
  mediaItemCountMock.mockResolvedValue(0);
  executeRawMock.mockReset();
  delMock.mockReset();
  getWorkspaceContextMock.mockReset();
  getWorkspaceContextMock.mockResolvedValue(makeWorkspaceContext());

  // Default transaction implementation: invoke the callback with a `tx`
  // whose methods are the same spies the tests assert against, so
  // `mediaItemUpdateMock`/`postJobCountMock` record calls made via `tx.*`.
  transactionMock.mockImplementation(async (callback: (tx: unknown) => unknown) =>
    callback({
      $executeRaw: executeRawMock,
      postJob: { count: postJobCountMock },
      postJobMedia: { count: postJobMediaCountMock },
      mediaItem: { update: mediaItemUpdateMock, count: mediaItemCountMock },
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
  // R32 lead follow-up: Create's reuse-a-file read names the page's workspace.
  it.each([
    ["another workspace's id", "?workspaceId=ws-2", 409],
    ["no id", "", 400],
  ])("%s: refused before any read", async (_name, query, status) => {
    const response = await GET({ url: `http://localhost/api/media/media-1${query}` } as NextRequest, ctx("media-1"));
    expect(response.status).toBe(status);
    expect(findFirstMock).not.toHaveBeenCalled();
  });

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
    await expect(response.json()).resolves.toEqual({ error: "This file no longer exists." });
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
      select: { id: true, userId: true, storageLocation: true, metadata: true, originalFilename: true },
    });
  });

  it("cross-workspace isolation: an item in another workspace 404s, not 403 (no existence oracle)", async () => {
    findFirstMock.mockResolvedValue(null); // ws-1's WHERE wouldn't match a ws-2 item
    const response = await DELETE(dummyRequest, ctx("foreign-item"));
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "This file no longer exists." });
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
    const body = (await response.json()) as { code?: string; error?: string };

    expect(response.status).toBe(409);
    expect(body.code).toBe("MEDIA_IN_USE");
    // R42 pages-a L4: which post, and what to do about it.
    expect(body.error).toBe(
      "A scheduled, draft or publishing post uses this file. Cancel or delete that post in Queue first, or wait until it has gone out.",
    );
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

    expect(delMock).toHaveBeenCalledWith("https://x.example/blob-key", {
      abortSignal: expect.any(AbortSignal),
    });
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
        $executeRaw: executeRawMock,
        postJob: { count: postJobCountMock },
        postJobMedia: { count: postJobMediaCountMock },
        mediaItem: { update: mediaItemUpdateMock, count: mediaItemCountMock },
      }),
    );
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await DELETE(dummyRequest, ctx("media-1"));

    expect(response.status).toBe(500);
    // R42 pages-a L4: the transaction rolled back, so nothing changed; the code lets the page trust that.
    await expect(response.json()).resolves.toEqual({
      error: "Couldn't delete the file. Nothing changed. Try again in a moment.",
      code: "MEDIA_DELETE_FAILED",
    });

    consoleSpy.mockRestore();
  });

  describe("shared blob URL (2026-11-01 audit, Task 8)", () => {
    const SHARED_URL = "https://example.public.blob.vercel-storage.com/shared.jpg";

    it("still soft-deletes this row but KEEPS the blob when another live MediaItem references the same URL", async () => {
      findFirstMock.mockResolvedValue(
        makeItemRow({ id: "media-1", storageLocation: SHARED_URL }),
      );
      postJobCountMock.mockResolvedValue(0);
      mediaItemCountMock.mockResolvedValue(1); // a teammate's row in another workspace

      const response = await DELETE(dummyRequest, ctx("media-1"));

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ ok: true });
      expect(mediaItemUpdateMock).toHaveBeenCalledTimes(1);
      expect(mediaItemUpdateMock.mock.calls[0][0]).toMatchObject({
        where: { id: "media-1" },
        data: { deletedAt: expect.any(Date) },
      });
      expect(delMock).not.toHaveBeenCalled();
    });

    it("deletes the blob when no other live MediaItem references the URL", async () => {
      findFirstMock.mockResolvedValue(
        makeItemRow({ id: "media-1", storageLocation: SHARED_URL }),
      );
      postJobCountMock.mockResolvedValue(0);
      mediaItemCountMock.mockResolvedValue(0);

      const response = await DELETE(dummyRequest, ctx("media-1"));

      expect(response.status).toBe(200);
      expect(delMock).toHaveBeenCalledTimes(1);
      expect(delMock).toHaveBeenCalledWith(SHARED_URL, { abortSignal: expect.any(AbortSignal) });
    });

    it("counts only OTHER, non-purged rows (any workspace) with the same storageLocation", async () => {
      findFirstMock.mockResolvedValue(
        makeItemRow({ id: "media-7", storageLocation: SHARED_URL }),
      );
      postJobCountMock.mockResolvedValue(0);

      await DELETE(dummyRequest, ctx("media-7"));

      expect(mediaItemCountMock).toHaveBeenCalledWith({
        where: { storageLocation: { in: [SHARED_URL] }, id: { not: "media-7" }, deletedAt: null },
      });
    });

    it("serializes concurrent deletes of rows sharing a URL with an advisory lock taken before the count", async () => {
      findFirstMock.mockResolvedValue(
        makeItemRow({ id: "media-1", storageLocation: SHARED_URL }),
      );
      postJobCountMock.mockResolvedValue(0);
      const order: string[] = [];
      executeRawMock.mockImplementation(async (strings: TemplateStringsArray) => {
        order.push(`raw:${strings.join("?").includes("pg_advisory_xact_lock") ? "advisory" : "row-lock"}`);
        return 0;
      });
      mediaItemCountMock.mockImplementation(async () => {
        order.push("count");
        return 0;
      });

      await DELETE(dummyRequest, ctx("media-1"));

      expect(order).toEqual(["raw:row-lock", "raw:advisory", "count"]);
    });

    it("a 409 (still referenced by an active post) never reaches the shared-blob check", async () => {
      findFirstMock.mockResolvedValue(makeItemRow());
      postJobCountMock.mockResolvedValue(1);

      const response = await DELETE(dummyRequest, ctx("media-1"));

      expect(response.status).toBe(409);
      expect(mediaItemCountMock).not.toHaveBeenCalled();
      expect(delMock).not.toHaveBeenCalled();
    });
  });
});

// 07a: a photo can be used by a post as its second or later photo, through
// PostJobMedia, without being that post's PostJob.mediaItemId.
describe("DELETE /api/media/[id] - a photo of a post with several photos (07a)", () => {
  it("refuses with MEDIA_IN_USE when a non-terminal post uses it as a later photo", async () => {
    findFirstMock.mockResolvedValue(makeItemRow({ id: "media-2" }));
    postJobCountMock.mockResolvedValue(0);
    postJobMediaCountMock.mockResolvedValue(1);

    const response = await DELETE(dummyRequest, ctx("media-2"));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ code: "MEDIA_IN_USE" });
    expect(postJobMediaCountMock).toHaveBeenCalledWith({
      where: {
        mediaItemId: "media-2",
        postJob: { status: { notIn: ["completed", "failed", "cancelled"] } },
      },
    });
    expect(mediaItemUpdateMock).not.toHaveBeenCalled();
    expect(delMock).not.toHaveBeenCalled();
  });

  it("deletes it once every post that uses it is terminal", async () => {
    findFirstMock.mockResolvedValue(makeItemRow({ id: "media-2" }));
    postJobCountMock.mockResolvedValue(0);
    postJobMediaCountMock.mockResolvedValue(0);

    const response = await DELETE(dummyRequest, ctx("media-2"));

    expect(response.status).toBe(200);
    expect(mediaItemUpdateMock).toHaveBeenCalledTimes(1);
    expect(delMock).toHaveBeenCalled();
  });
});

// G4 (R2-pages M1): deleting a file a client sent clears their name, note and
// the file's name with it; any other file is only marked deleted.
describe("DELETE /api/media/[id] - a file a client sent", () => {
  it("clears the sender's name, note and file name when it marks the row deleted", async () => {
    findFirstMock.mockResolvedValue(
      makeItemRow({
        originalFilename: "Maria at the pier.jpg",
        metadata: { source: "upload_link", linkId: "link-1", senderName: "Maria", note: "My number is in here" },
      }),
    );
    postJobCountMock.mockResolvedValue(0);

    const response = await DELETE(dummyRequest, ctx("media-1"));

    expect(response.status).toBe(200);
    expect(findFirstMock.mock.calls[0][0].select).toMatchObject({ metadata: true, originalFilename: true });
    const { data } = mediaItemUpdateMock.mock.calls[0][0] as { data: Record<string, unknown> };
    expect(data).toEqual({
      deletedAt: expect.any(Date),
      originalFilename: "deleted-file.jpg",
      metadata: { source: "upload_link", linkId: "link-1" },
    });
  });

  it("leaves any other file's name and metadata alone", async () => {
    findFirstMock.mockResolvedValue(makeItemRow({ metadata: { location: { description: "Pier" } } }));
    postJobCountMock.mockResolvedValue(0);

    await DELETE(dummyRequest, ctx("media-1"));

    const { data } = mediaItemUpdateMock.mock.calls[0][0] as { data: Record<string, unknown> };
    expect(Object.keys(data)).toEqual(["deletedAt"]);
  });
});

// R31 pages L2: a write from a page drawn for another workspace, or from a tab
// opened before the release (no id), acts on nothing.
describe("DELETE /api/media/[id]: the page's workspace id", () => {
  it("an absent id is the 400 to reload the page, and no item is read", async () => {
    const res = await DELETE({ url: "http://localhost/api/media/media-1" } as NextRequest, ctx("media-1"));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "This page is out of date. Reload it, then try again.",
      code: "MISSING_WORKSPACE_ID",
    });
    expect(findFirstMock).not.toHaveBeenCalled();
  });

  it("another workspace's id is the 409 WORKSPACE_CHANGED, and no item is read", async () => {
    const res = await DELETE({ url: "http://localhost/api/media/media-1?workspaceId=ws-2" } as NextRequest, ctx("media-1"));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: "You switched workspace in another tab. Reload this page, then try again.",
      code: "WORKSPACE_CHANGED",
    });
    expect(findFirstMock).not.toHaveBeenCalled();
  });
});
