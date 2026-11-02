import { describe, expect, it } from "vitest";

import {
  appendMediaPage,
  daysUntilRemoval,
  prependMediaItem,
  removeMediaItem,
  toMediaItemDto,
  type MediaItemDtoSource,
} from "./mediaDto";

function makeSource(overrides: Partial<MediaItemDtoSource> = {}): MediaItemDtoSource {
  return {
    id: "media-1",
    storageLocation: "https://blob.example/a.png",
    originalFilename: "a.png",
    mimeType: "image/png",
    sizeBytes: 1234,
    baseCaption: "hi",
    perPlatformOverrides: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

describe("toMediaItemDto — lastUsedAt mapping", () => {
  it("maps a Date lastUsedAt to an ISO string", () => {
    const dto = toMediaItemDto(makeSource({ lastUsedAt: new Date("2026-01-05T00:00:00Z") }));
    expect(dto.lastUsedAt).toBe("2026-01-05T00:00:00.000Z");
  });

  it("maps a null lastUsedAt to null", () => {
    const dto = toMediaItemDto(makeSource({ lastUsedAt: null }));
    expect(dto.lastUsedAt).toBeNull();
  });

  it("maps a missing (unselected) lastUsedAt to null, same as explicit null", () => {
    // Mirrors GET /api/media/[id], whose `select` doesn't include lastUsedAt.
    const withoutLastUsedAt: Partial<MediaItemDtoSource> = makeSource({ lastUsedAt: null });
    delete withoutLastUsedAt.lastUsedAt;
    const dto = toMediaItemDto(withoutLastUsedAt as MediaItemDtoSource);
    expect(dto.lastUsedAt).toBeNull();
  });
});

describe("daysUntilRemoval", () => {
  const RETENTION_DAYS = 30;
  const DAY_MS = 24 * 60 * 60 * 1000;

  it("returns null when lastUsedAt is null (never-posted upload)", () => {
    expect(daysUntilRemoval(null, RETENTION_DAYS, new Date())).toBeNull();
  });

  it("returns null when lastUsedAt is an invalid date string", () => {
    expect(daysUntilRemoval("not-a-date", RETENTION_DAYS, new Date())).toBeNull();
  });

  it("returns 20 when used 10 days ago with a 30-day retention window", () => {
    const now = new Date("2026-02-01T00:00:00Z");
    const lastUsedAt = new Date(now.getTime() - 10 * DAY_MS).toISOString();
    expect(daysUntilRemoval(lastUsedAt, RETENTION_DAYS, now)).toBe(20);
  });

  it("floors at 0 when used 40 days ago (past the 30-day window)", () => {
    const now = new Date("2026-02-01T00:00:00Z");
    const lastUsedAt = new Date(now.getTime() - 40 * DAY_MS).toISOString();
    expect(daysUntilRemoval(lastUsedAt, RETENTION_DAYS, now)).toBe(0);
  });

  it("returns the full retention window when used just now", () => {
    const now = new Date("2026-02-01T00:00:00Z");
    expect(daysUntilRemoval(now.toISOString(), RETENTION_DAYS, now)).toBe(30);
  });
});

// 2026-11-01 scale audit (W11): the media library loads 60 items per page and
// merges later pages / uploads / deletes client-side. These pure transforms
// carry the one invariant that matters: the rendered list never holds two items
// with the same id (a duplicate React key, and a visible double card).
describe("client-side library list transforms", () => {
  const item = (id: string, originalFilename = `${id}.png`) => ({ id, originalFilename });
  const ids = (list: Array<{ id: string }>) => list.map((i) => i.id);

  describe("appendMediaPage", () => {
    it("appends an older page beneath the rows already on screen, in order", () => {
      const out = appendMediaPage([item("a"), item("b")], [item("c"), item("d")]);
      expect(ids(out)).toEqual(["a", "b", "c", "d"]);
    });

    it("dedupes by id when a page repeats an item already on screen (an insert between pages)", () => {
      // An upload prepended locally ("new") can also come back on a later
      // page if the server order shifted; it must not render twice.
      const out = appendMediaPage([item("new"), item("a"), item("b")], [item("b"), item("c")]);
      expect(ids(out)).toEqual(["new", "a", "b", "c"]);
    });

    it("keeps the on-screen copy of a duplicated id (first wins)", () => {
      const onScreen = item("b", "on-screen.png");
      const out = appendMediaPage([item("a"), onScreen], [item("b", "from-page.png")]);
      expect(out[1]).toBe(onScreen);
    });

    it("dedupes repeats WITHIN the incoming page too", () => {
      const out = appendMediaPage([item("a")], [item("b"), item("b"), item("c")]);
      expect(ids(out)).toEqual(["a", "b", "c"]);
    });

    it("returns the existing rows when the page is empty, and the page when nothing is loaded", () => {
      expect(ids(appendMediaPage([item("a")], []))).toEqual(["a"]);
      expect(ids(appendMediaPage([], [item("a"), item("b")]))).toEqual(["a", "b"]);
    });

    it("does not mutate its inputs", () => {
      const existing = [item("a")];
      const page = [item("a"), item("b")];
      appendMediaPage(existing, page);
      expect(ids(existing)).toEqual(["a"]);
      expect(ids(page)).toEqual(["a", "b"]);
    });
  });

  describe("prependMediaItem", () => {
    it("puts a freshly uploaded item at the top (newest first)", () => {
      expect(ids(prependMediaItem([item("a"), item("b")], item("new")))).toEqual(["new", "a", "b"]);
    });

    it("never duplicates an item already in the list, moving the fresh copy to the top", () => {
      const fresh = item("b", "fresh.png");
      const out = prependMediaItem([item("a"), item("b", "stale.png"), item("c")], fresh);
      expect(ids(out)).toEqual(["b", "a", "c"]);
      expect(out[0]).toBe(fresh);
    });
  });

  describe("removeMediaItem", () => {
    it("removes a deleted item locally without touching the rest or their order", () => {
      expect(ids(removeMediaItem([item("a"), item("b"), item("c")], "b"))).toEqual(["a", "c"]);
    });

    it("is a no-op for an id that is not loaded (e.g. on a page not fetched yet)", () => {
      expect(ids(removeMediaItem([item("a"), item("b")], "zzz"))).toEqual(["a", "b"]);
    });
  });
});
