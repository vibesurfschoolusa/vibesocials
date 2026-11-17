import { describe, expect, it, vi } from "vitest";

import {
  HEIC_CONVERSION_FAILED_MESSAGE,
  HEIC_JPEG_QUALITY,
  MAX_UPLOAD_PHOTO_BYTES,
  SHRINK_ATTEMPTS,
  UNKNOWN_TYPE_MESSAGE,
  fitWithin,
  isHeicFile,
  jpegFileName,
  prepareUploadFile,
  preparedTypeOf,
  unsupportedTypeMessage,
  uploadTypeOf,
  type PrepareUploadDeps,
} from "./prepareUploadFile";

const bytes = (size: number) => new Uint8Array(size);
const file = (name: string, type: string, size = 10) => new File([bytes(size)], name, { type });

function fakeDeps(overrides: Partial<PrepareUploadDeps> = {}): PrepareUploadDeps {
  return {
    convertHeicToJpeg: vi.fn(async () => new Blob([bytes(1_000)], { type: "image/jpeg" })),
    reencodeAsJpeg: vi.fn(async () => new Blob([bytes(2_000_000)], { type: "image/jpeg" })),
    ...overrides,
  };
}

describe("isHeicFile", () => {
  it.each([
    ["IMG_1.heic", "image/heic"],
    ["IMG_1.HEIF", "image/heif"],
    ["burst.heic", "image/heic-sequence"],
    ["IMG_1.HEIC", ""], // Chrome on Windows often reports no type
    ["IMG_1.heic", "application/octet-stream"],
  ])("%s (%s) is HEIC", (name, type) => {
    expect(isHeicFile({ name, type })).toBe(true);
  });

  it.each([
    ["photo.jpg", "image/jpeg"],
    ["clip.mov", "video/quicktime"],
    ["notes.heic.txt", ""],
    ["IMG_1.heic", "image/jpeg"], // the type wins when the browser gives one
  ])("%s (%s) is not HEIC", (name, type) => {
    expect(isHeicFile({ name, type })).toBe(false);
  });
});

describe("jpegFileName / fitWithin", () => {
  it("swaps the extension for .jpg", () => {
    expect(jpegFileName("IMG_5252.HEIC")).toBe("IMG_5252.jpg");
    expect(jpegFileName("beach.day.webp")).toBe("beach.day.jpg");
    expect(jpegFileName("noext")).toBe("noext.jpg");
    expect(jpegFileName(".heic")).toBe("photo.jpg");
  });

  it("scales the longer edge down to the limit and never scales up", () => {
    expect(fitWithin(8064, 6048, 4096)).toEqual({ width: 4096, height: 3072 });
    expect(fitWithin(3024, 4032, 2048)).toEqual({ width: 1536, height: 2048 });
    expect(fitWithin(768, 1024, 4096)).toEqual({ width: 768, height: 1024 });
  });
});

describe("prepareUploadFile", () => {
  it("passes a normal photo, a video, a small PNG and a big GIF through untouched", async () => {
    const deps = fakeDeps();
    for (const original of [
      file("a.jpg", "image/jpeg", 3_000_000),
      file("b.mp4", "video/mp4", 50_000_000),
      file("c.png", "image/png", 2_000_000),
      file("d.gif", "image/gif", 9_000_000), // may be animated
    ]) {
      await expect(prepareUploadFile(original, deps)).resolves.toBe(original);
    }
    expect(deps.convertHeicToJpeg).not.toHaveBeenCalled();
    expect(deps.reencodeAsJpeg).not.toHaveBeenCalled();
  });

  it("converts an iPhone HEIC photo to a JPEG file with a .jpg name", async () => {
    const deps = fakeDeps();
    const result = await prepareUploadFile(file("IMG_5252.HEIC", "", 200_000), deps);

    expect(deps.convertHeicToJpeg).toHaveBeenCalledWith(expect.any(File), HEIC_JPEG_QUALITY);
    expect(result.name).toBe("IMG_5252.jpg");
    expect(result.type).toBe("image/jpeg");
    expect(result.size).toBe(1_000);
  });

  it("gives a clear message when a HEIC photo cannot be converted", async () => {
    const deps = fakeDeps({ convertHeicToJpeg: vi.fn(async () => Promise.reject(new Error("libheif: bad box"))) });
    vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(prepareUploadFile(file("IMG.heic", "image/heic"), deps)).rejects.toThrow(
      HEIC_CONVERSION_FAILED_MESSAGE,
    );
  });

  it("refuses a type the upload route would refuse, before uploading", async () => {
    await expect(prepareUploadFile(file("scan.tiff", "image/tiff"), fakeDeps())).rejects.toThrow(
      /This file type \(image\/tiff\) isn't supported/,
    );
  });

  // R45 client-journey L1: a file with no type is told by its name, never refused as "type ()".
  it("gives a file with no type the type its name tells, so IMG_0042.MP4 goes as a video", async () => {
    const prepared = await prepareUploadFile(file("IMG_0042.MP4", ""), fakeDeps());
    expect(prepared.type).toBe("video/mp4");
    expect(prepared.name).toBe("IMG_0042.MP4");
    expect(prepared.size).toBe(10);
    expect((await prepareUploadFile(file("a.JPEG", "application/octet-stream"), fakeDeps())).type).toBe("image/jpeg");
  });

  it("refuses a file whose type can't be told with a plain sentence, never \"()\"", async () => {
    for (const name of ["IMG_0042", "clip.mkv", "notes."]) {
      await expect(prepareUploadFile(file(name, ""), fakeDeps()), name).rejects.toThrow(UNKNOWN_TYPE_MESSAGE);
    }
    expect(UNKNOWN_TYPE_MESSAGE).toBe(
      "We couldn't tell what kind of file this is. Use a JPEG, PNG, GIF or WebP photo, or an MP4, MOV or WebM video.",
    );
  });

  it("keeps a typed file's own type, whatever its name says", async () => {
    const original = file("clip.jpg", "video/mp4");
    await expect(prepareUploadFile(original, fakeDeps())).resolves.toBe(original);
  });

  it("shrinks a JPEG over the limit, stopping at the first attempt that fits", async () => {
    const reencode = vi
      .fn<PrepareUploadDeps["reencodeAsJpeg"]>()
      .mockResolvedValueOnce(new Blob([bytes(MAX_UPLOAD_PHOTO_BYTES + 1)]))
      .mockResolvedValueOnce(new Blob([bytes(3_900_000)]));
    const deps = fakeDeps({ reencodeAsJpeg: reencode });

    const result = await prepareUploadFile(file("big.jpg", "image/jpeg", 9_000_000), deps);

    expect(reencode.mock.calls.map(([, edge, quality]) => [edge, quality])).toEqual(SHRINK_ATTEMPTS.slice(0, 2));
    expect(result.size).toBe(3_900_000);
    expect(result.type).toBe("image/jpeg");
    expect(result.name).toBe("big.jpg");
  });

  it("re-encodes a PNG over the limit as a smaller JPEG", async () => {
    const result = await prepareUploadFile(file("screen.png", "image/png", 9_000_000), fakeDeps());
    expect(result.type).toBe("image/jpeg");
    expect(result.name).toBe("screen.jpg");
    expect(result.size).toBe(2_000_000);
  });

  it("shrinks a converted HEIC that is still over the limit", async () => {
    const deps = fakeDeps({
      convertHeicToJpeg: vi.fn(async () => new Blob([bytes(MAX_UPLOAD_PHOTO_BYTES + 10)])),
    });

    const result = await prepareUploadFile(file("IMG_48MP.HEIC", "image/heic"), deps);

    expect(deps.reencodeAsJpeg).toHaveBeenCalledTimes(1);
    expect(result.size).toBe(2_000_000);
    expect(result.name).toBe("IMG_48MP.jpg");
  });

  it("keeps the smallest attempt when none fits, and the original when nothing got smaller", async () => {
    const tooBig = vi.fn(async () => new Blob([bytes(MAX_UPLOAD_PHOTO_BYTES + 100)]));
    const shrunk = await prepareUploadFile(file("huge.jpg", "image/jpeg", 20_000_000), fakeDeps({ reencodeAsJpeg: tooBig }));
    expect(tooBig).toHaveBeenCalledTimes(SHRINK_ATTEMPTS.length);
    expect(shrunk.size).toBe(MAX_UPLOAD_PHOTO_BYTES + 100);

    const original = file("odd.jpg", "image/jpeg", MAX_UPLOAD_PHOTO_BYTES + 1);
    const bigger = vi.fn(async () => new Blob([bytes(MAX_UPLOAD_PHOTO_BYTES + 50)]));
    await expect(prepareUploadFile(original, fakeDeps({ reencodeAsJpeg: bigger }))).resolves.toBe(original);
  });
});

// R22 new-customer L1 (review M1): the Create page judges a photo still being
// prepared by the type it will have, so this must agree with prepareUploadFile.
describe("preparedTypeOf", () => {
  const big = MAX_UPLOAD_PHOTO_BYTES + 1;
  it.each([
    ["a Windows HEIC with no type", file("IMG_1.HEIC", ""), "image/jpeg"],
    ["a HEIC", file("IMG_1.heic", "image/heic"), "image/jpeg"],
    ["a big JPEG", file("a.jpg", "image/jpeg", big), "image/jpeg"],
    ["a big PNG", file("a.png", "image/png", big), "image/jpeg"],
    ["a big WebP", file("a.webp", "image/webp", big), "image/jpeg"],
    ["a small WebP", file("a.webp", "image/webp"), "image/webp"],
    ["a small PNG", file("a.png", "image/png"), "image/png"],
    ["a big GIF", file("a.gif", "image/gif", big), "image/gif"],
    ["a video", file("a.mp4", "video/mp4", big), "video/mp4"],
  ])("%s: %s", async (_label, picked, expected) => {
    expect(preparedTypeOf(picked)).toBe(expected);
    expect((await prepareUploadFile(picked, fakeDeps())).type).toBe(expected);
  });
});

describe("uploadTypeOf / unsupportedTypeMessage", () => {
  it.each([
    ["IMG_0042.MP4", "", "video/mp4"],
    ["a.jpg", "", "image/jpeg"],
    ["a.jpeg", "", "image/jpeg"],
    ["a.png", "", "image/png"],
    ["a.gif", "", "image/gif"],
    ["a.webp", "", "image/webp"],
    ["a.mov", "", "video/quicktime"],
    ["a.webm", "", "video/webm"],
    ["IMG_0042", "", ""],
    ["a.mkv", "", ""],
    ["a.png", "image/png", "image/png"],
    ["a.mp4", "image/tiff", "image/tiff"],
  ])("%s typed %j uploads as %j", (name, type, expected) => {
    expect(uploadTypeOf({ name, type })).toBe(expected);
  });

  it("names a known type, and says plainly when there is none", () => {
    expect(unsupportedTypeMessage("image/tiff")).toMatch(/^This file type \(image\/tiff\) isn't supported\./);
    expect(unsupportedTypeMessage("")).toBe(UNKNOWN_TYPE_MESSAGE);
    expect(unsupportedTypeMessage(" ")).toBe(UNKNOWN_TYPE_MESSAGE);
  });
});
