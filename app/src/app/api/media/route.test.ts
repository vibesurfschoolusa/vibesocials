import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { makeWorkspaceContext } from "../__test-helpers__/workspaceContextMock";

// vi.mock + vi.hoisted are hoisted above imports by vitest (mirrors
// settings/route.test.ts / media/[id]/route.test.ts / posts/route.test.ts).
// route.ts imports `@/lib/db` and `@/lib/workspace` at module scope, so both
// must be mocked before route.ts is imported below.
const { findManyMock, createMock, countMock, getWorkspaceContextMock } = vi.hoisted(() => ({
  findManyMock: vi.fn(),
  createMock: vi.fn(),
  countMock: vi.fn(),
  getWorkspaceContextMock: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    mediaItem: {
      findMany: findManyMock,
      create: createMock,
      // Only here so a regression that adds a COUNT to the list endpoint is
      // caught (the paged GET must detect "more" via take: limit + 1 alone).
      count: countMock,
    },
  },
}));

// Team Workspaces (Task 4): getCurrentUser -> getWorkspaceContext, and
// route.ts now stamps `workspaceId` straight from `context.workspace.id`
// instead of the Task 2 `resolveWorkspaceForUser` bridge.
vi.mock("@/lib/workspace", () => ({
  getWorkspaceContext: getWorkspaceContextMock,
}));

import { BLOB_URL_REJECTED_MESSAGE, MAX_BLOB_URL_LENGTH } from "@/lib/blobUrl";
import { decodePostsCursor, encodePostsCursor } from "@/lib/postsDto";

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

beforeEach(() => {
  findManyMock.mockReset();
  createMock.mockReset();
  countMock.mockReset();
  getWorkspaceContextMock.mockReset();
  getWorkspaceContextMock.mockResolvedValue(makeWorkspaceContext());
  // Hermetic: the blob-store pin reads these; tests that want it set them.
  vi.stubEnv("BLOB_READ_WRITE_TOKEN", "");
  vi.stubEnv("BLOB_STORE_ID", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
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

  it.each([
    ["null", "null"],
    ["an array", "[1,2]"],
    ["a number", "5"],
    ["a string", '"hi"'],
    ["syntactically invalid JSON", "{not json"],
  ])("returns 400 'Invalid JSON body' (not a 500) for a body of %s", async (_label, raw) => {
    const response = await POST(
      new Request("http://localhost/api/media", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: raw,
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Invalid JSON body" });
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

  describe("canonical blob URLs (2026-11-01 audit, M2)", () => {
    const U = "https://test.public.blob.vercel-storage.com/1700000000000-ab12cd34-cat.png";
    const body = (blobUrl: string) => ({ blobUrl, mimeType: "image/png", sizeBytes: 10 });

    beforeEach(() => {
      createMock.mockResolvedValue({ id: "media-3", createdAt: new Date("2026-01-01T00:00:00Z") });
    });

    it.each([
      ["a query string", `${U}?x=1`],
      ["a fragment", `${U}#f`],
      ["embedded credentials", U.replace("https://", "https://user:pw@")],
      ["a non-default explicit port", U.replace(".com/", ".com:8443/")],
    ])("returns 400 with the allowed-host message and stores nothing for %s", async (_label, blobUrl) => {
      const response = await POST(jsonRequest(body(blobUrl)));

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({ error: BLOB_URL_REJECTED_MESSAGE });
      expect(createMock).not.toHaveBeenCalled();
    });

    it("returns 400 with the allowed-host message and stores nothing for a blobUrl longer than MAX_BLOB_URL_LENGTH", async () => {
      const response = await POST(jsonRequest(body(U + "a".repeat(MAX_BLOB_URL_LENGTH - U.length + 1))));

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({ error: BLOB_URL_REJECTED_MESSAGE });
      expect(createMock).not.toHaveBeenCalled();
    });

    it("still accepts a blobUrl of exactly MAX_BLOB_URL_LENGTH characters", async () => {
      const response = await POST(jsonRequest(body(U + "a".repeat(MAX_BLOB_URL_LENGTH - U.length))));

      expect(response.status).toBe(201);
      expect(createMock).toHaveBeenCalledTimes(1);
    });

    it("stores the trimmed canonical URL for a whitespace-padded blobUrl", async () => {
      const response = await POST(jsonRequest(body(` ${U}  `)));

      expect(response.status).toBe(201);
      expect(createMock).toHaveBeenCalledWith({
        data: expect.objectContaining({ storageLocation: U }),
      });
    });

    it("stores the lower-cased spelling for an upper-case host", async () => {
      const response = await POST(jsonRequest(body(U.replace("https://test.", "HTTPS://TEST."))));

      expect(response.status).toBe(201);
      expect(createMock).toHaveBeenCalledWith({
        data: expect.objectContaining({ storageLocation: U }),
      });
    });

    describe("own blob store pin (ruling R6)", () => {
      const FOREIGN = U.replace("https://test.", "https://zzz999.");

      it("rejects another store's Vercel Blob URL when the own store is known", async () => {
        vi.stubEnv("BLOB_READ_WRITE_TOKEN", "vercel_blob_rw_test_secretvalue");

        const response = await POST(jsonRequest(body(FOREIGN)));

        expect(response.status).toBe(400);
        await expect(response.json()).resolves.toEqual({ error: BLOB_URL_REJECTED_MESSAGE });
        expect(createMock).not.toHaveBeenCalled();
      });

      it("accepts an own-store URL in mixed case and stores it lower-cased", async () => {
        vi.stubEnv("BLOB_READ_WRITE_TOKEN", "vercel_blob_rw_test_secretvalue");

        const response = await POST(jsonRequest(body(U.replace("https://test.", "HTTPS://TeSt."))));

        expect(response.status).toBe(201);
        expect(createMock).toHaveBeenCalledWith({
          data: expect.objectContaining({ storageLocation: U }),
        });
      });

      it("accepts a foreign-store URL when no token or store id is configured (today's behaviour)", async () => {
        const response = await POST(jsonRequest(body(FOREIGN)));

        expect(response.status).toBe(201);
        expect(createMock).toHaveBeenCalledWith({
          data: expect.objectContaining({ storageLocation: FOREIGN }),
        });
      });
    });
  });

  // 2026-11-01 scale audit (jobs, event size): the library caption is replayed into the
  // composer and then a publish event, so it is capped like a post's caption.
  describe("caption length cap (2026-11-01 scale audit)", () => {
    const base = {
      blobUrl: "https://test.public.blob.vercel-storage.com/x",
      mimeType: "image/png",
      sizeBytes: 10,
    };

    beforeEach(() => {
      createMock.mockResolvedValue({ id: "media-4", createdAt: new Date("2026-01-01T00:00:00Z") });
    });

    it("returns 400 CAPTION_TOO_LONG for a 10,001-character baseCaption and stores nothing", async () => {
      const response = await POST(jsonRequest({ ...base, baseCaption: "a".repeat(10_001) }));

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        code: "CAPTION_TOO_LONG",
        error: "baseCaption is too long (max 10,000 characters).",
      });
      expect(createMock).not.toHaveBeenCalled();
    });

    it("measures the TRIMMED caption (the value that is stored)", async () => {
      const padded = await POST(jsonRequest({ ...base, baseCaption: `  ${"a".repeat(10_000)}  ` }));

      expect(padded.status).toBe(201);
      expect(createMock).toHaveBeenCalledWith({
        data: expect.objectContaining({ baseCaption: "a".repeat(10_000) }),
      });

      createMock.mockClear();
      const over = await POST(jsonRequest({ ...base, baseCaption: ` ${"a".repeat(10_001)} ` }));
      expect(over.status).toBe(400);
      expect(createMock).not.toHaveBeenCalled();
    });

    it("accepts a baseCaption of exactly 10,000 characters", async () => {
      const response = await POST(jsonRequest({ ...base, baseCaption: "a".repeat(10_000) }));

      expect(response.status).toBe(201);
      expect(createMock).toHaveBeenCalledTimes(1);
    });
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

/** GET request for the paged list; `query` is the raw query string (no `?`). */
function getRequest(query = ""): Request {
  return new Request(`http://localhost/api/media${query ? `?${query}` : ""}`);
}

/**
 * `count` raw rows shaped like the route's `select`, newest first. Each row is
 * one second older than the previous, so row `i` is strictly older than row
 * `i - 1` and the (createdAt desc, id desc) order is unambiguous.
 */
function makeRows(count: number) {
  const base = new Date("2026-06-01T00:00:00.000Z").getTime();
  return Array.from({ length: count }, (_, i) => ({
    id: `media-${String(i).padStart(3, "0")}`,
    storageLocation: `https://blob.example/${i}.png`,
    originalFilename: `${i}.png`,
    mimeType: "image/png",
    sizeBytes: 10 + i,
    baseCaption: "",
    perPlatformOverrides: null,
    createdAt: new Date(base - i * 1000),
    lastUsedAt: null,
  }));
}

interface ListBody {
  items: Array<{ id: string; lastUsedAt: string | null }>;
  nextCursor: string | null;
}

describe("GET /api/media", () => {
  it("401s and never queries when unauthenticated", async () => {
    getWorkspaceContextMock.mockResolvedValue(null);

    const response = await GET(getRequest());

    expect(response.status).toBe(401);
    expect(findManyMock).not.toHaveBeenCalled();
  });

  it("cross-workspace isolation: scopes the library to the active workspace (not the uploader) — any member sees the whole shared library", async () => {
    getWorkspaceContextMock.mockResolvedValue(makeWorkspaceContext({ workspaceId: "ws-shared" }));
    findManyMock.mockResolvedValue([]);

    await GET(getRequest());

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

    const response = await GET(getRequest());
    const body = (await response.json()) as ListBody;

    expect(response.status).toBe(200);
    expect(findManyMock).toHaveBeenCalledWith({
      where: { workspaceId: "ws-1", deletedAt: null },
      // 2026-11-01 scale audit (W11): total order + over-fetch-by-one page.
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 61,
      select: expect.objectContaining({ lastUsedAt: true }),
    });
    expect(body.items[0].lastUsedAt).toBe("2026-01-02T00:00:00.000Z");
    expect(body.items[1].lastUsedAt).toBeNull();
  });

  // 2026-11-01 scale audit (W11): the list used to return the whole library
  // (16.7 MB at 50k items, over Vercel's 4.5 MB response cap). It now pages by
  // keyset on (createdAt desc, id desc), 60 per page.
  describe("pagination (keyset, 60 per page)", () => {
    it("returns a full first page of 60 plus a nextCursor when 61 rows come back", async () => {
      findManyMock.mockResolvedValue(makeRows(61));

      const response = await GET(getRequest());
      const body = (await response.json()) as ListBody;

      expect(response.status).toBe(200);
      expect(body.items).toHaveLength(60);
      // The probe row (index 60) is dropped, never returned.
      expect(body.items.map((i) => i.id)).not.toContain("media-060");
      expect(body.nextCursor).toEqual(expect.any(String));
    });

    it("points nextCursor at the LAST returned row (not the probe row)", async () => {
      const rows = makeRows(61);
      findManyMock.mockResolvedValue(rows);

      const response = await GET(getRequest());
      const body = (await response.json()) as ListBody;

      expect(decodePostsCursor(body.nextCursor as string)).toEqual({
        createdAt: rows[59].createdAt,
        id: rows[59].id,
      });
      expect(body.nextCursor).toBe(encodePostsCursor(rows[59].createdAt, rows[59].id));
    });

    it("returns nextCursor: null on the last (short) page", async () => {
      findManyMock.mockResolvedValue(makeRows(5));

      const response = await GET(getRequest());
      const body = (await response.json()) as ListBody;

      expect(response.status).toBe(200);
      expect(body.items).toHaveLength(5);
      expect(body.nextCursor).toBeNull();
    });

    it("returns nextCursor: null when the library is EXACTLY one page (60 rows, no probe row)", async () => {
      findManyMock.mockResolvedValue(makeRows(60));

      const response = await GET(getRequest());
      const body = (await response.json()) as ListBody;

      expect(body.items).toHaveLength(60);
      expect(body.nextCursor).toBeNull();
    });

    it("returns an empty page with nextCursor: null for an empty library", async () => {
      findManyMock.mockResolvedValue([]);

      const response = await GET(getRequest());
      const body = (await response.json()) as ListBody;

      expect(body).toEqual({ items: [], nextCursor: null });
    });

    it("limit=10 fetches take: 11 and returns 10 items with a cursor on the 10th", async () => {
      const rows = makeRows(11);
      findManyMock.mockResolvedValue(rows);

      const response = await GET(getRequest("limit=10"));
      const body = (await response.json()) as ListBody;

      expect(findManyMock).toHaveBeenCalledWith(expect.objectContaining({ take: 11 }));
      expect(body.items).toHaveLength(10);
      expect(body.nextCursor).toBe(encodePostsCursor(rows[9].createdAt, rows[9].id));
    });

    it("clamps limit=500 to the 60 maximum (take: 61)", async () => {
      findManyMock.mockResolvedValue(makeRows(61));

      const response = await GET(getRequest("limit=500"));
      const body = (await response.json()) as ListBody;

      expect(findManyMock).toHaveBeenCalledWith(expect.objectContaining({ take: 61 }));
      expect(body.items).toHaveLength(60);
    });

    it("defaults to 60 per page when no limit is given", async () => {
      findManyMock.mockResolvedValue([]);

      await GET(getRequest());

      expect(findManyMock).toHaveBeenCalledWith(expect.objectContaining({ take: 61 }));
    });

    it.each([["abc"], ["0"], ["-5"], ["1.5"], [""]])(
      "returns 400 INVALID_LIMIT (and never queries) for limit=%j",
      async (raw) => {
        const response = await GET(getRequest(`limit=${raw}`));

        expect(response.status).toBe(400);
        const body = (await response.json()) as { error?: string; code?: string };
        expect(body.code).toBe("INVALID_LIMIT");
        expect(typeof body.error).toBe("string");
        expect(findManyMock).not.toHaveBeenCalled();
      },
    );

    it.each([
      ["undecodable garbage", "!!!not-a-cursor!!!"],
      ["valid base64url with no separator", Buffer.from("no-separator-here").toString("base64url")],
      ["a bad timestamp", Buffer.from("not-a-date|media-1").toString("base64url")],
      ["an empty id", Buffer.from("2026-06-01T00:00:00.000Z|").toString("base64url")],
    ])("returns 400 INVALID_CURSOR (and never queries) for %s", async (_label, cursor) => {
      const response = await GET(getRequest(`cursor=${encodeURIComponent(cursor)}`));

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        error: "Invalid cursor",
        code: "INVALID_CURSOR",
      });
      expect(findManyMock).not.toHaveBeenCalled();
    });

    it("pages by (createdAt desc, id desc): the keyset where ties on createdAt break by id", async () => {
      const cursorCreatedAt = new Date("2026-06-01T00:00:00.000Z");
      const cursor = encodePostsCursor(cursorCreatedAt, "media-050");
      findManyMock.mockResolvedValue([]);

      await GET(getRequest(`cursor=${encodeURIComponent(cursor)}`));

      expect(findManyMock).toHaveBeenCalledWith({
        where: {
          workspaceId: "ws-1",
          deletedAt: null,
          OR: [
            { createdAt: { lt: cursorCreatedAt } },
            { createdAt: cursorCreatedAt, id: { lt: "media-050" } },
          ],
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: 61,
        select: expect.any(Object),
      });
    });

    it("keeps the workspace + deletedAt scope when a cursor is present (no cross-tenant paging)", async () => {
      getWorkspaceContextMock.mockResolvedValue(makeWorkspaceContext({ workspaceId: "ws-other" }));
      findManyMock.mockResolvedValue([]);
      const cursor = encodePostsCursor(new Date("2026-06-01T00:00:00.000Z"), "media-050");

      await GET(getRequest(`cursor=${encodeURIComponent(cursor)}`));

      expect(findManyMock).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ workspaceId: "ws-other", deletedAt: null }),
        }),
      );
    });

    it("treats an empty cursor param as the first page (no keyset predicate)", async () => {
      findManyMock.mockResolvedValue([]);

      const response = await GET(getRequest("cursor="));

      expect(response.status).toBe(200);
      expect(findManyMock).toHaveBeenCalledWith(
        expect.objectContaining({ where: { workspaceId: "ws-1", deletedAt: null } }),
      );
    });

    it("never issues a COUNT — 'more pages' comes from take: limit + 1 alone", async () => {
      findManyMock.mockResolvedValue(makeRows(61));

      await GET(getRequest());

      expect(countMock).not.toHaveBeenCalled();
      expect(findManyMock).toHaveBeenCalledTimes(1);
    });
  });
});
