import { randomBytes } from "node:crypto";

import sharp from "sharp";

import {
  LOGO_MAX_HEIGHT,
  LOGO_MAX_WIDTH,
  LOGO_NOT_IMAGE_MESSAGE,
  LOGO_SVG_MESSAGE,
} from "@/lib/workspaceLogo";

/**
 * The workspace's report logo (18b), server side: the upload body read with a
 * hard byte limit, and the picture turned into the server's own PNG so what is
 * stored is never the uploaded bytes.
 */

/**
 * Pixels a decoded upload may have. 1 MB of compressed PNG can claim tens of
 * thousands of pixels a side; sharp's own default (268 million) would let one
 * request take gigabytes of memory. 40 million covers any real logo photo.
 */
const LOGO_MAX_INPUT_PIXELS = 40_000_000;

export class LogoRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LogoRejectedError";
  }
}

export { readBodyAtMost, type BoundedBody } from "@/lib/boundedBody";

/**
 * Decodes the upload (which proves it is a picture: anything sharp cannot
 * fully decode, a truncated file included, is refused), refuses SVG, turns it
 * upright, fits it inside 600 by 300 without enlarging, and re-encodes it as PNG.
 */
export async function normalizeLogo(input: Buffer): Promise<Buffer> {
  const options = { limitInputPixels: LOGO_MAX_INPUT_PIXELS, failOn: "warning" as const };
  let format: string | undefined;
  try {
    format = (await sharp(input, options).metadata()).format;
  } catch {
    throw new LogoRejectedError(LOGO_NOT_IMAGE_MESSAGE);
  }
  // An SVG can carry script and links, and drawing it means rendering
  // untrusted markup: refused even though sharp could draw it.
  if (format === "svg") throw new LogoRejectedError(LOGO_SVG_MESSAGE);
  try {
    return await sharp(input, options)
      .rotate()
      .resize(LOGO_MAX_WIDTH, LOGO_MAX_HEIGHT, { fit: "inside", withoutEnlargement: true })
      .png()
      .toBuffer();
  } catch {
    throw new LogoRejectedError(LOGO_NOT_IMAGE_MESSAGE);
  }
}

/**
 * Where a new logo is stored: a fresh name each time, so a replaced file is
 * never overwritten. The address is public (the client's report, the email),
 * so it names no workspace; the workspace is only ever Workspace.logoUrl's row.
 */
export function logoBlobPath(): string {
  return `logos/${randomBytes(16).toString("hex")}.png`;
}
