import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import { prisma } from "@/lib/db";
import { checkRateLimit } from "@/lib/rateLimit";
import { ACTIVE_WORKSPACE_COOKIE, getWorkspaceContext } from "@/lib/workspace";

/**
 * POST /api/workspaces/leave
 *
 * Plan amendment (Task 8 — design doc §1 permission matrix: "Leave
 * workspace" is member-only; a sole owner has no self-service path out since
 * ownership transfer is out of scope — design §10). Deletes the CALLER's own
 * membership row in their ACTIVE workspace; there is no target id in the
 * request body, unlike DELETE /api/workspaces/members/[userId] which removes
 * someone else.
 *
 * The role guard is checked twice, same defense-in-depth shape as that
 * route: once up front (owner -> 400, no delete attempted at all) and again
 * INSIDE the delete's where clause (`role: "member"`) so a concurrent
 * promotion between the context read and the delete can't slip an owner's
 * membership through this path — the delete would then match zero rows and
 * 404 instead of removing it.
 *
 * On success, clears the active-workspace cookie (same options `switch`
 * sets it with, value "" + maxAge 0) so the NEXT request re-resolves via
 * `getWorkspaceContext`'s fallback (personal/oldest-owned workspace) rather
 * than pointing at a workspace the caller no longer belongs to.
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
    return NextResponse.json(
      { error: "Transfer ownership before removing yourself." },
      { status: 400 },
    );
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
