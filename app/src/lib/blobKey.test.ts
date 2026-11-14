import { describe, expect, it } from "vitest";

import { generateBlobKey, isSignedInUploadKey } from "./blobKey";

function file(name: string): File {
  return new File(["x"], name, { type: "image/jpeg" });
}

describe("isSignedInUploadKey", () => {
  it("accepts every key generateBlobKey makes, whatever the file was called", () => {
    for (const name of ["cat.png", "IMG 0001.HEIC", "Beach day (2).jpg", "фото.jpg", "a", "..", "x.y.z.mp4"]) {
      const key = generateBlobKey(file(name));
      expect(isSignedInUploadKey(key), key).toBe(true);
    }
  });

  it("accepts a key whose random part came out short", () => {
    expect(isSignedInUploadKey("1731600000000--cat.png")).toBe(true);
    expect(isSignedInUploadKey("1731600000000-a1-cat.png")).toBe(true);
  });

  it("refuses anything else: a bare name, a folder, another prefix, odd characters", () => {
    for (const pathname of [
      "a.jpg",
      "",
      "1731600000000-ab12cd34-",
      "173160000000-ab12cd34-cat.png",
      "1731600000000-AB12CD34-cat.png",
      "1731600000000-ab12cd34x-cat.png",
      "/1731600000000-ab12cd34-cat.png",
      "x/1731600000000-ab12cd34-cat.png",
      "1731600000000-ab12cd34-x/cat.png",
      "ul/link-1/0123456789abcdef-cat.png",
      "covers/ws-1/1731600000000-ab12cd34-cover.jpg",
      "logos/0123.png",
      "1731600000000-ab12cd34-cat%2F.png",
      "1731600000000-ab12cd34-cat .png",
    ]) {
      expect(isSignedInUploadKey(pathname), pathname).toBe(false);
    }
  });
});
