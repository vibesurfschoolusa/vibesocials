import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BLOB_URL_REJECTED_MESSAGE } from "./blobUrl";
import { MAX_POST_MEDIA, MULTI_PHOTO_MIME_TYPES, validatePostMediaList } from "./postMedia";

const HOST = "https://test.public.blob.vercel-storage.com";

function photo(n: number, mimeType = "image/jpeg") {
  return { blobUrl: `${HOST}/p${n}.jpg`, filename: `p${n}.jpg`, mimeType, sizeBytes: 100 + n };
}

beforeEach(() => {
  // Hermetic: the blob-store pin reads these.
  vi.stubEnv("BLOB_READ_WRITE_TOKEN", "");
  vi.stubEnv("BLOB_STORE_ID", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("postMedia constants", () => {
  it("allows up to 10 photos of JPEG, PNG or WebP", () => {
    expect(MAX_POST_MEDIA).toBe(10);
    expect([...MULTI_PHOTO_MIME_TYPES]).toEqual(["image/jpeg", "image/png", "image/webp"]);
  });
});

describe("validatePostMediaList", () => {
  it("accepts one entry and returns it as file info", () => {
    expect(validatePostMediaList([photo(1)])).toEqual({
      ok: true,
      value: [
        {
          storageLocation: `${HOST}/p1.jpg`,
          originalFilename: "p1.jpg",
          mimeType: "image/jpeg",
          sizeBytes: 101,
        },
      ],
    });
  });

  it("a single entry keeps the single-file rules: a GIF or a video alone is fine", () => {
    expect(validatePostMediaList([photo(1, "image/gif")]).ok).toBe(true);
    expect(validatePostMediaList([photo(1, "video/mp4")]).ok).toBe(true);
  });

  it("accepts ten entries and keeps their order", () => {
    const entries = Array.from({ length: 10 }, (_, i) => photo(i, i % 2 ? "image/png" : "image/webp"));
    const result = validatePostMediaList(entries);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.map((m) => m.originalFilename)).toEqual(entries.map((e) => e.filename));
  });

  it("refuses eleven", () => {
    const result = validatePostMediaList(Array.from({ length: 11 }, (_, i) => photo(i)));
    expect(result).toEqual({ ok: false, error: "A post can have at most 10 photos." });
  });

  it("refuses an empty list or a non-list", () => {
    expect(validatePostMediaList([]).ok).toBe(false);
    expect(validatePostMediaList("nope").ok).toBe(false);
    expect(validatePostMediaList([null]).ok).toBe(false);
  });

  it("refuses a video among several", () => {
    const result = validatePostMediaList([photo(1), photo(2, "video/mp4")]);
    expect(result).toEqual({
      ok: false,
      error: "A post with several files can only contain photos. Post a video on its own.",
    });
  });

  it("refuses a GIF among several", () => {
    const result = validatePostMediaList([photo(1, "image/gif"), photo(2)]);
    expect(result).toEqual({
      ok: false,
      error: "A post with several photos can't include a GIF. Post a GIF on its own.",
    });
  });

  it("refuses any other image type among several", () => {
    const result = validatePostMediaList([photo(1), photo(2, "image/heic")]);
    expect(result).toEqual({
      ok: false,
      error: "A post with several photos takes JPEG, PNG or WebP images only.",
    });
  });

  it("refuses a bad host, naming the file", () => {
    const result = validatePostMediaList([photo(1), { ...photo(2), blobUrl: "https://evil.example/x.jpg" }]);
    expect(result).toEqual({ ok: false, error: `File 2: ${BLOB_URL_REJECTED_MESSAGE}` });
  });

  it("a single bad entry gets the single-blob message unprefixed", () => {
    expect(validatePostMediaList([{ ...photo(1), blobUrl: "https://evil.example/x.jpg" }])).toEqual({
      ok: false,
      error: BLOB_URL_REJECTED_MESSAGE,
    });
  });

  it("stores the canonical URL and applies the size rule per entry", () => {
    const ok = validatePostMediaList([photo(1), { ...photo(2), blobUrl: `  ${HOST}/p2.jpg  ` }]);
    expect(ok.ok && ok.value[1].storageLocation).toBe(`${HOST}/p2.jpg`);

    const tooBig = validatePostMediaList([photo(1), { ...photo(2), sizeBytes: -1 }]);
    expect(tooBig).toEqual({
      ok: false,
      error: "File 2: sizeBytes must be a non-negative whole number (max 512 MB).",
    });
  });

  it("refuses an entry without a blobUrl", () => {
    const result = validatePostMediaList([photo(1), { ...photo(2), blobUrl: undefined }]);
    expect(result).toEqual({ ok: false, error: "File 2: blobUrl is required." });
  });
});
