import { NextResponse } from "next/server";

import { getWorkspaceContext } from "@/lib/workspace";
import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import { readPostingSlots } from "@/lib/postingSlots";

/** As far ahead as "Next free slot" looks for posts already there. */
const LOOKAHEAD_MS = 90 * 24 * 60 * 60 * 1000;
const MAX_TIMES = 500;

/**
 * GET /api/posts/scheduled-times — Posting times (brief 11).
 *
 * The times the active workspace's posts already hold, for the browser's
 * nextFreeSlots (lib/postingSlots.ts): scheduled posts, and drafts that keep a
 * time (held for approval, or sent back by a client), from now to 90 days
 * ahead, at most 500. A plain draft has no time, so the range leaves it out.
 * Times only: no ids, no captions. Beside them, the workspace's saved posting
 * times, so the Create and add-many pages get what "Next free slot" needs in
 * one request. Read-only, like GET /api/posts, so it carries no rate limit.
 */
export async function GET() {
  const context = await getWorkspaceContext();

  if (!context) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const now = new Date();
  try {
    const [rows, workspace] = await Promise.all([
      prisma.postJob.findMany({
        where: {
          workspaceId: context.workspace.id,
          status: { in: ["scheduled", "draft"] },
          scheduledFor: { gte: now, lte: new Date(now.getTime() + LOOKAHEAD_MS) },
        },
        orderBy: { scheduledFor: "asc" },
        take: MAX_TIMES,
        select: { scheduledFor: true },
      }),
      prisma.workspace.findUnique({
        where: { id: context.workspace.id },
        select: { postingSlots: true },
      }),
    ]);
    return NextResponse.json({
      times: rows.flatMap((row) => (row.scheduledFor ? [row.scheduledFor.toISOString()] : [])),
      slots: readPostingSlots(workspace?.postingSlots),
    });
  } catch (error: unknown) {
    logger.error("[GET /api/posts/scheduled-times] Unexpected error", {
      error,
      workspaceId: context.workspace.id,
    });
    return NextResponse.json(
      { error: "Couldn't load the scheduled times. Reload the page and try again." },
      { status: 500 },
    );
  }
}
