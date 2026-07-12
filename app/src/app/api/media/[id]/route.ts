import { NextRequest, NextResponse } from "next/server";
import { del } from "@vercel/blob";

import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import { toMediaItemDto } from "@/lib/mediaDto";
import { getWorkspaceContext } from "@/lib/workspace";
import { TERMINAL_POST_JOB_STATUSES } from "@/server/jobs/mediaRetention";

interface MediaItemRouteContext {
  params: Promise<{ id: string }> | { id: string };
}

/**
 * Pure 409 predicate for `DELETE /api/media/[id]` (Roadmap Phase 2): a media
 * item may be deleted only while NO non-terminal PostJob still references it
 * (an active/scheduled post may still need the blob). Takes just the count so
 * it's unit-testable without a database — mirrors `isMediaSweepEligible` in
 * `mediaRetention.ts`.
 */
export function isMediaDeletable(nonTerminalJobCount: number): boolean {
  return nonTerminalJobCount === 0;
}

/**
 * GET /api/media/[id]
 *
 * Auth + workspace scoped single-item lookup, used by the post composer's
 * "reuse this media" flow (Roadmap Phase 2) to prefill caption/overrides and
 * render a preview without re-fetching the entire library. Team Workspaces
 * (Task 4): any member of the workspace may look up (and reuse) any item in
 * its shared library, not just their own uploads (design §1). Returns the
 * same display-only DTO as `GET /api/media` (see `src/lib/mediaDto.ts`) —
 * never `userId` or internal lifecycle columns.
 */
export async function GET(_request: NextRequest, context: MediaItemRouteContext) {
  const workspaceContext = await getWorkspaceContext();

  if (!workspaceContext) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await Promise.resolve(context.params);

  const item = await prisma.mediaItem.findFirst({
    where: { id, workspaceId: workspaceContext.workspace.id, deletedAt: null },
    select: {
      id: true,
      storageLocation: true,
      originalFilename: true,
      mimeType: true,
      sizeBytes: true,
      baseCaption: true,
      perPlatformOverrides: true,
      createdAt: true,
    },
  });

  if (!item) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  return NextResponse.json({ item: toMediaItemDto(item) }, { status: 200 });
}

/**
 * DELETE /api/media/[id]
 *
 * Auth + workspace scoped soft-delete (Roadmap Phase 2). 404 if the item
 * doesn't exist, isn't in the caller's active workspace, or was already
 * deleted (never 403 here — no existence oracle for a foreign workspace's
 * item). Team Workspaces (Task 4, design §1 permission matrix): any member
 * may delete their OWN upload; deleting someone ELSE's requires the
 * workspace owner role — 403 otherwise. 409 if it's still referenced by a
 * non-terminal PostJob (`isMediaDeletable`). On success, removes the blob and
 * stamps `deletedAt` — the row itself is kept (history/captions depend on
 * it), matching the Phase 1 retention sweep's soft-delete semantics.
 *
 * The row update and the blob `del()` run inside one `$transaction`, marking
 * the row first: if `del()` throws, the whole transaction (including the
 * row update) rolls back, so a failed blob delete can never be recorded as a
 * successful one — same reasoning as `mediaRetentionSweep` in
 * `inngest-functions.ts`. The transaction takes a `SELECT ... FOR UPDATE` row
 * lock on the MediaItem before counting referencing jobs, so it serializes with
 * a concurrent reuse (which takes the same lock) — closing the check-then-act
 * race exactly as the retention sweep does.
 */
export async function DELETE(_request: NextRequest, context: MediaItemRouteContext) {
  const workspaceContext = await getWorkspaceContext();

  if (!workspaceContext) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await Promise.resolve(context.params);

  // `userId` (the uploader) is selected here — not for the workspace scope
  // itself, but so the permission check below can compare it against the
  // caller without a second query.
  const item = await prisma.mediaItem.findFirst({
    where: { id, workspaceId: workspaceContext.workspace.id, deletedAt: null },
    select: { id: true, userId: true, storageLocation: true },
  });

  if (!item) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // Team Workspaces (Task 4, design §1): the uploader or the workspace owner
  // — anyone else gets a 403, not a 404 (the item's existence is already
  // established for this workspace by the query above, so there's no
  // existence oracle to protect here).
  const isUploader = item.userId === workspaceContext.user.id;
  const isOwner = workspaceContext.role === "owner";
  if (!isUploader && !isOwner) {
    return NextResponse.json(
      { error: "Only the uploader or the workspace owner can delete this." },
      { status: 403 },
    );
  }

  try {
    const outcome = await prisma.$transaction(async (tx) => {
      // Lock the MediaItem row FIRST (same FOR UPDATE lock the reuse helper and
      // retention sweep take) so the count below sees any reuse that committed
      // before the lock was granted, and a reuse arriving after this delete
      // blocks then aborts — closing the check-then-act race with a reuse.
      await tx.$executeRaw`SELECT id FROM "MediaItem" WHERE id = ${id} FOR UPDATE`;

      const nonTerminalJobCount = await tx.postJob.count({
        where: { mediaItemId: id, status: { notIn: [...TERMINAL_POST_JOB_STATUSES] } },
      });

      if (!isMediaDeletable(nonTerminalJobCount)) {
        return { ok: false as const };
      }

      // Mark the row first, then remove the blob: if `del` throws, the whole
      // transaction rolls back, so we never record a delete we didn't
      // actually perform (`del` is idempotent for an already-missing blob,
      // so a retried DELETE after a transient failure is safe).
      await tx.mediaItem.update({
        where: { id },
        data: { deletedAt: new Date() },
      });
      await del(item.storageLocation);

      return { ok: true as const };
    }, { timeout: 15000 });

    if (!outcome.ok) {
      return NextResponse.json(
        {
          error: "This media is still referenced by an active post and can't be deleted yet.",
          code: "MEDIA_IN_USE",
        },
        { status: 409 },
      );
    }
  } catch (error) {
    logger.error("[DELETE /api/media/[id]] Unexpected error", {
      id,
      error,
      userId: workspaceContext.user.id,
      workspaceId: workspaceContext.workspace.id,
    });
    return NextResponse.json({ error: "Failed to delete media" }, { status: 500 });
  }

  return NextResponse.json({ ok: true }, { status: 200 });
}
