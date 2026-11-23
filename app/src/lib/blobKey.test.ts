import { describe, expect, it } from "vitest";

import { blobLogRef, generateBlobKey, isSignedInUploadKey, uploadSizePayload } from "./blobKey";

function file(name: string): File {
  return new File(["x"], name, { type: "image/jpeg" });
}

// R68 lead follow-up: a key ends in the customer's file name, so a log keeps
// only the host and the key's time and random part.
describe("blobLogRef", () => {
  const HOST = "abc123.public.blob.vercel-storage.com";

  it("keeps the host and <ms>-<random>, and drops the file name", () => {
    const ref = blobLogRef(`https://${HOST}/1763200000000-k3j9x2ab-Maria_Lopez_lesson.mp4`);
    expect(ref).toBe(`${HOST}/1763200000000-k3j9x2ab`);
    expect(ref).not.toContain("Maria");
  });

  it("a short random part is kept too", () => {
    expect(blobLogRef(`https://${HOST}/1763200000000-k3j-Maria.jpg`)).toBe(`${HOST}/1763200000000-k3j`);
  });

  it("a key of another shape: only the host", () => {
    expect(blobLogRef(`https://${HOST}/logos/ws-1/Maria.png`)).toBe(HOST);
    expect(blobLogRef("https://blob.example.com/clip.mp4?token=x#Maria")).toBe("blob.example.com");
  });

  it("an unparseable value", () => {
    expect(blobLogRef("not a url Maria.mp4")).toBe("(unparseable)");
    expect(blobLogRef("")).toBe("(unparseable)");
    expect(blobLogRef(null)).toBe("(unparseable)");
    expect(blobLogRef(undefined)).toBe("(unparseable)");
  });
});

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

describe("uploadSizePayload", () => {
  it("tells /api/upload the file's size, which the token then holds the upload to", () => {
    expect(JSON.parse(uploadSizePayload(new File(["abc"], "a.jpg")))).toEqual({ size: 3 });
  });
});
