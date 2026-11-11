import type { Platform } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BLOB_URL_REJECTED_MESSAGE } from "./blobUrl";
import {
  addPhotos,
  MAX_POST_MEDIA,
  movePhoto,
  MULTI_PHOTO_MIME_TYPES,
  multiPhotoPlatformNotes,
  PHOTO_GIF_ALONE_MESSAGE,
  PHOTO_LIMIT_MESSAGE,
  PHOTO_TYPE_MESSAGE,
  PHOTO_VIDEO_ALONE_MESSAGE,
  photoPickProblem,
  removePhoto,
  validatePostMediaList,
  X_MAX_PHOTOS,
} from "./postMedia";

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

describe("validatePostMediaList - alt text (07d)", () => {
  it("keeps each photo's cleaned description with its own photo", () => {
    const result = validatePostMediaList([
      { ...photo(1), altText: "  A dog\non a beach. " },
      photo(2),
      { ...photo(3), altText: "A red boat." },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.map((m) => m.altText)).toEqual(["A dog on a beach.", undefined, "A red boat."]);
  });

  it("leaves altText out of an entry without one, so the entry is exactly what it was", () => {
    const result = validatePostMediaList([photo(1), { ...photo(2), altText: " \n " }]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.every((m) => !("altText" in m))).toBe(true);
  });

  it("ignores a description sent with a video", () => {
    const result = validatePostMediaList([{ ...photo(1, "video/mp4"), altText: "A clip." }]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect("altText" in result.value[0]).toBe(false);
  });

  it("refuses an altText that is not text", () => {
    expect(validatePostMediaList([photo(1), { ...photo(2), altText: 7 }])).toEqual({
      ok: false,
      error: "File 2: altText must be text.",
    });
  });

  it("caps a long description at 1,000 characters", () => {
    const result = validatePostMediaList([{ ...photo(1), altText: "word ".repeat(400) }]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value[0].altText?.length).toBeLessThanOrEqual(1000);
  });
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

describe("photoPickProblem (the Create page's picker)", () => {
  const jpeg = { type: "image/jpeg" };
  const many = (n: number) => Array.from({ length: n }, () => jpeg);

  it("allows a pick that stays within the limit, adding to what is attached", () => {
    expect(photoPickProblem(0, many(2))).toBeNull();
    expect(photoPickProblem(0, many(10))).toBeNull();
    expect(photoPickProblem(4, many(6))).toBeNull();
    expect(photoPickProblem(1, [{ type: "image/png" }, { type: "image/webp" }])).toBeNull();
  });

  it("refuses a pick past the limit", () => {
    expect(photoPickProblem(0, many(11))).toBe("You can attach up to 10 photos.");
    expect(photoPickProblem(9, many(2))).toBe("You can attach up to 10 photos.");
    expect(photoPickProblem(10, many(1))).toBe(PHOTO_LIMIT_MESSAGE);
  });

  it("refuses a video among photos", () => {
    expect(photoPickProblem(2, [{ type: "video/mp4" }])).toBe(
      "A video is posted on its own. Remove the photos first, or post the video separately.",
    );
    expect(photoPickProblem(0, [jpeg, { type: "video/quicktime" }])).toBe(PHOTO_VIDEO_ALONE_MESSAGE);
  });

  it("refuses a GIF among photos", () => {
    expect(photoPickProblem(0, [jpeg, { type: "image/gif" }])).toBe("A GIF is posted on its own.");
    expect(photoPickProblem(3, [{ type: "image/gif" }])).toBe(PHOTO_GIF_ALONE_MESSAGE);
  });

  it("names the video or GIF before the limit", () => {
    expect(photoPickProblem(9, [jpeg, { type: "video/mp4" }])).toBe(PHOTO_VIDEO_ALONE_MESSAGE);
    expect(photoPickProblem(9, [jpeg, { type: "image/gif" }])).toBe(PHOTO_GIF_ALONE_MESSAGE);
  });

  it("refuses any other type a photo set cannot hold (checked after HEIC is converted)", () => {
    expect(photoPickProblem(0, [jpeg, { type: "" }])).toBe(PHOTO_TYPE_MESSAGE);
    expect(photoPickProblem(0, [jpeg, { type: "image/heic" }])).toBe(PHOTO_TYPE_MESSAGE);
  });
});

describe("photo list moves", () => {
  const list = [{ key: "a" }, { key: "b" }, { key: "c" }];
  const keys = (l: { key: string }[]) => l.map((p) => p.key).join("");

  it("adds after the ones already attached", () => {
    expect(keys(addPhotos(list, [{ key: "d" }, { key: "e" }]))).toBe("abcde");
    expect(keys(addPhotos([], [{ key: "a" }]))).toBe("a");
  });

  it("removes one by key and leaves the list alone for an unknown key", () => {
    expect(keys(removePhoto(list, "b"))).toBe("ac");
    expect(keys(removePhoto(list, "a"))).toBe("bc");
    expect(removePhoto(list, "zz")).toBe(list);
  });

  it("moves the first, the last and a middle photo", () => {
    expect(keys(movePhoto(list, "a", 1))).toBe("bac");
    expect(movePhoto(list, "a", -1)).toBe(list);
    expect(keys(movePhoto(list, "c", -1))).toBe("acb");
    expect(movePhoto(list, "c", 1)).toBe(list);
    expect(keys(movePhoto(list, "b", -1))).toBe("bac");
    expect(keys(movePhoto(list, "b", 1))).toBe("acb");
    expect(movePhoto(list, "zz", 1)).toBe(list);
  });

  it("never changes the list it was given", () => {
    const before = keys(list);
    movePhoto(list, "a", 1);
    removePhoto(list, "a");
    addPhotos(list, [{ key: "d" }]);
    expect(keys(list)).toBe(before);
  });
});

describe("multiPhotoPlatformNotes", () => {
  const all: Platform[] = [
    "instagram",
    "facebook_page",
    "linkedin",
    "x",
    "google_business_profile",
    "pinterest",
  ];
  const texts = (platforms: Platform[], count: number) =>
    multiPhotoPlatformNotes(platforms, count).map((n) => n.text);

  it("says nothing for one photo", () => {
    expect(multiPhotoPlatformNotes(all, 1)).toEqual([]);
    expect(multiPhotoPlatformNotes(all, 0)).toEqual([]);
  });

  it("at 2 and 4 photos: Google and Pinterest show the first, X shows them all", () => {
    for (const count of [2, 4]) {
      expect(texts(all, count)).toEqual([
        "Google shows the first photo.",
        "Pinterest shows the first photo.",
      ]);
    }
  });

  it("at 5 and 10 photos X shows the first 4", () => {
    for (const count of [5, 10]) {
      expect(multiPhotoPlatformNotes(all, count)).toEqual([
        { platform: "x", text: "X shows the first 4 photos." },
        { platform: "google_business_profile", text: "Google shows the first photo." },
        { platform: "pinterest", text: "Pinterest shows the first photo." },
      ]);
    }
    expect(X_MAX_PHOTOS).toBe(4);
  });

  it("only for selected platforms", () => {
    expect(texts(["instagram", "facebook_page", "linkedin"], 10)).toEqual([]);
    expect(texts(["pinterest"], 3)).toEqual(["Pinterest shows the first photo."]);
  });
});
