import { describe, expect, it } from "vitest";

import {
  COVER_IMAGE_MAX_BYTES,
  COVER_IMAGE_RULE,
  clampCoverTimeMs,
  coverFromJob,
  coverJobColumns,
  coverRequestFields,
  formatCoverTime,
  validateCoverFrameTime,
  validateCoverImageFile,
  type CoverChoice,
} from "./videoCover";

const BLOB = "https://abc.public.blob.vercel-storage.com/1-x-cover.jpg";

describe("validateCoverImageFile", () => {
  it("takes a JPEG up to the limit", () => {
    expect(validateCoverImageFile({ type: "image/jpeg", size: COVER_IMAGE_MAX_BYTES })).toBeNull();
  });

  it("refuses a PNG, because Instagram's cover_url takes JPEG only", () => {
    expect(validateCoverImageFile({ type: "image/png", size: 1000 })).toBe(COVER_IMAGE_RULE);
  });

  it("refuses an image over 8 MB", () => {
    expect(validateCoverImageFile({ type: "image/jpeg", size: COVER_IMAGE_MAX_BYTES + 1 })).toBe(COVER_IMAGE_RULE);
  });

  it("refuses an empty file", () => {
    expect(validateCoverImageFile({ type: "image/jpeg", size: 0 })).toBe(COVER_IMAGE_RULE);
  });

  it("says the rule plainly", () => {
    expect(COVER_IMAGE_RULE).toBe("The cover must be a JPEG image of 8 MB or less.");
  });
});

describe("validateCoverFrameTime", () => {
  it("takes a time inside the video", () => {
    expect(validateCoverFrameTime(0, 10_000)).toBeNull();
    expect(validateCoverFrameTime(9_999, 10_000)).toBeNull();
    expect(validateCoverFrameTime(10_000, 10_000)).toBeNull();
  });

  it("refuses a time past the end, a negative or a fractional time", () => {
    expect(validateCoverFrameTime(10_001, 10_000)).toMatch(/inside the video/);
    expect(validateCoverFrameTime(-1, 10_000)).toMatch(/inside the video/);
    expect(validateCoverFrameTime(1.5, 10_000)).toMatch(/inside the video/);
  });

  it("without a known length, takes any whole time up to the cap", () => {
    expect(validateCoverFrameTime(60_000, null)).toBeNull();
    expect(validateCoverFrameTime(Number.NaN, null)).toMatch(/inside the video/);
  });
});

describe("cover columns round-trip", () => {
  it("writes only the columns it has", () => {
    expect(coverJobColumns(undefined)).toEqual({});
    expect(coverJobColumns({ timeMs: 1200 })).toEqual({ coverTimeMs: 1200 });
    expect(coverJobColumns({ imageUrl: BLOB })).toEqual({ coverImageUrl: BLOB });
    expect(coverJobColumns({ timeMs: 0, imageUrl: BLOB })).toEqual({ coverTimeMs: 0, coverImageUrl: BLOB });
  });

  it("reads back what was written; a job without a cover has none", () => {
    expect(coverFromJob({ coverTimeMs: 1200, coverImageUrl: BLOB })).toEqual({ timeMs: 1200, imageUrl: BLOB });
    expect(coverFromJob({ coverTimeMs: 0, coverImageUrl: null })).toEqual({ timeMs: 0 });
    expect(coverFromJob({ coverTimeMs: null, coverImageUrl: BLOB })).toEqual({ imageUrl: BLOB });
    expect(coverFromJob({ coverTimeMs: null, coverImageUrl: null })).toBeUndefined();
    // A row read by code that did not select the columns.
    expect(coverFromJob({})).toBeUndefined();
  });
});

describe("Create form cover state", () => {
  it("clamps the slider time into the video", () => {
    expect(clampCoverTimeMs(-10, 5)).toBe(0);
    expect(clampCoverTimeMs(7000, 5)).toBe(5000);
    expect(clampCoverTimeMs(1234.6, 5)).toBe(1235);
    expect(clampCoverTimeMs(500, null)).toBe(0);
  });

  it("formats the chosen time", () => {
    expect(formatCoverTime(0)).toBe("0:00.0");
    expect(formatCoverTime(65_400)).toBe("1:05.4");
  });

  it("the platform default sends nothing", () => {
    const choice: CoverChoice = { kind: "default" };
    expect(coverRequestFields(choice, null)).toEqual({});
  });

  it("a frame sends its time, and the captured image when there is one", () => {
    const choice: CoverChoice = { kind: "frame", timeMs: 3000 };
    expect(coverRequestFields(choice, null)).toEqual({ cover: { timeMs: 3000 } });
    expect(
      coverRequestFields(choice, { url: BLOB, mimeType: "image/jpeg", sizeBytes: 99 }),
    ).toEqual({ cover: { timeMs: 3000, imageUrl: BLOB, mimeType: "image/jpeg", sizeBytes: 99 } });
  });

  it("an uploaded image sends the image only", () => {
    const choice: CoverChoice = { kind: "upload", file: new File(["x"], "c.jpg", { type: "image/jpeg" }) };
    expect(coverRequestFields(choice, { url: BLOB, mimeType: "image/jpeg", sizeBytes: 1 })).toEqual({
      cover: { imageUrl: BLOB, mimeType: "image/jpeg", sizeBytes: 1 },
    });
  });

  it("an upload choice whose image did not upload sends nothing", () => {
    const choice: CoverChoice = { kind: "upload", file: new File(["x"], "c.jpg", { type: "image/jpeg" }) };
    expect(coverRequestFields(choice, null)).toEqual({});
  });
});
