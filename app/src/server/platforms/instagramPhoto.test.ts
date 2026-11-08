import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  INSTAGRAM_MAX_WIDTH,
  INSTAGRAM_PHOTO_URL_TTL_MS,
  instagramCropSize,
  instagramImageUrl,
  instagramOutputSize,
  instagramPhotoUrl,
  toInstagramJpeg,
  verifyInstagramPhotoRequest,
} from "./instagramPhoto";

const SRC = "https://store.public.blob.vercel-storage.com/1-abc-IMG_5252.jpg";
const NOW = Date.parse("2026-11-08T12:00:00Z");

beforeEach(() => {
  vi.stubEnv("NEXTAUTH_SECRET", "test-secret");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function params(url: string) {
  const parsed = new URL(url);
  return {
    src: parsed.searchParams.get("src"),
    exp: parsed.searchParams.get("exp"),
    sig: parsed.searchParams.get("sig"),
  };
}

describe("instagramPhotoUrl / verifyInstagramPhotoRequest", () => {
  it("signs a URL on the app that verifies until it expires", () => {
    const url = instagramPhotoUrl("https://vibesocials.wtf", SRC, NOW);
    const { src, exp, sig } = params(url);

    expect(url.startsWith("https://vibesocials.wtf/api/instagram-photo?")).toBe(true);
    expect(src).toBe(SRC);
    expect(Number(exp)).toBe(NOW + INSTAGRAM_PHOTO_URL_TTL_MS);
    expect(verifyInstagramPhotoRequest(src, exp, sig, NOW)).toBe(true);
    expect(verifyInstagramPhotoRequest(src, exp, sig, NOW + INSTAGRAM_PHOTO_URL_TTL_MS + 1)).toBe(false);
  });

  it("refuses a changed source, a changed expiry, a bad signature or missing parts", () => {
    const { src, exp, sig } = params(instagramPhotoUrl("https://vibesocials.wtf", SRC, NOW));

    expect(verifyInstagramPhotoRequest(`${src}x`, exp, sig, NOW)).toBe(false);
    expect(verifyInstagramPhotoRequest(src, String(Number(exp) + 1), sig, NOW)).toBe(false);
    expect(verifyInstagramPhotoRequest(src, exp, "0".repeat(64), NOW)).toBe(false);
    expect(verifyInstagramPhotoRequest(src, exp, "not-hex", NOW)).toBe(false);
    expect(verifyInstagramPhotoRequest(null, exp, sig, NOW)).toBe(false);
    expect(verifyInstagramPhotoRequest(src, null, sig, NOW)).toBe(false);
  });

  it("refuses a URL signed with another secret", () => {
    const { src, exp, sig } = params(instagramPhotoUrl("https://vibesocials.wtf", SRC, NOW));
    vi.stubEnv("NEXTAUTH_SECRET", "rotated-secret");
    expect(verifyInstagramPhotoRequest(src, exp, sig, NOW)).toBe(false);
  });
});

describe("instagramCropSize", () => {
  it.each([
    ["3:4 portrait (the live-test photo)", 768, 1024, { width: 768, height: 960 }],
    ["9:16 portrait", 1080, 1920, { width: 1080, height: 1350 }],
    ["3:1 panorama", 3000, 1000, { width: 1910, height: 1000 }],
  ])("crops %s into range", (_name, width, height, expected) => {
    expect(instagramCropSize(width, height)).toEqual(expected);
  });

  it.each([
    ["4:5", 1080, 1350],
    ["square", 1080, 1080],
    ["4:3 landscape", 4032, 3024],
    ["1.91:1", 1910, 1000],
  ])("leaves %s alone", (_name, width, height) => {
    expect(instagramCropSize(width, height)).toBeNull();
  });

  // Review finding: rounding the cut side up landed these a hair outside the range.
  it.each([
    [1170, 2532],
    [1290, 2796],
    [750, 1334],
    [1500, 701],
    [999, 3001],
    [4001, 2],
  ])("keeps %i x %i inside 4:5..1.91:1 after the crop and the resize", (width, height) => {
    const crop = instagramCropSize(width, height) ?? { width, height };
    const out = instagramOutputSize(crop.width, crop.height);
    for (const size of [crop, out]) {
      expect(size.width * 5).toBeGreaterThanOrEqual(size.height * 4);
      expect(size.width * 100).toBeLessThanOrEqual(size.height * 191);
    }
    expect(out.width).toBeLessThanOrEqual(INSTAGRAM_MAX_WIDTH);
  });
});

describe("instagramImageUrl", () => {
  it("uses the signed copy on a public app URL", () => {
    expect(instagramImageUrl(SRC, "https://vibesocials.wtf")).toMatch(
      /^https:\/\/vibesocials\.wtf\/api\/instagram-photo\?src=/,
    );
  });

  it.each([undefined, "", "http://localhost:3000", "http://127.0.0.1:3000", "http://app.localhost", "not a url"])(
    "falls back to the stored URL when Instagram could not reach the app (%s)",
    (base) => {
      expect(instagramImageUrl(SRC, base)).toBe(SRC);
    },
  );
});

describe("toInstagramJpeg", () => {
  const solid = (width: number, height: number) =>
    sharp({ create: { width, height, channels: 3, background: { r: 30, g: 120, b: 200 } } });

  async function sizeOf(buffer: Buffer) {
    const metadata = await sharp(buffer).metadata();
    return { format: metadata.format, width: metadata.width, height: metadata.height };
  }

  it("crops a 3:4 JPEG to 4:5", async () => {
    const out = await toInstagramJpeg(await solid(768, 1024).jpeg().toBuffer());
    expect(await sizeOf(out)).toEqual({ format: "jpeg", width: 768, height: 960 });
  });

  it("crops a 9:16 photo to 4:5 and keeps it within 1,440 px wide", async () => {
    const out = await toInstagramJpeg(await solid(2160, 3840).jpeg().toBuffer());
    expect(await sizeOf(out)).toEqual({ format: "jpeg", width: INSTAGRAM_MAX_WIDTH, height: 1800 });
  });

  it("turns a transparent PNG into a JPEG", async () => {
    const png = await sharp({
      create: { width: 1000, height: 1000, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    })
      .png()
      .toBuffer();
    expect(await sizeOf(await toInstagramJpeg(png))).toEqual({ format: "jpeg", width: 1000, height: 1000 });
  });

  it("applies the EXIF orientation before measuring the shape", async () => {
    // Stored 1024 wide x 768 tall, tagged "rotate 90": upright it is 768 x 1024 (3:4).
    const rotated = await solid(1024, 768).jpeg().withMetadata({ orientation: 6 }).toBuffer();
    const out = await toInstagramJpeg(rotated);
    expect(await sizeOf(out)).toEqual({ format: "jpeg", width: 768, height: 960 });
    expect((await sharp(out).metadata()).orientation ?? 1).toBe(1);
  });

  it("returns a JPEG that already fits unchanged", async () => {
    const fits = await solid(1080, 1350).jpeg().toBuffer();
    expect(await toInstagramJpeg(fits)).toBe(fits);
  });

  it("shrinks a wide-enough but oversized JPEG to 1,440 px wide", async () => {
    const out = await toInstagramJpeg(await solid(4032, 3024).jpeg().toBuffer());
    expect(await sizeOf(out)).toEqual({ format: "jpeg", width: 1440, height: 1080 });
  });
});
