import { NextResponse, type NextRequest } from "next/server";

import { getCurrentUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { MUTABLE_POST_JOB_STATUSES } from "@/lib/scheduling";

interface PostJobRouteContext {
  params: Promise<{ postJobId: string }> | { postJobId: string };
}

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
  const user = await getCurrentUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { postJobId } = await Promise.resolve(context.params);

  const { count } = await prisma.postJob.updateMany({
    where: {
      id: postJobId,
      userId: user.id,
      status: { in: [...MUTABLE_POST_JOB_STATUSES] },
    },
    data: { status: "cancelled" },
  });

  if (count === 0) {
    // Disambiguate not-found/not-owned (404) from wrong-state (409).
    const existing = await prisma.postJob.findFirst({
      where: { id: postJobId, userId: user.id },
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
