import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ findMany: vi.fn() }));
vi.mock("@/lib/db", () => ({ prisma: { mediaItem: { findMany: h.findMany } } }));

import { loadMediaHandoff } from "./mediaHandoff";

const row = (id: string) => ({
  id,
  storageLocation: `https://blob.example/${id}.jpg`,
  originalFilename: `${id}.jpg`,
  mimeType: "image/jpeg",
  sizeBytes: 10,
  baseCaption: "",
  perPlatformOverrides: null,
  createdAt: new Date("2026-11-01T00:00:00Z"),
  lastUsedAt: null,
  metadata: null,
});

beforeEach(() => h.findMany.mockReset());

describe("loadMediaHandoff", () => {
  it("does not touch the database without ids", async () => {
    expect(await loadMediaHandoff("ws-1", undefined)).toEqual({ items: [], skipped: 0 });
    expect(h.findMany).not.toHaveBeenCalled();
  });

  it("asks only for this workspace's undeleted items", async () => {
    h.findMany.mockResolvedValue([row("a")]);
    await loadMediaHandoff("ws-1", "a,b");
    const where = h.findMany.mock.calls[0][0].where;
    expect(where).toMatchObject({ workspaceId: "ws-1", deletedAt: null, id: { in: ["a", "b"] } });
  });

  it("returns own items and counts the ids it did not find (foreign or unknown)", async () => {
    h.findMany.mockResolvedValue([row("b"), row("a")]);
    const result = await loadMediaHandoff("ws-1", "a,foreign,b,unknown");
    expect(result.items.map((i) => i.id)).toEqual(["a", "b"]);
    expect(result.skipped).toBe(2);
  });

  it("sends the display fields only", async () => {
    h.findMany.mockResolvedValue([row("a")]);
    const result = await loadMediaHandoff("ws-1", "a");
    expect(result.items[0]).not.toHaveProperty("userId");
    expect(typeof result.items[0].createdAt).toBe("string");
  });
});
