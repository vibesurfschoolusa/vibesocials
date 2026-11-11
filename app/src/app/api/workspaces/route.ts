import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import { prisma } from "@/lib/db";
import { invalidJsonBodyResponse, readJsonObject } from "@/lib/http";
import { logger } from "@/lib/logger";
import { isOperatorUser } from "@/lib/operator";
import { checkRateLimit } from "@/lib/rateLimit";
import { ACTIVE_WORKSPACE_COOKIE, getWorkspaceContext } from "@/lib/workspace";
import {
  CREATE_WORKSPACE_WHILE_BLOCKED_MESSAGE,
  WORKSPACE_PAUSED_CODE,
  workspaceBlock,
} from "@/lib/workspaceStatus";

/** The longest workspace name accepted (it shows in the account menu). */
export const WORKSPACE_NAME_MAX_LENGTH = 60;

/**
 * How many workspaces one person may own: room for a client roster, and a
 * ceiling on what one account can create while sign-up is open.
 */
export const MAX_OWNED_WORKSPACES = 25;

/**
 * GET /api/workspaces
 *
 * Lists every workspace the caller belongs to, for the account-menu switcher
 * (design doc §4 / §7). `isActive` marks the membership matching the
 * resolved active workspace (cookie hint, else personal — see
 * `getWorkspaceContext`), so the client never has to duplicate that
 * resolution logic.
 */
export async function GET() {
  const context = await getWorkspaceContext();

  if (!context) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const memberships = await prisma.workspaceMember.findMany({
    where: { userId: context.user.id },
    include: { workspace: true },
    orderBy: { createdAt: "asc" },
  });

  // Decided from the user the context already holds: no second session read,
  // and a failure here only drops the link, never the switcher's list.
  let operator = false;
  try {
    operator = isOperatorUser(context.user);
  } catch (error) {
    logger.error("[workspaces] Operator check failed; answering without the link", { error });
  }

  return NextResponse.json({
    workspaces: memberships.map((membership) => ({
      id: membership.workspace.id,
      name: membership.workspace.name,
      role: membership.role,
      isActive: membership.workspace.id === context.workspace.id,
    })),
    // Only for the operator (2026-11-10): the account menu renders this link
    // from the data, so no code every customer downloads names the admin page.
    ...(operator ? { operatorLink: { href: "/admin", label: "Admin" } } : {}),
  });
}

/**
 * POST /api/workspaces { name }
 *
 * Creates a workspace (2026-11-08: one per client), makes the caller its
 * owner, and switches to it (the same active-workspace cookie as
 * POST /api/workspaces/switch). The workspace and the owner membership are
 * written in one transaction, so a workspace never exists without its owner.
 */
export async function POST(request: Request) {
  const context = await getWorkspaceContext();

  if (!context) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Pause (2026-11-10, fix round 1): an owner of a paused workspace cannot start
  // another. Every owned workspace (at most MAX_OWNED_WORKSPACES) goes through
  // workspaceBlock, so a later block cause is covered here too.
  const owned = await prisma.workspaceMember.findMany({
    where: { userId: context.user.id, role: "owner" },
    select: { workspace: { select: { pausedAt: true, pausedReason: true } } },
  });
  if (owned.some((membership) => workspaceBlock(membership.workspace))) {
    return NextResponse.json(
      { error: CREATE_WORKSPACE_WHILE_BLOCKED_MESSAGE, code: WORKSPACE_PAUSED_CODE },
      { status: 403 },
    );
  }

  const rateLimit = await checkRateLimit({
    userId: context.user.id,
    route: "workspaces/create",
    limit: 10,
    windowMs: 60 * 60 * 1000,
  });
  if (!rateLimit.allowed) {
    return NextResponse.json(
      { error: "Too many requests. Please slow down.", retryAfterSeconds: rateLimit.retryAfterSeconds },
      { status: 429, headers: { "Retry-After": String(rateLimit.retryAfterSeconds ?? 1) } },
    );
  }

  const body = await readJsonObject(request);
  if (!body) {
    return invalidJsonBodyResponse();
  }

  const name = typeof body.name === "string" ? body.name.replace(/\s+/g, " ").trim() : "";
  if (!name || name.length > WORKSPACE_NAME_MAX_LENGTH) {
    return NextResponse.json(
      { error: `Give the workspace a name of up to ${WORKSPACE_NAME_MAX_LENGTH} characters.` },
      { status: 400 },
    );
  }

  const ownedCount = await prisma.workspaceMember.count({
    where: { userId: context.user.id, role: "owner" },
  });
  if (ownedCount >= MAX_OWNED_WORKSPACES) {
    return NextResponse.json(
      { error: `You can own up to ${MAX_OWNED_WORKSPACES} workspaces.` },
      { status: 409 },
    );
  }

  const workspace = await prisma.$transaction(async (tx) => {
    const created = await tx.workspace.create({ data: { name } });
    await tx.workspaceMember.create({
      data: { workspaceId: created.id, userId: context.user.id, role: "owner" },
    });
    return created;
  });

  const cookieStore = await cookies();
  cookieStore.set(ACTIVE_WORKSPACE_COOKIE, workspace.id, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
  });

  return NextResponse.json(
    { workspace: { id: workspace.id, name: workspace.name, role: "owner", isActive: true } },
    { status: 201 },
  );
}
