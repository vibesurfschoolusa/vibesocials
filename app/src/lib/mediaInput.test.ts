import { describe, expect, it } from "vitest";

import {
  FILENAME_MAX_LENGTH,
  MAX_MEDIA_BYTES,
  isImageOrVideoMimeType,
  parsePostMediaFields,
} from "./mediaInput";

describe("isImageOrVideoMimeType", () => {
  it.each([
    ["image/jpeg", true],
    ["image/png", true],
    ["video/mp4", true],
    ["video/quicktime", true],
    ["image/", true], // prefix rule, same as POST /api/media
    ["application/octet-stream", false],
    ["application/pdf", false],
    ["text/plain", false],
    ["IMAGE/PNG", false], // case-sensitive, same as POST /api/media
    [" image/png", false],
    ["", false],
    [undefined, false],
    [null, false],
    [42, false],
    [["image/png"], false],
  ])("isImageOrVideoMimeType(%j) -> %s", (value, expected) => {
    expect(isImageOrVideoMimeType(value)).toBe(expected);
  });
});

describe("parsePostMediaFields", () => {
  const OK = { filename: "clip.mp4", mimeType: "video/mp4", sizeBytes: 1234 };

  it("accepts a complete, valid set of fields", () => {
    expect(parsePostMediaFields(OK)).toEqual({ ok: true, value: OK });
  });

  describe("sizeBytes", () => {
    it.each([
      ["absent", undefined, 0],
      ["null", null, 0],
      ["zero", 0, 0],
      ["a normal size", 5_000_000, 5_000_000],
      ["exactly the 512 MB cap", MAX_MEDIA_BYTES, MAX_MEDIA_BYTES],
    ])("accepts %s", (_label, sizeBytes, expected) => {
      expect(parsePostMediaFields({ ...OK, sizeBytes })).toEqual({
        ok: true,
        value: { ...OK, sizeBytes: expected },
      });
    });

    it.each([
      ["negative", -1],
      ["fractional", 1.5],
      ["NaN", Number.NaN],
      ["Infinity", Number.POSITIVE_INFINITY],
      ["a numeric string", "1234"],
      ["a boolean", true],
      ["an object", {}],
      ["an array", [1]],
      ["beyond the safe-integer range", 2 ** 53],
      ["above the 512 MB cap (would overflow the Int column)", MAX_MEDIA_BYTES + 1],
    ])("rejects %s", (_label, sizeBytes) => {
      const result = parsePostMediaFields({ ...OK, sizeBytes });
      expect(result.ok).toBe(false);
    });

    it("names the field in the error", () => {
      const result = parsePostMediaFields({ ...OK, sizeBytes: -5 });
      expect(result).toEqual({ ok: false, error: expect.stringContaining("sizeBytes") });
    });
  });

  describe("mimeType", () => {
    it.each([
      ["absent", undefined],
      ["null", null],
      ["empty", ""],
      ["a non-media type", "application/pdf"],
      ["octet-stream (the old silent default)", "application/octet-stream"],
      ["a number", 7],
      ["an object", { type: "image/png" }],
    ])("rejects %s", (_label, mimeType) => {
      const result = parsePostMediaFields({ ...OK, mimeType });
      expect(result).toEqual({ ok: false, error: expect.stringContaining("mimeType") });
    });

    it.each(["image/webp", "image/gif", "video/webm"])("accepts %s", (mimeType) => {
      expect(parsePostMediaFields({ ...OK, mimeType })).toEqual({
        ok: true,
        value: { ...OK, mimeType },
      });
    });
  });

  describe("filename", () => {
    it.each([
      ["absent", undefined],
      ["null", null],
      ["empty", ""],
    ])("falls back to \"upload\" when %s", (_label, filename) => {
      expect(parsePostMediaFields({ ...OK, filename })).toEqual({
        ok: true,
        value: { ...OK, filename: "upload" },
      });
    });

    it("accepts a name of exactly the maximum length", () => {
      const filename = "a".repeat(FILENAME_MAX_LENGTH);
      expect(parsePostMediaFields({ ...OK, filename })).toEqual({
        ok: true,
        value: { ...OK, filename },
      });
    });

    it("rejects a name one character over the maximum", () => {
      const result = parsePostMediaFields({ ...OK, filename: "a".repeat(FILENAME_MAX_LENGTH + 1) });
      expect(result).toEqual({ ok: false, error: expect.stringContaining("filename") });
    });

    it.each([
      ["a number", 12],
      ["an array", ["a.mp4"]],
      ["an object", { name: "a.mp4" }],
      ["a boolean", true],
    ])("rejects %s", (_label, filename) => {
      const result = parsePostMediaFields({ ...OK, filename });
      expect(result).toEqual({ ok: false, error: expect.stringContaining("filename") });
    });
  });

  it("uses a maximum filename length of 255", () => {
    expect(FILENAME_MAX_LENGTH).toBe(255);
  });

  it("uses the same 512 MB cap POST /api/media enforces", () => {
    expect(MAX_MEDIA_BYTES).toBe(512 * 1024 * 1024);
  });
});
