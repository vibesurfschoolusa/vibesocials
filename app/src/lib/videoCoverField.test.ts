import { describe, expect, it } from "vitest";

import { COVER_IMAGE_MAX_BYTES, COVER_IMAGE_RULE } from "./videoCover";
import { parseCoverField } from "./videoCoverField";

const BLOB = "https://abc.public.blob.vercel-storage.com/1-x-cover.jpg";

describe("parseCoverField (POST /api/posts)", () => {
  it("absent or null means no cover", () => {
    expect(parseCoverField(undefined, "video/mp4")).toEqual({ ok: true, value: null });
    expect(parseCoverField(null, "video/mp4")).toEqual({ ok: true, value: null });
  });

  it("a frame alone", () => {
    expect(parseCoverField({ timeMs: 2500 }, "video/mp4")).toEqual({ ok: true, value: { timeMs: 2500 } });
  });

  it("a frame with its captured image", () => {
    expect(
      parseCoverField({ timeMs: 2500, imageUrl: BLOB, mimeType: "image/jpeg", sizeBytes: 1000 }, "video/mp4"),
    ).toEqual({ ok: true, value: { timeMs: 2500, imageUrl: BLOB } });
  });

  it("an uploaded image", () => {
    expect(parseCoverField({ imageUrl: BLOB, mimeType: "image/jpeg", sizeBytes: 1000 }, "video/mp4")).toEqual({
      ok: true,
      value: { imageUrl: BLOB },
    });
  });

  it("refuses an image that is not a JPEG of 8 MB or less", () => {
    expect(parseCoverField({ imageUrl: BLOB, mimeType: "image/png", sizeBytes: 1000 }, "video/mp4")).toEqual({
      ok: false,
      error: COVER_IMAGE_RULE,
    });
    expect(
      parseCoverField({ imageUrl: BLOB, mimeType: "image/jpeg", sizeBytes: COVER_IMAGE_MAX_BYTES + 1 }, "video/mp4"),
    ).toEqual({ ok: false, error: COVER_IMAGE_RULE });
  });

  it("refuses an image address that is not the app's own storage", () => {
    const parsed = parseCoverField(
      { imageUrl: "https://evil.example.com/a.jpg", mimeType: "image/jpeg", sizeBytes: 10 },
      "video/mp4",
    );
    expect(parsed.ok).toBe(false);
  });

  it("refuses a cover on a photo post", () => {
    expect(parseCoverField({ timeMs: 0 }, "image/jpeg")).toEqual({
      ok: false,
      error: "A cover can only be chosen for a video.",
    });
  });

  it("refuses an empty or malformed cover", () => {
    expect(parseCoverField({}, "video/mp4").ok).toBe(false);
    expect(parseCoverField("x", "video/mp4").ok).toBe(false);
    expect(parseCoverField({ timeMs: -5 }, "video/mp4").ok).toBe(false);
  });

  it("a reused file (type unknown here) may carry a cover", () => {
    expect(parseCoverField({ timeMs: 10 }, null)).toEqual({ ok: true, value: { timeMs: 10 } });
  });
});
