import { NextResponse, type NextRequest } from "next/server";

import { getWorkspaceContext } from "@/lib/workspace";
import { prisma } from "@/lib/db";
import { checkRateLimit } from "@/lib/rateLimit";
import { MUTABLE_POST_JOB_STATUSES } from "@/lib/scheduling";

interface PostJobRouteContext {
  params: Promise<{ postJobId: string }> | { postJobId: string };
}

/**
 * Generous throttle for the queue mutation endpoints (cancel/edit/delete).
 * They're DB-only with no external cost — unlike posts/publish — so the limit is
 * high; it exists only so a runaway client can't hammer the DB, matching the
 * "every guarded route" convention (review Minor #2).
 */
const MUTATE_RATE_LIMIT = { route: "posts/mutate", limit: 60, windowMs: 5 * 60 * 1000 } as const;

/**
 * POST /api/posts/[postJobId]/cancel — Roadmap Phase 5 (§6.2).
 *
 * Cancel a scheduled or draft post. A plain DB update — there is no Inngest run
 * to tear down (the cron simply never claims a `cancelled` job), so cancel is
 * race-free. Auth + ownership scoped. Only `scheduled`/`draft` may be cancelled;
 * a job already `in_progress`/terminal returns 409.
 *
 * The guard is a single ATOMIC conditional `updateMany` (id + userId + status in
 * the cancelable set): if the cron claims the job (scheduled → in_progress) at
 * the same instant, exactly one of the two updates wins — the cancel then sees
 * count === 0 and 409s rather than cancelling a post that already went live.
 */
export async function POST(_request: NextRequest, context: PostJobRouteContext) {
  const workspaceContext = await getWorkspaceContext();

  if (!workspaceContext) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const rateLimit = await checkRateLimit({
    userId: workspaceContext.user.id,
    ...MUTATE_RATE_LIMIT,
  });
  if (!rateLimit.allowed) {
    return NextResponse.json(
      { error: "Too many requests. Please slow down.", retryAfterSeconds: rateLimit.retryAfterSeconds },
      { status: 429, headers: { "Retry-After": String(rateLimit.retryAfterSeconds ?? 1) } },
    );
  }

  const { postJobId } = await Promise.resolve(context.params);

  // Team Workspaces (Task 4): any member of the job's workspace, not just its
  // creator (design §1 — cancel is unrestricted by role).
  const { count } = await prisma.postJob.updateMany({
    where: {
      id: postJobId,
      workspaceId: workspaceContext.workspace.id,
      status: { in: [...MUTABLE_POST_JOB_STATUSES] },
    },
    data: { status: "cancelled" },
  });

  if (count === 0) {
    // Disambiguate not-found/not-in-workspace (404) from wrong-state (409).
    const existing = await prisma.postJob.findFirst({
      where: { id: postJobId, workspaceId: workspaceContext.workspace.id },
      select: { id: true },
    });
    if (!existing) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    return NextResponse.json(
      {
        error: "Only scheduled or draft posts can be cancelled.",
        code: "NOT_CANCELABLE",
      },
      { status: 409 },
    );
  }

  return NextResponse.json({ ok: true, status: "cancelled" }, { status: 200 });
}
