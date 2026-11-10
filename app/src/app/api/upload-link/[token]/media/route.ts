import { after, NextResponse } from "next/server";

import { BLOB_URL_REJECTED_MESSAGE, canonicalBlobUrl } from "@/lib/blobUrl";
import { prisma } from "@/lib/db";
import { invalidJsonBodyResponse, readJsonObject } from "@/lib/http";
import { logger } from "@/lib/logger";
import { FILENAME_MAX_LENGTH, MAX_MEDIA_BYTES, isImageOrVideoMimeType } from "@/lib/mediaInput";
import { checkRateLimit } from "@/lib/rateLimit";
import {
  UPLOAD_LINK_DAILY_LIMIT_MESSAGE,
  UPLOAD_LINK_FILES_PER_DAY,
  UPLOAD_LINK_INACTIVE_MESSAGE,
  UPLOAD_LINK_IP_LIMIT_MESSAGE,
  UPLOAD_LINK_IP_PER_HOUR,
  cleanSenderText,
  isUploadLinkBlobPath,
  requestIp,
} from "@/lib/uploadLink";
import { findActiveUploadLink, notifyOwnersOfClientUpload } from "@/server/uploadLink";

/**
 * POST /api/upload-link/[token]/media — puts a file sent through a client
 * upload link into the workspace's Media library (2026-11-10), signed out.
 *
 * Applies the blob checks of POST /api/media, plus one: the file must sit under
 * `ul/<this link's id>/`, which only this link's upload route signs. So a
 * stranger cannot attach some other file in the store, nor one sent through
 * another workspace's link. The workspace, the owner of the row and the link
 * all come from the token; nothing in the body can choose them. The answer
 * carries nothing about the workspace or the row.
 */

type RouteContext = { params: Promise<{ token: string }> };

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

const OUTSIDE_LINK_MESSAGE = "This file was not sent through this link.";

function tooMany(error: string, retryAfterSeconds: number | undefined): NextResponse {
  return NextResponse.json(
    { error, retryAfterSeconds },
    { status: 429, headers: { "Retry-After": String(retryAfterSeconds ?? 60) } },
  );
}

export async function POST(request: Request, context: RouteContext): Promise<NextResponse> {
  const ipLimit = await checkRateLimit({
    userId: `ip:${requestIp(request)}`,
    route: "upload-link/media",
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

  if (!(request.headers.get("content-type") ?? "").includes("application/json")) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 400 });
  }
  const body = await readJsonObject(request);
  if (!body) return invalidJsonBodyResponse();

  const blobUrl = canonicalBlobUrl(typeof body.blobUrl === "string" ? body.blobUrl : "");
  if (!blobUrl) {
    return NextResponse.json({ error: BLOB_URL_REJECTED_MESSAGE }, { status: 400 });
  }
  if (!isUploadLinkBlobPath(blobUrl, link.id)) {
    return NextResponse.json({ error: OUTSIDE_LINK_MESSAGE }, { status: 400 });
  }
  if (!isImageOrVideoMimeType(body.mimeType)) {
    return NextResponse.json(
      { error: "Only image or video files can be added to the library." },
      { status: 400 },
    );
  }
  const mimeType = body.mimeType;
  const sizeBytes =
    typeof body.sizeBytes === "number" && Number.isFinite(body.sizeBytes) ? body.sizeBytes : 0;
  if (sizeBytes <= 0 || sizeBytes > MAX_MEDIA_BYTES) {
    return NextResponse.json({ error: "File is too large (max 512 MB)." }, { status: 400 });
  }
  const filename =
    (typeof body.filename === "string" ? body.filename.trim().slice(0, FILENAME_MAX_LENGTH) : "") ||
    "upload";
  const senderName = cleanSenderText(body.senderName, { singleLine: true });
  const note = cleanSenderText(body.note);

  // Counted after the checks, so a refused request does not spend the link's day.
  const dayLimit = await checkRateLimit({
    userId: `upload-link:${link.id}`,
    route: "upload-link/media-day",
    limit: UPLOAD_LINK_FILES_PER_DAY,
    windowMs: DAY_MS,
    failClosed: true,
  });
  if (!dayLimit.allowed) return tooMany(UPLOAD_LINK_DAILY_LIMIT_MESSAGE, dayLimit.retryAfterSeconds);

  const now = new Date();
  try {
    await prisma.$transaction([
      prisma.mediaItem.create({
        data: {
          workspaceId: link.workspaceId,
          // A media item needs an owner: the person who made the link.
          userId: link.createdById,
          storageLocation: blobUrl,
          originalFilename: filename,
          mimeType,
          sizeBytes,
          baseCaption: "",
          metadata: {
            source: "upload_link",
            linkId: link.id,
            ...(senderName ? { senderName } : {}),
            ...(note ? { note } : {}),
          },
        },
      }),
      prisma.workspaceUploadLink.update({
        where: { id: link.id },
        data: { lastUsedAt: now, uploadCount: { increment: 1 } },
      }),
    ]);
  } catch (error) {
    logger.error("[upload-link] Couldn't register a client file", { error, linkId: link.id });
    return NextResponse.json({ error: "Couldn't save the file. Try again." }, { status: 500 });
  }

  // After the response: the email never delays or fails the client's upload.
  after(async () => {
    try {
      await notifyOwnersOfClientUpload({
        linkId: link.id,
        workspaceId: link.workspaceId,
        workspaceName: link.workspaceName,
        senderName,
        now,
      });
    } catch (error) {
      logger.error("[upload-link] Owner email failed (ignored)", { error, linkId: link.id });
    }
  });

  return NextResponse.json({ ok: true }, { status: 201 });
}
