import { BlobNotFoundError, head, type HeadBlobResult } from "@vercel/blob";
import { after, NextResponse } from "next/server";

import {
  BLOB_URL_REJECTED_MESSAGE,
  canonicalBlobUrl,
  guardBlobKey,
  ownBlobStoreId,
} from "@/lib/blobUrl";
import { prisma } from "@/lib/db";
import { logoAddressRefusal } from "@/lib/workspaceLogo";
import { invalidJsonBodyResponse, readJsonObject } from "@/lib/http";
import { logger } from "@/lib/logger";
import { FILENAME_MAX_LENGTH, MAX_MEDIA_BYTES, UPLOAD_ALLOWED_CONTENT_TYPES } from "@/lib/mediaInput";
import { unsupportedTypeMessage } from "@/lib/prepareUploadFile";
import { checkRateLimit } from "@/lib/rateLimit";
import {
  UPLOAD_LINK_DAILY_LIMIT_MESSAGE,
  UPLOAD_LINK_FILES_PER_DAY,
  UPLOAD_LINK_INACTIVE_MESSAGE,
  UPLOAD_LINK_IP_LIMIT_MESSAGE,
  UPLOAD_LINK_IP_PER_HOUR,
  cleanSenderText,
  isUploadLinkPathname,
  requestIp,
  uploadLinkIdOfBlobUrl,
} from "@/lib/uploadLink";
import {
  findActiveUploadLink,
  notifyOwnersOfClientUpload,
  resolveUploadLinkOwner,
} from "@/server/uploadLink";

/**
 * POST /api/upload-link/[token]/media — puts a file sent through a client
 * upload link into the workspace's Media library (2026-11-10), signed out.
 *
 * Nothing the client says about the file is trusted. The address must be on the
 * app's own store, in exactly the shape this link's upload route writes
 * (`ul/<link id>/<16 hex>-<name>`), and storage itself (`head`) must have the
 * file there; the row takes its size and type from storage. The workspace, the
 * row's owner and the link come from the token, never from the body. The answer
 * carries nothing about the workspace or the row.
 *
 * Order: the body is checked first (no counting for a refused body), then the
 * per-IP and per-link limits, then storage, then the write.
 */

type RouteContext = { params: Promise<{ token: string }> };

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

const NOT_THROUGH_LINK_MESSAGE = "This file was not sent through this link.";
const CHECK_FAILED_MESSAGE = "Could not check the file. Try again.";

function tooMany(error: string, retryAfterSeconds: number | undefined): NextResponse {
  return NextResponse.json(
    { error, retryAfterSeconds },
    { status: 429, headers: { "Retry-After": String(retryAfterSeconds ?? 60) } },
  );
}

function refuse(error: string, status = 400): NextResponse {
  return NextResponse.json({ error }, { status });
}

export async function POST(request: Request, context: RouteContext): Promise<NextResponse> {
  if (!(request.headers.get("content-type") ?? "").includes("application/json")) {
    return refuse("Content-Type must be application/json");
  }
  const body = await readJsonObject(request);
  if (!body) return invalidJsonBodyResponse();

  // Only these four fields are read; anything else in the body is ignored.
  const blobUrl = canonicalBlobUrl(typeof body.blobUrl === "string" ? body.blobUrl : "");
  if (!blobUrl) return refuse(BLOB_URL_REJECTED_MESSAGE);
  // A workspace's logo has no media row to protect it (lib/workspaceLogo.ts).
  const logoRefusal = logoAddressRefusal(body.blobUrl as string);
  if (logoRefusal) return refuse(logoRefusal);
  const urlLinkId = uploadLinkIdOfBlobUrl(blobUrl, ownBlobStoreId());
  if (!urlLinkId) return refuse(NOT_THROUGH_LINK_MESSAGE);
  const filename =
    (typeof body.filename === "string" ? body.filename.trim().slice(0, FILENAME_MAX_LENGTH) : "") ||
    "upload";
  const senderName = cleanSenderText(body.senderName, { singleLine: true });
  const note = cleanSenderText(body.note);

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
  if (!link) return refuse(UPLOAD_LINK_INACTIVE_MESSAGE, 404);
  // Another link's file (in this workspace or any other): refused before the link's day is spent.
  if (urlLinkId !== link.id) return refuse(NOT_THROUGH_LINK_MESSAGE);

  const dayLimit = await checkRateLimit({
    userId: `upload-link:${link.id}`,
    route: "upload-link/media-day",
    limit: UPLOAD_LINK_FILES_PER_DAY,
    windowMs: DAY_MS,
    failClosed: true,
  });
  if (!dayLimit.allowed) return tooMany(UPLOAD_LINK_DAILY_LIMIT_MESSAGE, dayLimit.retryAfterSeconds);

  let stored: HeadBlobResult;
  try {
    stored = await head(blobUrl);
  } catch (error) {
    if (error instanceof BlobNotFoundError) return refuse(NOT_THROUGH_LINK_MESSAGE);
    logger.error("[upload-link] Couldn't check a client file in storage", { error, linkId: link.id });
    return refuse(CHECK_FAILED_MESSAGE, 503);
  }
  if (!isUploadLinkPathname(stored.pathname, link.id)) return refuse(NOT_THROUGH_LINK_MESSAGE);
  if (!UPLOAD_ALLOWED_CONTENT_TYPES.includes(stored.contentType)) {
    return refuse(unsupportedTypeMessage(stored.contentType.slice(0, 100) || "unknown"));
  }
  if (!Number.isSafeInteger(stored.size) || stored.size <= 0 || stored.size > MAX_MEDIA_BYTES) {
    return refuse(stored.size > MAX_MEDIA_BYTES ? "File is too large (max 512 MB)." : "This file is empty.");
  }

  const ownerId = await resolveUploadLinkOwner(link);
  if (!ownerId) return refuse(UPLOAD_LINK_INACTIVE_MESSAGE, 404);

  const now = new Date();
  let written: boolean;
  try {
    written = await prisma.$transaction(async (tx) => {
      // Idempotent: one live row per file. Without this, one big upload
      // registered 200 times a day would fill the workspace's counted storage.
      // The lock is the one deleteBlobUnlessShared (server/jobs/mediaBlob.ts)
      // takes on this file's key, so two registrations at once cannot both
      // insert, and a delete of the same file waits its turn.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${guardBlobKey(blobUrl)}))`;
      const existing = await tx.mediaItem.findFirst({
        where: { workspaceId: link.workspaceId, storageLocation: blobUrl, deletedAt: null },
        select: { id: true },
      });
      if (existing) return false;

      await tx.mediaItem.create({
        data: {
          workspaceId: link.workspaceId,
          userId: ownerId,
          storageLocation: blobUrl,
          originalFilename: filename,
          mimeType: stored.contentType,
          sizeBytes: stored.size,
          baseCaption: "",
          metadata: {
            source: "upload_link",
            linkId: link.id,
            ...(senderName ? { senderName } : {}),
            ...(note ? { note } : {}),
          },
        },
      });
      await tx.workspaceUploadLink.update({
        where: { id: link.id },
        data: { lastUsedAt: now, uploadCount: { increment: 1 } },
      });
      return true;
    });
  } catch (error) {
    logger.error("[upload-link] Couldn't register a client file", { error, linkId: link.id });
    return refuse("Couldn't save the file. Try again.", 500);
  }

  // Already in the library: the same answer as the first time, and no email.
  if (!written) return NextResponse.json({ ok: true }, { status: 201 });

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
