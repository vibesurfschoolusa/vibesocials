import { describe, expect, it, vi } from "vitest";

import {
  HEIC_CONVERSION_FAILED_MESSAGE,
  HEIC_JPEG_QUALITY,
  MAX_UPLOAD_PHOTO_BYTES,
  NO_EXTENSION_MESSAGE,
  SHRINK_ATTEMPTS,
  UNKNOWN_TYPE_MESSAGE,
  fitWithin,
  isHeicFile,
  jpegFileName,
  prepareUploadFile,
  preparedTypeOf,
  unknownTypeMessage,
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

  // R47 lead review: only a real extension (the extensionOf rule) is swapped,
  // so a dot in a date or a place name stays in the name.
  it("swaps only a real extension, and keeps the rest of the name", () => {
    expect(jpegFileName("St. Lucia sunset.heic")).toBe("St. Lucia sunset.jpg");
    expect(jpegFileName("St. Lucia sunset")).toBe("St. Lucia sunset.jpg");
    expect(jpegFileName("Surf day 19.11.2026")).toBe("Surf day 19.11.2026.jpg");
    expect(jpegFileName("photo.HEIC")).toBe("photo.jpg");
    expect(jpegFileName("a.b.png")).toBe("a.b.jpg");
  });

  // R47 review: the new name never has a dot or a space before ".jpg".
  it("trims dots and spaces left at the end of the name", () => {
    expect(jpegFileName("St. Lucia sunset..heic")).toBe("St. Lucia sunset.jpg");
    expect(jpegFileName("Surf day 19.11. .heic")).toBe("Surf day 19.11.jpg");
    expect(jpegFileName("... .heic")).toBe("photo.jpg");
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

  // R47 lead review: Create (and every "choose" place) keeps its own step; /u names Send more.
  it("the HEIC sentence: unchanged where the file is chosen again, Send more on /u", async () => {
    const deps = fakeDeps({ convertHeicToJpeg: vi.fn(async () => Promise.reject(new Error("libheif: bad box"))) });
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(HEIC_CONVERSION_FAILED_MESSAGE).toBe("We couldn't convert this iPhone (HEIC) photo. Export it as a JPEG and try again.");
    await expect(prepareUploadFile(file("IMG.heic", "image/heic"), deps, "sendMore")).rejects.toThrow(
      "We couldn't convert this iPhone (HEIC) photo. Export it as a JPEG, then press Send more and choose it again.",
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

  // R46 client-journey L2: a photo saved with no extension can't be told by its
  // name, and choosing it again fails the same way; the sentence names the step that works.
  it("a file with no type and no extension: the step that works, with the type list", async () => {
    for (const name of ["IMG_0042", "notes."]) {
      await expect(prepareUploadFile(file(name, ""), fakeDeps()), name).rejects.toThrow(NO_EXTENSION_MESSAGE);
    }
    expect(NO_EXTENSION_MESSAGE).toBe(
      "We couldn't tell what kind of file this is. If it's a photo or video, add .jpg or .mp4 to the end of its name, then choose it again. Use a JPEG, PNG, GIF or WebP photo, or an MP4, MOV or WebM video.",
    );
  });

  // R47 client-journey L2: a dot in a name is not always an extension. A date,
  // a time or "St. Lucia" left the name with none, and no step.
  it("a dot that is not an extension: the step that works", async () => {
    for (const name of ["Surf day 19.11.2026", "Session at 10.30", "St. Lucia sunset", "IMG.0042"]) {
      await expect(prepareUploadFile(file(name, ""), fakeDeps()), name).rejects.toThrow(NO_EXTENSION_MESSAGE);
      expect(unknownTypeMessage(name), name).toBe(NO_EXTENSION_MESSAGE);
    }
  });

  it("a real extension keeps its behaviour: clip.mkv is refused plainly, photo.JPG goes, file.tar.gz reads as gz", async () => {
    expect(unknownTypeMessage("clip.mkv")).toBe(UNKNOWN_TYPE_MESSAGE);
    expect(unknownTypeMessage("file.tar.gz")).toBe(UNKNOWN_TYPE_MESSAGE);
    expect(uploadTypeOf({ name: "photo.JPG", type: "" })).toBe("image/jpeg");
    expect(uploadTypeOf({ name: "Surf day 19.11.2026.mp4", type: "" })).toBe("video/mp4");
    expect((await prepareUploadFile(file("photo.JPG", ""), fakeDeps())).type).toBe("image/jpeg");
  });

  // R47 client-journey L1: on /u the picker is gone once the files were tried;
  // "Send more" brings it back, so the step names it.
  it("the upload link's context names Send more", () => {
    expect(unknownTypeMessage("IMG_0042", "sendMore")).toBe(
      "We couldn't tell what kind of file this is. If it's a photo or video, add .jpg or .mp4 to the end of its name, then press Send more and choose it again. Use a JPEG, PNG, GIF or WebP photo, or an MP4, MOV or WebM video.",
    );
    expect(unknownTypeMessage("clip.mkv", "sendMore")).toBe(UNKNOWN_TYPE_MESSAGE);
  });

  it("refuses a file whose type can't be told with a plain sentence, never \"()\"", async () => {
    for (const name of ["clip.mkv", "file.tar.gz", "photo.heics"]) {
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
