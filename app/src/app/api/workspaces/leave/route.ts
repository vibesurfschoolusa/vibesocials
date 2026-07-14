import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import { prisma } from "@/lib/db";
import { checkRateLimit } from "@/lib/rateLimit";
import { ACTIVE_WORKSPACE_COOKIE, getWorkspaceContext } from "@/lib/workspace";

/**
 * POST /api/workspaces/leave
 *
 * Deletes the CALLER's own membership row in their ACTIVE workspace; there is
 * no target id in the request body, unlike DELETE
 * /api/workspaces/members/[userId] which removes someone else. On success,
 * clears the active-workspace cookie (same options `switch` sets it with,
 * value "" + maxAge 0) so the NEXT request re-resolves via
 * `getWorkspaceContext`'s fallback (personal/oldest-owned workspace) rather
 * than pointing at a workspace the caller no longer belongs to.
 *
 * MEMBER fast path (design §1 permission matrix, Task 8): a plain
 * role-guarded `deleteMany` (`role: "member"`) — the guard in the where clause
 * means a concurrent promotion between the context read and the delete matches
 * zero rows and 404s instead of removing a freshly-promoted owner.
 *
 * OWNER path (Task D1, multi-owner): a sole owner still has no self-service
 * exit (they'd orphan the workspace -> 400, "Transfer ownership before
 * removing yourself."), but a CO-owner may now leave. That branch serializes
 * on the shared `ws-owners:<workspaceId>` advisory lock — the SAME key PATCH's
 * demote path takes, so a concurrent demote and owner-leave on one workspace
 * cannot race it to zero owners — re-reads the OTHER-owner count INSIDE the
 * lock, then deletes the caller's own row by id.
 */
export async function POST() {
  const context = await getWorkspaceContext();

  if (!context) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Post-release review (Task D): this mutation was unguarded — per-user
  // throttle, same shared 429 envelope as posts/[postJobId]'s
  // enforceMutateRateLimit (body + Retry-After header). Placed before the
  // owner-role check below: the throttle is on the endpoint, not the outcome.
  const rateLimit = await checkRateLimit({
    userId: context.user.id,
    route: "workspaces/leave",
    limit: 60,
    windowMs: 5 * 60 * 1000,
  });
  if (!rateLimit.allowed) {
    return NextResponse.json(
      { error: "Too many requests. Please slow down.", retryAfterSeconds: rateLimit.retryAfterSeconds },
      { status: 429, headers: { "Retry-After": String(rateLimit.retryAfterSeconds ?? 1) } },
    );
  }

  if (context.role === "owner") {
    // Serialize on the shared ws-owners lock (SAME key as PATCH's demote path)
    // and re-read the OTHER-owner count INSIDE it: a co-owner may leave, a sole
    // owner may not. The caller's own row is then deleted BY ID — the fast
    // path's `role: "member"` guarded deleteMany would never match an owner row.
    return prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`ws-owners:${context.workspace.id}`}))`;

      const otherOwnerCount = await tx.workspaceMember.count({
        where: {
          workspaceId: context.workspace.id,
          role: "owner",
          userId: { not: context.user.id },
        },
      });
      if (otherOwnerCount === 0) {
        return NextResponse.json(
          { error: "Transfer ownership before removing yourself." },
          { status: 400 },
        );
      }

      const own = await tx.workspaceMember.findFirst({
        where: { workspaceId: context.workspace.id, userId: context.user.id },
        select: { id: true },
      });
      if (!own) {
        return NextResponse.json({ error: "Not found" }, { status: 404 });
      }
      await tx.workspaceMember.delete({ where: { id: own.id } });

      const cookieStore = await cookies();
      cookieStore.set(ACTIVE_WORKSPACE_COOKIE, "", {
        httpOnly: true,
        sameSite: "lax",
        secure: process.env.NODE_ENV === "production",
        path: "/",
        maxAge: 0,
      });

      return NextResponse.json({ left: true }, { status: 200 });
    });
  }

  const { count } = await prisma.workspaceMember.deleteMany({
    where: { workspaceId: context.workspace.id, userId: context.user.id, role: "member" },
  });

  if (count === 0) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const cookieStore = await cookies();
  cookieStore.set(ACTIVE_WORKSPACE_COOKIE, "", {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 0,
  });

  return NextResponse.json({ left: true }, { status: 200 });
}
