import type { PrismaClient, User, Workspace, WorkspaceRole } from "@prisma/client";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";

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
  user: Pick<User, "id" | "name" | "email">,
): Promise<{ workspaceId: string }> {
  const workspace = await tx.workspace.create({
    data: {
      name: personalWorkspaceName(user),
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
 * Resolves `userId`'s personal (oldest-owned) workspace id, lazily
 * provisioning one if the user somehow has none yet — the same
 * advisory-locked core {@link getWorkspaceContext}'s self-heal uses (see
 * {@link ensurePersonalWorkspace}).
 *
 * HISTORY: introduced as an interim bridge so pre-workspaces call sites
 * (OAuth callbacks, posts/media routes) could compile against the
 * workspace-scoped schema before each was migrated to resolve a real request
 * context. Every such call site carried a marker comment pointing back here;
 * Task 6 removed the last of them (the 7 OAuth callbacks — they now resolve
 * `workspaceId` from the signed OAuth state instead), so this function has no
 * production callers as of Task 6.
 *
 * Kept (not deleted) as a documented utility: still the right tool wherever
 * only a userId — not a request context — is available, e.g. a future
 * background job or one-off script that needs "this user's personal
 * workspace" without a cookie/session to resolve an ACTIVE workspace from.
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

/**
 * Shared route-layer owner gate (review fix round 1, Minor 1 — hoisted from
 * 4 byte-identical per-route copies). Resolves the caller's owner-role
 * workspace context, or an error response for the route to return as-is:
 * 401 `{ error: "Unauthorized" }` when unauthenticated, 403 `{ error: "Only
 * the workspace owner can do that." }` when {@link getWorkspaceContext}
 * throws {@link WorkspaceForbiddenError}. Anything else rethrows (routes
 * surface it through their own 500 handling). Usage:
 *
 *   const contextOrError = await requireOwnerContext();
 *   if (contextOrError instanceof NextResponse) return contextOrError;
 */
export async function requireOwnerContext(): Promise<WorkspaceContext | NextResponse> {
  try {
    const context = await getWorkspaceContext({ requireRole: "owner" });
    if (!context) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    return context;
  } catch (error) {
    if (error instanceof WorkspaceForbiddenError) {
      return NextResponse.json({ error: error.message }, { status: 403 });
    }
    throw error;
  }
}

/**
 * Owner gate for the 7 OAuth `/api/auth/<platform>/start` routes (Task 6,
 * design §5). These are browser redirect handlers, not JSON APIs, so the
 * failure modes differ from {@link requireOwnerContext}:
 *
 *   - Unauthenticated: returns `null` so the CALLER keeps its own
 *     pre-existing `/login` redirect — every start route already had its own
 *     (slightly different) unauthenticated behavior before workspaces, and
 *     this preserves it unchanged rather than centralizing a new one.
 *   - Authenticated but not owner: new territory these routes never had to
 *     handle pre-workspaces, so it uniformly redirects to
 *     `/settings?error=<errorCode>` (the OAuth-callback error-redirect
 *     convention every route already follows for its OTHER failure
 *     branches).
 *   - Owner: returns the {@link WorkspaceContext} so the route can embed
 *     `workspace.id` in the OAuth state.
 *
 * Usage:
 *   const contextOrRedirect = await requireOwnerContextForOAuthStart(request, "facebook_page_not_workspace_owner");
 *   if (contextOrRedirect instanceof NextResponse) return contextOrRedirect;
 *   if (!contextOrRedirect) return <route's existing unauthenticated redirect>;
 */
export async function requireOwnerContextForOAuthStart(
  request: Request,
  errorCode: string,
): Promise<WorkspaceContext | NextResponse | null> {
  try {
    return await getWorkspaceContext({ requireRole: "owner" });
  } catch (error) {
    if (error instanceof WorkspaceForbiddenError) {
      const url = new URL("/settings", request.url);
      url.searchParams.set("error", errorCode);
      return NextResponse.redirect(url);
    }
    throw error;
  }
}

/**
 * OAuth callback re-check (Task 6, design §5): after `verifyOAuthState`
 * resolves `{ userId, workspaceId }`, every callback re-verifies the caller
 * is STILL an owner of that workspace before writing a connection —
 * ownership could have changed (e.g. the owner removed themselves, or was
 * demoted by another owner in a future multi-owner world) between the
 * redirect to the provider and the return trip. Unlike
 * {@link getWorkspaceContext}, this checks a SPECIFIC (userId, workspaceId)
 * pair carried by the verified state, not the caller's current
 * active-workspace cookie.
 */
export async function isWorkspaceOwner(userId: string, workspaceId: string): Promise<boolean> {
  const membership = await prisma.workspaceMember.findFirst({
    where: { workspaceId, userId, role: "owner" },
  });
  return membership !== null;
}
