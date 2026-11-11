import { NextResponse } from "next/server";

import { BLOB_URL_REJECTED_MESSAGE, canonicalBlobUrl } from "@/lib/blobUrl";
import { prisma } from "@/lib/db";
import { findOverlongCaption } from "@/lib/captionLimits";
import { captionTooLongResponse, invalidJsonBodyResponse, readJsonObject } from "@/lib/http";
import { toMediaItemDto } from "@/lib/mediaDto";
import { MAX_MEDIA_BYTES, isImageOrVideoMimeType } from "@/lib/mediaInput";
import { decodePostsCursor, encodePostsCursor } from "@/lib/postsDto";
import { getWorkspaceContext } from "@/lib/workspace";
import { workspaceBlockResponse } from "@/lib/workspaceStatus";
import {
  INVALID_WORKSPACE_ID_CODE,
  INVALID_WORKSPACE_ID_MESSAGE,
  WORKSPACE_CHANGED_CODE,
  WORKSPACE_CHANGED_MESSAGE,
} from "@/lib/workspaceChanged";
import type { Prisma } from "@prisma/client";

/**
 * Library page size: both the default and the maximum `?limit=`. 60 items at
 * ~330 B of DTO each is ~20 KB a page, far under Vercel's 4.5 MB response cap.
 * (Not exported: a Next route module may only export handlers + route config.)
 */
const MEDIA_PAGE_SIZE = 60;

export async function GET(request: Request) {
  const context = await getWorkspaceContext();

  if (!context) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(request.url);

  // 2026-11-01 scale audit (W11): this endpoint returned the WHOLE library
  // with no `take` — 16.7 MB at 50k items, over Vercel's 4.5 MB function
  // response cap, so the media page failed for large workspaces. It now pages
  // by keyset. Validate `limit` and `cursor` BEFORE any DB work so a bad value
  // is a clean 400 with zero queries.
  //
  // `limit`: absent -> the default; digits only otherwise (so "abc", "1.5",
  // "-5" and "" are all rejected); < 1 is rejected; > MEDIA_PAGE_SIZE is
  // clamped down, never an error.
  const limitParam = url.searchParams.get("limit");
  let limit = MEDIA_PAGE_SIZE;
  if (limitParam !== null) {
    const parsed = /^\d+$/.test(limitParam) ? Number(limitParam) : 0;
    if (parsed < 1) {
      return NextResponse.json(
        { error: "limit must be a positive integer", code: "INVALID_LIMIT" },
        { status: 400 },
      );
    }
    limit = Math.min(parsed, MEDIA_PAGE_SIZE);
  }

  // `cursor`: an opaque token from a previous page's `nextCursor`; absent or
  // empty means "first page". It is the same (createdAt, id) keyset token
  // GET /api/posts uses — see encode/decodePostsCursor in lib/postsDto.ts.
  const cursorParam = url.searchParams.get("cursor");
  let cursor: { createdAt: Date; id: string } | null = null;
  if (cursorParam) {
    cursor = decodePostsCursor(cursorParam);
    if (!cursor) {
      return NextResponse.json(
        { error: "Invalid cursor", code: "INVALID_CURSOR" },
        { status: 400 },
      );
    }
  }

  const where: Prisma.MediaItemWhereInput = {
    workspaceId: context.workspace.id,
    deletedAt: null,
  };
  // Keyset predicate for the (createdAt desc, id desc) total order: the page
  // AFTER the cursor (C, I) is every row strictly older in that order —
  // createdAt < C, or the same createdAt with a smaller id. Positional, not
  // row-based: it stays correct even if the cursor's own row was deleted (or
  // new items were uploaded) between pages. ANDed with the scope above.
  if (cursor) {
    where.OR = [
      { createdAt: { lt: cursor.createdAt } },
      { createdAt: cursor.createdAt, id: { lt: cursor.id } },
    ];
  }

  // Library view: shared by every member of the workspace (design §1 — "use
  // library" isn't restricted to own uploads), excluding soft-deleted media
  // (blob removed / user-deleted). Projects a display-only DTO (drops userId
  // + internal columns; keeps storageLocation for thumbnails). See
  // src/lib/mediaDto.ts. Served by @@index([workspaceId, deletedAt,
  // createdAt, id]) on MediaItem, so a page needs no sort.
  const rows = await prisma.mediaItem.findMany({
    where,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    // Over-fetch ONE row to learn whether an older page exists without a
    // COUNT: if the probe row came back there is more, and it is dropped.
    take: limit + 1,
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
      // Client upload link (2026-11-10): the DTO reads only the sender's name and note from it.
      metadata: true,
    },
  });

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];
  const nextCursor = hasMore && last ? encodePostsCursor(last.createdAt, last.id) : null;

  return NextResponse.json({ items: page.map(toMediaItemDto), nextCursor }, { status: 200 });
}

export async function POST(request: Request) {
  const context = await getWorkspaceContext();

  if (!context) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Pause (2026-11-10): a paused workspace cannot create or move work.
  const blocked = workspaceBlockResponse(context.workspace);
  if (blocked) return blocked;

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

  // 2026-11-02 scale audit (correctness): the active workspace is a cookie every
  // tab shares, so a switch in another tab re-points THIS tab's upload into the
  // new workspace's library. The media library sends the workspace id it was
  // rendered for; refuse on a mismatch, with the same contract as POST
  // /api/posts. Deliberately the FIRST check after the body is read: nothing
  // below may run for a request meant for another workspace. An absent field
  // keeps today's behaviour for API clients; JSON `null` is present, so it is
  // rejected like any other non-string.
  if (body.workspaceId !== undefined) {
    if (typeof body.workspaceId !== "string") {
      return NextResponse.json(
        { error: INVALID_WORKSPACE_ID_MESSAGE, code: INVALID_WORKSPACE_ID_CODE },
        { status: 400 },
      );
    }
    if (body.workspaceId !== context.workspace.id) {
      return NextResponse.json(
        { error: WORKSPACE_CHANGED_MESSAGE, code: WORKSPACE_CHANGED_CODE },
        { status: 409 },
      );
    }
  }

  const rawBlobUrl = typeof body.blobUrl === "string" ? body.blobUrl : "";
  if (!rawBlobUrl.trim()) {
    return NextResponse.json({ error: "blobUrl is required" }, { status: 400 });
  }
  // 2026-11-01 audit (M2): store ONE canonical spelling per file so the
  // shared-blob guard (deleteBlobUnlessShared) can't be bypassed by a variant
  // URL (`?x=1`, upper-case host, ...). `null` = not allowed or not canonical.
  // canonicalBlobUrl trims, so the raw value is passed as sent.
  const blobUrl = canonicalBlobUrl(rawBlobUrl);
  if (!blobUrl) {
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
  // 2026-11-01 scale audit (jobs, event size): the library caption is replayed into the
  // composer and from there into a publish event, so it is capped like a post's
  // caption - measured on the trimmed value, which is what is stored.
  const overlongCaption = findOverlongCaption({ baseCaption });
  if (overlongCaption) return captionTooLongResponse(overlongCaption);

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
