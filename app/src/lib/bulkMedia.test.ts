import { describe, expect, it } from "vitest";

import type { MediaItemDto } from "@/lib/mediaDto";

import {
  BULK_MEDIA_IDS_PARAM_MAX,
  bulkHandoffHref,
  parseMediaIdsParam,
  pickFromMedia,
  resolveMediaHandoff,
  skippedMediaMessage,
  toggleMediaSelection,
} from "./bulkMedia";

const item = (id: string): MediaItemDto => ({
  id,
  storageLocation: `https://blob.example/${id}.jpg`,
  originalFilename: `${id}.jpg`,
  mimeType: "image/jpeg",
  sizeBytes: 10,
  baseCaption: "",
  perPlatformOverrides: null,
  createdAt: "2026-11-01T00:00:00.000Z",
  lastUsedAt: null,
});
const items = (n: number, from = 0) => Array.from({ length: n }, (_, i) => item(`m${from + i}`));

describe("pickFromMedia: the 20-row limit and no doubles", () => {
  it("adds every picked item when they fit", () => {
    const result = pickFromMedia({ rowCount: 3, addedMediaIds: new Set(), picked: items(4) });
    expect(result.add).toHaveLength(4);
    expect(result.tooMany).toBe(false);
    expect(result.duplicates).toBe(0);
  });

  it("counts uploaded and picked rows together against 20", () => {
    const result = pickFromMedia({ rowCount: 18, addedMediaIds: new Set(), picked: items(5) });
    expect(result.add.map((i) => i.id)).toEqual(["m0", "m1"]);
    expect(result.tooMany).toBe(true);
  });

  it("adds nothing when the batch is full", () => {
    const result = pickFromMedia({ rowCount: 20, addedMediaIds: new Set(), picked: items(1) });
    expect(result.add).toEqual([]);
    expect(result.tooMany).toBe(true);
  });

  it("skips an item that is already a row, and says how many", () => {
    const result = pickFromMedia({ rowCount: 1, addedMediaIds: new Set(["m0"]), picked: items(3) });
    expect(result.add.map((i) => i.id)).toEqual(["m1", "m2"]);
    expect(result.duplicates).toBe(1);
    expect(result.tooMany).toBe(false);
  });

  it("does not add the same item twice within one pick", () => {
    const result = pickFromMedia({ rowCount: 0, addedMediaIds: new Set(), picked: [item("a"), item("a")] });
    expect(result.add).toHaveLength(1);
    expect(result.duplicates).toBe(1);
  });

  it("does not count duplicates against the room", () => {
    const result = pickFromMedia({ rowCount: 19, addedMediaIds: new Set(["m0"]), picked: items(2) });
    expect(result.add.map((i) => i.id)).toEqual(["m1"]);
    expect(result.tooMany).toBe(false);
  });
});

describe("toggleMediaSelection", () => {
  it("adds and removes an id without changing the old set", () => {
    const start = new Set(["a"]);
    const added = toggleMediaSelection(start, "b");
    expect([...added]).toEqual(["a", "b"]);
    expect([...toggleMediaSelection(added, "a")]).toEqual(["b"]);
    expect([...start]).toEqual(["a"]);
  });
});

describe("the ?media= handoff", () => {
  it("reads a comma list, once each, ignoring blanks", () => {
    expect(parseMediaIdsParam("a,b,,a, c ")).toEqual(["a", "b", "c"]);
  });

  it("reads a repeated parameter and nothing", () => {
    expect(parseMediaIdsParam(["a,b", "c"])).toEqual(["a", "b", "c"]);
    expect(parseMediaIdsParam(undefined)).toEqual([]);
    expect(parseMediaIdsParam("")).toEqual([]);
  });

  it("keeps only a sensible number of ids", () => {
    const many = Array.from({ length: 500 }, (_, i) => `id${i}`).join(",");
    expect(parseMediaIdsParam(many)).toHaveLength(BULK_MEDIA_IDS_PARAM_MAX);
  });

  it("builds the link from the picked ids, at most 20", () => {
    expect(bulkHandoffHref(["a", "b"])).toBe("/posts/bulk?media=a%2Cb");
    const href = bulkHandoffHref(Array.from({ length: 30 }, (_, i) => `i${i}`));
    expect(decodeURIComponent(href.split("=")[1]).split(",")).toHaveLength(20);
  });

  it("keeps own items in the order asked and counts foreign and unknown ids as skipped", () => {
    // "foreign" and "unknown" are simply not among what the workspace-scoped query found.
    const found = [item("c"), item("a")];
    const result = resolveMediaHandoff(["a", "foreign", "c", "unknown"], found);
    expect(result.items.map((i) => i.id)).toEqual(["a", "c"]);
    expect(result.skipped).toBe(2);
  });

  it("skips what does not fit in 20 rows", () => {
    const ids = items(23).map((i) => i.id);
    const result = resolveMediaHandoff(ids, items(23));
    expect(result.items).toHaveLength(20);
    expect(result.skipped).toBe(3);
  });

  it("has nothing to say when nothing was skipped", () => {
    expect(skippedMediaMessage(0)).toBeNull();
    expect(skippedMediaMessage(1)).toContain("1 selected item was skipped");
    expect(skippedMediaMessage(3)).toContain("3 selected items were skipped");
  });
});
