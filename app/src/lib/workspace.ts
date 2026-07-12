import type { PrismaClient, User, Workspace, WorkspaceRole } from "@prisma/client";
import { cookies } from "next/headers";

import { getCurrentUser } from "./auth";
import { prisma } from "./db";

/**
 * httpOnly cookie holding the active workspace id (design doc §1). Written by
 * `POST /api/workspaces/switch` (Task 3+) — read-only here.
 */
export const ACTIVE_WORKSPACE_COOKIE = "vs_active_workspace";

export interface WorkspaceContext {
  user: User;
  workspace: Pick<Workspace, "id" | "name" | "companyWebsite" | "defaultHashtags">;
  role: WorkspaceRole;
  /** Total members in the active workspace — gates attribution display (design §7). */
  memberCount: number;
}

/**
 * Minimal Prisma surface `provisionPersonalWorkspace` needs: just the two
 * `create` calls it makes, not the full `WorkspaceDelegate`/
 * `WorkspaceMemberDelegate` interfaces (`Pick<PrismaClient, "workspace" |
 * "workspaceMember">` would pull in every method — findUnique, findMany,
 * etc.). Pragmatic choice (Task 2 brief): narrower is easier to satisfy for
 * both real callers (the top-level `prisma` singleton and a
 * `$transaction(async (tx) => ...)` callback's `tx` both structurally
 * qualify) AND this repo's test convention of mocking a `tx` as a plain
 * object exposing only the methods actually invoked (mirrors
 * posting.test.ts's `$transaction` mock).
 */
export type PrismaClientLike = {
  workspace: { create: PrismaClient["workspace"]["create"] };
  workspaceMember: { create: PrismaClient["workspaceMember"]["create"] };
};

/**
 * Thrown by {@link getWorkspaceContext} when `opts.requireRole` isn't met.
 * API routes catch this and map it to `403 { error: "Only the workspace
 * owner can do that." }` (design §3).
 */
export class WorkspaceForbiddenError extends Error {
  constructor(message = "Only the workspace owner can do that.") {
    super(message);
    this.name = "WorkspaceForbiddenError";
  }
}

/**
 * PURE resolver for "which membership is active" (design §1):
 *   1. the `vs_active_workspace` cookie value, if it matches a membership
 *   2. else the oldest OWNED membership (earliest `createdAt`)
 *   3. else the oldest membership of any role
 *   4. no memberships at all -> `null`
 *
 * Takes plain data (no DB/cookie access) so it's table-driven-testable in
 * isolation; {@link getWorkspaceContext} supplies both from request state.
 */
export function resolveActiveMembershipId(
  memberships: Array<{ workspaceId: string; role: WorkspaceRole; createdAt: Date }>,
  cookieValue: string | undefined,
): string | null {
  if (memberships.length === 0) {
    return null;
  }

  if (cookieValue) {
    const matched = memberships.find((membership) => membership.workspaceId === cookieValue);
    if (matched) {
      return matched.workspaceId;
    }
  }

  const owned = memberships.filter((membership) => membership.role === "owner");
  const pool = owned.length > 0 ? owned : memberships;

  return pool.reduce((oldest, current) =>
    current.createdAt < oldest.createdAt ? current : oldest,
  ).workspaceId;
}

/**
 * Name rule mirrors the backfill migration exactly — see
 * prisma/migrations/20260712000000_team_workspaces/migration.sql:
 * `COALESCE(NULLIF(name, ''), split_part(email, '@', 1)) || '''s workspace'`.
 */
function personalWorkspaceName(user: Pick<User, "name" | "email">): string {
  const base = user.name && user.name !== "" ? user.name : user.email.split("@")[0];
  return `${base}'s workspace`;
}

/**
 * Creates a personal workspace + owner membership for `user` (design §2).
 * Callers supply the Prisma client — pass a `$transaction` callback's `tx` so
 * both writes commit atomically with whatever else the caller is doing (the
 * register route's User row, or {@link getWorkspaceContext}'s self-heal).
 */
export async function provisionPersonalWorkspace(
  tx: PrismaClientLike,
  user: Pick<User, "id" | "name" | "email" | "companyWebsite" | "defaultHashtags">,
): Promise<{ workspaceId: string }> {
  const workspace = await tx.workspace.create({
    data: {
      name: personalWorkspaceName(user),
      companyWebsite: user.companyWebsite,
      defaultHashtags: user.defaultHashtags,
    },
  });

  await tx.workspaceMember.create({
    data: {
      workspaceId: workspace.id,
      userId: user.id,
      role: "owner",
    },
  });

  return { workspaceId: workspace.id };
}

/**
 * Shared provisioning core behind {@link resolveWorkspaceForUser} and
 * {@link getWorkspaceContext}'s self-heal: returns the user's personal
 * (oldest-owned) workspace id, creating workspace + owner membership when
 * none exists.
 *
 * CONCURRENCY (review fix, Task 2 round 1 — TOCTOU): two concurrent
 * first-touch requests for a zero-membership user (parallel API calls on one
 * page load) would otherwise BOTH pass the "no membership" check and
 * provision twice; the oldest-owned tie-break would then permanently strand
 * whatever the losing request wrote into its workspace. The provisioning
 * transaction therefore takes a Postgres TRANSACTION-SCOPED advisory lock
 * keyed per user (`pg_advisory_xact_lock` — auto-released at commit/rollback,
 * so no unlock bookkeeping and no leak on error) and RE-CHECKS membership
 * INSIDE the lock: the race loser blocks on the lock until the winner
 * commits, then sees the winner's membership and adopts it instead of
 * provisioning a second workspace.
 */
async function ensurePersonalWorkspace(userId: string): Promise<string> {
  // Fast path — no transaction, no lock: after a user's very first touch,
  // every call finds the existing owned membership here.
  const owned = await prisma.workspaceMember.findFirst({
    where: { userId, role: "owner" },
    orderBy: { createdAt: "asc" },
  });

  if (owned) {
    return owned.workspaceId;
  }

  return prisma.$transaction(async (tx) => {
    // Serialize provisioning per user. hashtext() folds the string key into
    // the advisory-lock integer space; xact-scoped, so the lock releases when
    // this transaction ends (commit OR rollback).
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`ws-provision:${userId}`}))`;

    // Re-check INSIDE the lock: a concurrent request may have provisioned
    // while we waited on the lock. If so, adopt the winner's workspace.
    const existing = await tx.workspaceMember.findFirst({
      where: { userId, role: "owner" },
      orderBy: { createdAt: "asc" },
    });
    if (existing) {
      return existing.workspaceId;
    }

    const user = await tx.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw new Error(`ensurePersonalWorkspace: no such user "${userId}"`);
    }

    const { workspaceId } = await provisionPersonalWorkspace(tx, user);
    return workspaceId;
  });
}

/**
 * PLAN AMENDMENT (green-build bridge): resolves `userId`'s personal
 * (oldest-owned) workspace id, lazily provisioning one if the user somehow
 * has none yet — the same advisory-locked core {@link getWorkspaceContext}'s
 * self-heal uses (see {@link ensurePersonalWorkspace}). Every pre-existing
 * call site this unblocks is marked `// WORKSPACE-BRIDGE: personal-workspace
 * interim — replaced by getWorkspaceContext/job.workspaceId in Tasks 4-6.`.
 * This function itself is NOT temporary: later tasks keep using it wherever
 * only a userId (not a request context) is available, e.g. background jobs.
 */
export async function resolveWorkspaceForUser(userId: string): Promise<string> {
  return ensurePersonalWorkspace(userId);
}

/**
 * Resolves the caller's active workspace context (design §3): session user
 * -> memberships -> active membership (cookie hint, else personal). Returns
 * `null` when unauthenticated. Self-heals a zero-membership user by lazily
 * provisioning a personal workspace (design §2 — covers accounts created
 * between deploy and the backfill migration, since registration is open).
 *
 * @throws {WorkspaceForbiddenError} when `opts.requireRole === "owner"` and
 * the caller's role in the active workspace isn't `"owner"`.
 */
export async function getWorkspaceContext(
  opts?: { requireRole?: "owner" },
): Promise<WorkspaceContext | null> {
  const user = await getCurrentUser();
  if (!user) {
    return null;
  }

  let memberships = await prisma.workspaceMember.findMany({
    where: { userId: user.id },
    include: { workspace: true },
  });

  if (memberships.length === 0) {
    // Self-heal via the shared advisory-locked core (review fix round 1) —
    // safe against a concurrent first-touch request provisioning in parallel:
    // the loser adopts the winner's workspace instead of creating a second.
    await ensurePersonalWorkspace(user.id);
    memberships = await prisma.workspaceMember.findMany({
      where: { userId: user.id },
      include: { workspace: true },
    });
  }

  const cookieStore = await cookies();
  const cookieValue = cookieStore.get(ACTIVE_WORKSPACE_COOKIE)?.value;
  const activeWorkspaceId = resolveActiveMembershipId(memberships, cookieValue);
  const active = memberships.find((membership) => membership.workspaceId === activeWorkspaceId);

  if (!active) {
    return null;
  }

  if (opts?.requireRole === "owner" && active.role !== "owner") {
    throw new WorkspaceForbiddenError();
  }

  const memberCount = await prisma.workspaceMember.count({
    where: { workspaceId: active.workspaceId },
  });

  return {
    user,
    workspace: {
      id: active.workspace.id,
      name: active.workspace.name,
      companyWebsite: active.workspace.companyWebsite,
      defaultHashtags: active.workspace.defaultHashtags,
    },
    role: active.role,
    memberCount,
  };
}
