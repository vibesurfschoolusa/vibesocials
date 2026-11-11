import type { Prisma } from "@prisma/client";
import { put } from "@vercel/blob";
import { NextResponse } from "next/server";

import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import { checkRateLimit } from "@/lib/rateLimit";
import { requireOwnerContext, type WorkspaceContext } from "@/lib/workspace";
import {
  LOGO_CHANGES_PER_HOUR,
  LOGO_EMPTY_MESSAGE,
  LOGO_LIMIT_MESSAGE,
  LOGO_MAX_BYTES,
  LOGO_REMOVE_FAILED_MESSAGE,
  LOGO_SAVE_FAILED_MESSAGE,
  LOGO_TOO_LARGE_MESSAGE,
} from "@/lib/workspaceLogo";
import { BLOB_DELETE_TIMEOUT_MS } from "@/server/jobs/mediaBlob";
import { deleteBlobsWithTimeout } from "@/server/jobs/pendingBlobDeletion";
import { LogoRejectedError, logoBlobPath, normalizeLogo, readBodyAtMost } from "@/server/workspaceLogo";

/**
 * The workspace's report logo (18b), for its owners. POST takes the picture as
 * the raw request body; DELETE removes it. The logo is not a MediaItem, so it
 * never shows in Media, counts toward storage or meets the retention sweep.
 *
 * Order: the file is stored before the database write, and a replaced or
 * removed file is queued in PendingBlobDeletion in the same transaction that
 * changes Workspace.logoUrl, for the hourly drain to delete. So the old file
 * is never gone while the workspace still points at it, and a failed write
 * cleans up the file it just stored.
 */

async function gate(): Promise<WorkspaceContext | NextResponse> {
  const contextOrError = await requireOwnerContext();
  if (contextOrError instanceof NextResponse) return contextOrError;
  const limit = await checkRateLimit({
    userId: contextOrError.user.id,
    route: "workspaces/logo",
    limit: LOGO_CHANGES_PER_HOUR,
    windowMs: 60 * 60 * 1000,
    failClosed: true,
  });
  if (!limit.allowed) {
    return NextResponse.json(
      { error: LOGO_LIMIT_MESSAGE, retryAfterSeconds: limit.retryAfterSeconds },
      { status: 429, headers: { "Retry-After": String(limit.retryAfterSeconds ?? 60) } },
    );
  }
  return contextOrError;
}

/**
 * Locks the workspace row and points it at `logoUrl`, queueing the file it
 * pointed at before. The row lock makes two changes at once take turns, so
 * each queues the file the other saved and none is left behind. Throws when
 * the workspace is gone.
 */
async function swapLogo(tx: Prisma.TransactionClient, workspaceId: string, logoUrl: string | null) {
  const rows = await tx.$queryRaw<{ logoUrl: string | null }[]>`
    SELECT "logoUrl" FROM "Workspace" WHERE "id" = ${workspaceId} FOR UPDATE`;
  if (rows.length === 0) throw new Error("Workspace not found");
  const previous = rows[0].logoUrl;
  if (previous === logoUrl) return;
  if (previous) await tx.pendingBlobDeletion.create({ data: { url: previous } });
  await tx.workspace.update({ where: { id: workspaceId }, data: { logoUrl } });
}

/** A file stored for a write that then failed: deleted now, or queued for the drain. */
async function discardStoredFile(url: string, workspaceId: string) {
  try {
    await deleteBlobsWithTimeout(url, BLOB_DELETE_TIMEOUT_MS);
    return;
  } catch (error) {
    logger.warn("[logo] Couldn't delete the unsaved logo file; queueing it", { workspaceId, error });
  }
  try {
    await prisma.pendingBlobDeletion.create({ data: { url } });
  } catch (error) {
    logger.error("[logo] Couldn't queue the unsaved logo file; it is left in storage", { workspaceId, url, error });
  }
}

export async function POST(request: Request): Promise<NextResponse> {
  const contextOrError = await gate();
  if (contextOrError instanceof NextResponse) return contextOrError;
  const workspaceId = contextOrError.workspace.id;

  const body = await readBodyAtMost(request, LOGO_MAX_BYTES);
  if (!body.ok) {
    return body.reason === "too_large"
      ? NextResponse.json({ error: LOGO_TOO_LARGE_MESSAGE }, { status: 413 })
      : NextResponse.json({ error: LOGO_EMPTY_MESSAGE }, { status: 400 });
  }

  let png: Buffer;
  try {
    png = await normalizeLogo(body.bytes);
  } catch (error) {
    if (error instanceof LogoRejectedError) return NextResponse.json({ error: error.message }, { status: 400 });
    throw error;
  }

  let url: string;
  try {
    const blob = await put(logoBlobPath(workspaceId), png, {
      access: "public",
      contentType: "image/png",
      addRandomSuffix: false,
    });
    url = blob.url;
  } catch (error) {
    logger.error("[logo] Couldn't store the logo file", { workspaceId, error });
    return NextResponse.json({ error: LOGO_SAVE_FAILED_MESSAGE }, { status: 500 });
  }

  try {
    await prisma.$transaction((tx) => swapLogo(tx, workspaceId, url));
  } catch (error) {
    logger.error("[logo] Couldn't save the logo address", { workspaceId, error });
    await discardStoredFile(url, workspaceId);
    return NextResponse.json({ error: LOGO_SAVE_FAILED_MESSAGE }, { status: 500 });
  }
  return NextResponse.json({ logoUrl: url });
}

export async function DELETE(): Promise<NextResponse> {
  const contextOrError = await gate();
  if (contextOrError instanceof NextResponse) return contextOrError;
  const workspaceId = contextOrError.workspace.id;

  try {
    await prisma.$transaction((tx) => swapLogo(tx, workspaceId, null));
  } catch (error) {
    logger.error("[logo] Couldn't remove the logo", { workspaceId, error });
    return NextResponse.json({ error: LOGO_REMOVE_FAILED_MESSAGE }, { status: 500 });
  }
  return NextResponse.json({ logoUrl: null });
}
