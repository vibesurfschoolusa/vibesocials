import { NextResponse } from "next/server";

import { BLOB_URL_REJECTED_MESSAGE, isAllowedBlobUrl } from "@/lib/blobUrl";
import { prisma } from "@/lib/db";
import { invalidJsonBodyResponse, readJsonObject } from "@/lib/http";
import { toMediaItemDto } from "@/lib/mediaDto";
import { MAX_MEDIA_BYTES, isImageOrVideoMimeType } from "@/lib/mediaInput";
import { getWorkspaceContext } from "@/lib/workspace";

export async function GET(_request: Request) {
  const context = await getWorkspaceContext();

  if (!context) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Library view: shared by every member of the workspace (design §1 — "use
  // library" isn't restricted to own uploads), excluding soft-deleted media
  // (blob removed / user-deleted). Projects a display-only DTO (drops userId
  // + internal columns; keeps storageLocation for thumbnails). See
  // src/lib/mediaDto.ts.
  const items = await prisma.mediaItem.findMany({
    where: { workspaceId: context.workspace.id, deletedAt: null },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      storageLocation: true,
      originalFilename: true,
      mimeType: true,
      sizeBytes: true,
      baseCaption: true,
      perPlatformOverrides: true,
      createdAt: true,
      lastUsedAt: true,
    },
  });

  return NextResponse.json({ items: items.map(toMediaItemDto) }, { status: 200 });
}

export async function POST(request: Request) {
  const context = await getWorkspaceContext();

  if (!context) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const contentType = request.headers.get("content-type") || "";
  if (!contentType.includes("application/json")) {
    return NextResponse.json(
      { error: "Content-Type must be application/json" },
      { status: 400 },
    );
  }

  const body = await readJsonObject(request);
  if (!body) {
    return invalidJsonBodyResponse();
  }

  const blobUrl = typeof body.blobUrl === "string" ? body.blobUrl.trim() : "";
  if (!blobUrl) {
    return NextResponse.json({ error: "blobUrl is required" }, { status: 400 });
  }
  if (!isAllowedBlobUrl(blobUrl)) {
    return NextResponse.json({ error: BLOB_URL_REJECTED_MESSAGE }, { status: 400 });
  }
  // The image/video rule is shared with POST /api/posts (lib/mediaInput.ts).
  if (!isImageOrVideoMimeType(body.mimeType)) {
    return NextResponse.json(
      { error: "Only image or video files can be added to the library." },
      { status: 400 },
    );
  }
  const mimeType = body.mimeType;
  const sizeBytes = typeof body.sizeBytes === "number" && Number.isFinite(body.sizeBytes)
    ? body.sizeBytes
    : 0;
  if (sizeBytes <= 0 || sizeBytes > MAX_MEDIA_BYTES) {
    return NextResponse.json(
      { error: "File is too large (max 512 MB)." },
      { status: 400 },
    );
  }
  const filename = typeof body.filename === "string" && body.filename.trim()
    ? body.filename.trim()
    : "upload";
  const baseCaption = typeof body.baseCaption === "string" ? body.baseCaption.trim() : "";

  // Team Workspaces (Task 4): stamps the caller's ACTIVE workspace directly
  // (replaces the Task 2 `resolveWorkspaceForUser` bridge, which always
  // resolved the caller's PERSONAL workspace).
  const mediaItem = await prisma.mediaItem.create({
    data: {
      userId: context.user.id,
      workspaceId: context.workspace.id,
      storageLocation: blobUrl,
      originalFilename: filename,
      mimeType,
      sizeBytes,
      baseCaption,
    },
  });
  // SEC-1 (post-release review Task C): echo the display DTO, not the raw
  // row — the raw MediaItem carries userId/workspaceId/metadata/deletedAt,
  // none of which the client needs (media-library already types this
  // response as MediaItemDto).
  return NextResponse.json({ mediaItem: toMediaItemDto(mediaItem) }, { status: 201 });
}
