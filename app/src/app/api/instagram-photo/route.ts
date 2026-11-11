import { NextResponse } from "next/server";

import { isAllowedBlobUrl } from "@/lib/blobUrl";
import { fetchWithTimeout } from "@/lib/fetchWithTimeout";
import { logger } from "@/lib/logger";
import {
  INSTAGRAM_PHOTO_MAX_SOURCE_BYTES,
  toInstagramJpeg,
  verifyInstagramPhotoRequest,
} from "@/server/platforms/instagramPhoto";

export const runtime = "nodejs";

/**
 * GET /api/instagram-photo?src=<blob url>&exp=<ms>[&fit=story]&sig=<hmac>
 *
 * Serves a stored photo the way Instagram accepts it (server/platforms/
 * instagramPhoto.ts). Instagram fetches it while the Instagram client creates a
 * media container. No session: the signature (made with NEXTAUTH_SECRET, valid
 * 2 hours) is the authorization, and `src` must be one of this app's own blob
 * URLs, so the route cannot be used to fetch anything else.
 */
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const src = params.get("src");
  // `fit=story` (2026-11-10): the uncropped Story copy. The signature covers it.
  const fit = params.get("fit");

  if (
    !verifyInstagramPhotoRequest(src, params.get("exp"), params.get("sig"), Date.now(), fit) ||
    !isAllowedBlobUrl(src)
  ) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  try {
    const upstream = await fetchWithTimeout(src, {}, 20_000);
    if (!upstream.ok) {
      logger.warn("[InstagramPhoto] Source fetch failed", { status: upstream.status });
      return NextResponse.json({ error: "Photo unavailable" }, { status: 502 });
    }
    const declared = Number(upstream.headers.get("content-length") ?? "0");
    if (declared > INSTAGRAM_PHOTO_MAX_SOURCE_BYTES) {
      return NextResponse.json({ error: "Photo too large" }, { status: 413 });
    }
    const source = Buffer.from(await upstream.arrayBuffer());
    if (source.length > INSTAGRAM_PHOTO_MAX_SOURCE_BYTES) {
      return NextResponse.json({ error: "Photo too large" }, { status: 413 });
    }

    const jpeg = await toInstagramJpeg(source, fit === "story" ? "story" : "feed");
    return new Response(new Uint8Array(jpeg), {
      status: 200,
      headers: {
        "Content-Type": "image/jpeg",
        "Content-Length": String(jpeg.length),
        "Cache-Control": "public, max-age=3600",
      },
    });
  } catch (error) {
    logger.error("[InstagramPhoto] Could not prepare the photo", { error });
    return NextResponse.json({ error: "Could not prepare the photo" }, { status: 500 });
  }
}
