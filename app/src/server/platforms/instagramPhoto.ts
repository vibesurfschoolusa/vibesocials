import { createHmac, timingSafeEqual } from "node:crypto";

import sharp, { type Metadata } from "sharp";

/**
 * Instagram's own copy of a photo (added 2026-11 after a live test).
 *
 * Instagram fetches a photo from a public URL and refuses anything that is not
 * a JPEG or whose shape is outside 4:5 (portrait) to 1.91:1 (landscape). Phone
 * photos are often 3:4 or 9:16, so they failed. Instead of the stored blob,
 * the Instagram client now hands Instagram a signed URL on this app
 * (`/api/instagram-photo`), which serves the photo as a JPEG cropped into that
 * range around its most interesting part (sharp's "attention" strategy) and at
 * most 1,440 px wide. The stored photo, and every other platform, is unchanged.
 */

/** Tallest shape Instagram accepts: 4:5 portrait. */
export const INSTAGRAM_MIN_ASPECT = 4 / 5;
/** Widest shape Instagram accepts: 1.91:1 landscape. */
export const INSTAGRAM_MAX_ASPECT = 1.91;
/** Instagram shows feed photos at most 1,440 px wide. */
export const INSTAGRAM_MAX_WIDTH = 1440;
/** Route that serves the copy (app/api/instagram-photo/route.ts). */
export const INSTAGRAM_PHOTO_PATH = "/api/instagram-photo";
/** How long a signed URL works: Instagram fetches while the container is created. */
export const INSTAGRAM_PHOTO_URL_TTL_MS = 2 * 60 * 60 * 1000;
/** Largest stored photo the route will read (the upload route caps media at 512 MB). */
export const INSTAGRAM_PHOTO_MAX_SOURCE_BYTES = 50 * 1024 * 1024;

function signingSecret(): string {
  const secret = process.env.NEXTAUTH_SECRET;
  if (!secret) {
    throw new Error("NEXTAUTH_SECRET must be set to sign Instagram photo URLs.");
  }
  return secret;
}

/**
 * Which copy: `feed` is cropped into 4:5..1.91:1; `story` (2026-11-10) keeps the
 * photo's shape, since a Story is usually 9:16 and the IG User Media reference
 * recommends 9:16 for a Story image.
 */
export type InstagramPhotoFit = "feed" | "story";

function signature(src: string, expiresAt: number, fit: InstagramPhotoFit): string {
  // The feed string is the one signed before Stories existed, so a feed URL
  // handed out just before a deploy still verifies after it.
  const signed = `instagram-photo\n${src}\n${expiresAt}` + (fit === "story" ? "\nstory" : "");
  return createHmac("sha256", signingSecret()).update(signed).digest("hex");
}

/** The URL Instagram is given for `src` (a stored blob URL). */
export function instagramPhotoUrl(
  appBaseUrl: string,
  src: string,
  now: number = Date.now(),
  fit: InstagramPhotoFit = "feed",
): string {
  const expiresAt = now + INSTAGRAM_PHOTO_URL_TTL_MS;
  const url = new URL(INSTAGRAM_PHOTO_PATH, appBaseUrl);
  url.searchParams.set("src", src);
  url.searchParams.set("exp", String(expiresAt));
  if (fit === "story") url.searchParams.set("fit", "story");
  url.searchParams.set("sig", signature(src, expiresAt, fit));
  return url.toString();
}

/**
 * True when (src, exp, sig, fit) was signed by {@link instagramPhotoUrl} and has
 * not expired. `fit` is the URL's `fit` parameter: absent (null) for the feed
 * copy, "story" for the Story copy; anything else is refused.
 */
export function verifyInstagramPhotoRequest(
  src: string | null,
  exp: string | null,
  sig: string | null,
  now: number = Date.now(),
  fit: string | null = null,
): src is string {
  if (!src || !exp || !sig || !/^\d{1,16}$/.test(exp) || !/^[0-9a-f]{64}$/.test(sig)) {
    return false;
  }
  if (fit !== null && fit !== "story") {
    return false;
  }
  const expiresAt = Number(exp);
  if (expiresAt < now) {
    return false;
  }
  const expected = Buffer.from(signature(src, expiresAt, fit === "story" ? "story" : "feed"), "hex");
  const given = Buffer.from(sig, "hex");
  return expected.length === given.length && timingSafeEqual(expected, given);
}

/**
 * The crop that brings (width, height) into Instagram's range, or null when it
 * is already in range. Only one side is cut: a too-tall photo loses height, a
 * too-wide photo loses width.
 */
export function instagramCropSize(width: number, height: number): { width: number; height: number } | null {
  if (isTooTall(width, height)) {
    return { width, height: tallestHeightFor(width) };
  }
  if (isTooWide(width, height)) {
    return { width: widestWidthFor(height), height };
  }
  return null;
}

/**
 * The output size for a (cropped) photo: at most {@link INSTAGRAM_MAX_WIDTH}
 * wide, and still inside 4:5..1.91:1 after rounding to whole pixels.
 */
export function instagramOutputSize(width: number, height: number): { width: number; height: number } {
  const scale = Math.min(1, INSTAGRAM_MAX_WIDTH / width);
  let outWidth = Math.max(1, Math.round(width * scale));
  let outHeight = Math.max(1, Math.round(height * scale));
  if (isTooTall(outWidth, outHeight)) {
    outHeight = tallestHeightFor(outWidth);
  } else if (isTooWide(outWidth, outHeight)) {
    outWidth = widestWidthFor(outHeight);
  }
  return { width: outWidth, height: outHeight };
}

// The range checks use whole numbers (4:5 and 191:100), not the float
// constants: 768 / 0.8 is 959.999... in floating point, and a cut side rounded
// the wrong way (e.g. 1170 x 2532 -> 1170 x 1463) lands a hair outside the range.
function isTooTall(width: number, height: number): boolean {
  return width * 5 < height * 4;
}
function isTooWide(width: number, height: number): boolean {
  return width * 100 > height * 191;
}
function tallestHeightFor(width: number): number {
  return Math.max(1, Math.floor((width * 5) / 4));
}
function widestWidthFor(height: number): number {
  return Math.max(1, Math.floor((height * 191) / 100));
}

/**
 * The image URL to give Instagram for a stored photo: the signed copy on this
 * app, or the stored URL itself when the app has no public address Instagram
 * could reach (no NEXTAUTH_URL, or a localhost one in local development).
 */
export function instagramImageUrl(
  mediaUrl: string,
  appBaseUrl: string | undefined,
  fit: InstagramPhotoFit = "feed",
): string {
  if (!appBaseUrl) return mediaUrl;
  let host: string;
  try {
    host = new URL(appBaseUrl).hostname;
  } catch {
    return mediaUrl;
  }
  if (host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host.endsWith(".localhost")) {
    return mediaUrl;
  }
  return instagramPhotoUrl(appBaseUrl, mediaUrl, Date.now(), fit);
}

/** A Story copy's size: the same shape, at most {@link INSTAGRAM_MAX_WIDTH} wide. */
function storyOutputSize(width: number, height: number): { width: number; height: number } {
  const scale = Math.min(1, INSTAGRAM_MAX_WIDTH / width);
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/** (width, height) after the EXIF orientation is applied (orientations 5-8 swap them). */
function orientedSize(metadata: Metadata): { width: number; height: number } {
  const width = metadata.width ?? 0;
  const height = metadata.height ?? 0;
  return (metadata.orientation ?? 1) >= 5 ? { width: height, height: width } : { width, height };
}

/**
 * The photo as Instagram accepts it: an upright JPEG, at most
 * {@link INSTAGRAM_MAX_WIDTH} wide, and for the feed cropped into range. A Story
 * copy keeps its shape. A JPEG that already fits is returned as is.
 */
export async function toInstagramJpeg(input: Buffer, fit: InstagramPhotoFit = "feed"): Promise<Buffer> {
  const metadata = await sharp(input, { failOn: "none" }).metadata();
  const { width, height } = orientedSize(metadata);
  if (!width || !height) {
    throw new Error("Could not read the photo's size");
  }

  const crop = fit === "story" ? null : instagramCropSize(width, height);
  const upright = (metadata.orientation ?? 1) === 1;
  if (metadata.format === "jpeg" && !crop && upright && width <= INSTAGRAM_MAX_WIDTH) {
    return input;
  }

  const target = crop ?? { width, height };
  const { width: outWidth, height: outHeight } =
    fit === "story" ? storyOutputSize(width, height) : instagramOutputSize(target.width, target.height);

  return sharp(input, { failOn: "none" })
    .rotate() // apply the EXIF orientation, then drop it
    .resize(outWidth, outHeight, { fit: "cover", position: sharp.strategy.attention })
    .flatten({ background: "#ffffff" }) // a JPEG has no transparency
    .jpeg({ quality: 90, mozjpeg: true })
    .toBuffer();
}
