import crypto from "crypto";

import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";
import { NextResponse } from "next/server";

import { invalidJsonBodyResponse, readJsonObject } from "@/lib/http";
import { logger } from "@/lib/logger";
import { MAX_MEDIA_BYTES, UPLOAD_ALLOWED_CONTENT_TYPES } from "@/lib/mediaInput";
import { unsupportedTypeMessage } from "@/lib/prepareUploadFile";
import { checkRateLimit } from "@/lib/rateLimit";
import {
  UPLOAD_LINK_BYTES_LIMIT_MESSAGE,
  UPLOAD_LINK_DAILY_LIMIT_MESSAGE,
  UPLOAD_LINK_FILES_PER_DAY,
  UPLOAD_LINK_INACTIVE_MESSAGE,
  UPLOAD_LINK_IP_LIMIT_MESSAGE,
  UPLOAD_LINK_IP_PER_HOUR,
  UPLOAD_LINK_STORAGE_FULL_MESSAGE,
  requestIp,
  uploadLinkPathname,
  uploadLinkStoragePrefix,
} from "@/lib/uploadLink";
import { findActiveUploadLink } from "@/server/uploadLink";
import { checkStorageLimit } from "@/server/usage/workspaceUsage";

import { consumeUploadLinkDayBytes } from "./linkBytes";

/**
 * POST /api/upload-link/[token]/upload — a storage upload token for someone who
 * holds a client upload link, signed out (2026-11-10).
 *
 * The browser fetches this itself and uploads with `put()`, because `upload()`
 * drops the body of a refused token request and the sentences below would be
 * lost. The workspace and the link come only from the token in the URL.
 *
 * The signed client token carries the pathname, and the blob store accepts the
 * file only at that pathname. This route writes the pathname itself, under
 * `ul/<link id>/`, so whatever the browser asks for, the file lands there; the
 * registration route then accepts only files under that prefix.
 */

type RouteContext = { params: Promise<{ token: string }> };

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

function tooMany(error: string, retryAfterSeconds: number | undefined): NextResponse {
  return NextResponse.json(
    { error, retryAfterSeconds },
    { status: 429, headers: { "Retry-After": String(retryAfterSeconds ?? 60) } },
  );
}

/** What the page says about the file (its type and size), sent in the token request's clientPayload. */
function readClientPayload(clientPayload: unknown): { contentType?: unknown; size?: unknown } {
  if (typeof clientPayload !== "string") return {};
  try {
    const parsed: unknown = JSON.parse(clientPayload);
    return typeof parsed === "object" && parsed !== null
      ? (parsed as { contentType?: unknown; size?: unknown })
      : {};
  } catch {
    return {};
  }
}

export async function POST(request: Request, context: RouteContext): Promise<NextResponse> {
  // First, before any lookup, so the route cannot be used to guess tokens quickly.
  const ipLimit = await checkRateLimit({
    userId: `ip:${requestIp(request)}`,
    route: "upload-link/upload",
    limit: UPLOAD_LINK_IP_PER_HOUR,
    windowMs: HOUR_MS,
    failClosed: true,
  });
  if (!ipLimit.allowed) return tooMany(UPLOAD_LINK_IP_LIMIT_MESSAGE, ipLimit.retryAfterSeconds);

  const { token } = await context.params;
  const link = await findActiveUploadLink(token);
  if (!link) {
    return NextResponse.json({ error: UPLOAD_LINK_INACTIVE_MESSAGE }, { status: 404 });
  }

  const body = await readJsonObject(request);
  if (!body) return invalidJsonBodyResponse();
  // Only token requests: no upload-completed callback is ever registered here.
  if (body.type !== "blob.generate-client-token") {
    return NextResponse.json({ error: "Unsupported request." }, { status: 400 });
  }
  const payload =
    typeof body.payload === "object" && body.payload !== null
      ? (body.payload as Record<string, unknown>)
      : null;
  if (!payload || typeof payload.pathname !== "string") {
    return NextResponse.json({ error: "A file name is required." }, { status: 400 });
  }
  const claimed = readClientPayload(payload.clientPayload);
  const contentType = claimed.contentType;
  if (typeof contentType !== "string" || !UPLOAD_ALLOWED_CONTENT_TYPES.includes(contentType)) {
    return NextResponse.json(
      { error: unsupportedTypeMessage(typeof contentType === "string" ? contentType : "unknown") },
      { status: 400 },
    );
  }
  // The size asked for is counted against the link's day and signed into the
  // token as its maximum, so the stored file can be no larger. A page that
  // names no size is counted as the largest file.
  const size = claimed.size === undefined ? MAX_MEDIA_BYTES : claimed.size;
  if (typeof size !== "number" || !Number.isSafeInteger(size) || size <= 0 || size > MAX_MEDIA_BYTES) {
    return NextResponse.json({ error: "File is too large (max 512 MB)." }, { status: 400 });
  }

  const dayLimit = await checkRateLimit({
    userId: `upload-link:${link.id}`,
    route: "upload-link/upload-day",
    limit: UPLOAD_LINK_FILES_PER_DAY,
    windowMs: DAY_MS,
    failClosed: true,
  });
  if (!dayLimit.allowed) return tooMany(UPLOAD_LINK_DAILY_LIMIT_MESSAGE, dayLimit.retryAfterSeconds);

  const bytesLimit = await consumeUploadLinkDayBytes(link.id, size);
  if (!bytesLimit.allowed) return tooMany(UPLOAD_LINK_BYTES_LIMIT_MESSAGE, bytesLimit.retryAfterSeconds);

  const storageFull = await checkStorageLimit(link.workspaceId);
  if (storageFull) {
    return NextResponse.json(
      { error: UPLOAD_LINK_STORAGE_FULL_MESSAGE, code: storageFull.code },
      { status: 403 },
    );
  }

  const prefix = uploadLinkStoragePrefix(link.id);
  const pathname = uploadLinkPathname(link.id, payload.pathname, crypto.randomBytes(8).toString("hex"));
  const tokenBody = {
    type: "blob.generate-client-token",
    payload: { pathname, clientPayload: null, multipart: payload.multipart === true },
  } as HandleUploadBody;

  try {
    const jsonResponse = await handleUpload({
      body: tokenBody,
      request,
      onBeforeGenerateToken: async (signedPathname) => {
        // Belt and braces: the pathname above is ours, but never sign one outside the prefix.
        if (!signedPathname.startsWith(prefix)) {
          throw new Error("Upload path outside the link's prefix");
        }
        logger.info("[upload-link] Generating token", { pathname: signedPathname, linkId: link.id });
        return {
          allowedContentTypes: [contentType],
          maximumSizeInBytes: size,
          addRandomSuffix: false,
          allowOverwrite: false,
        };
      },
    });
    return NextResponse.json({ ...jsonResponse, pathname });
  } catch (error) {
    logger.error("[upload-link] Token error", { error, linkId: link.id });
    return NextResponse.json({ error: "Couldn't start the upload. Try again." }, { status: 400 });
  }
}
