import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import { prisma } from "@/lib/db";
import { ACTIVE_WORKSPACE_COOKIE, getWorkspaceContext } from "@/lib/workspace";

interface SwitchBody {
  workspaceId?: unknown;
}

/**
 * POST /api/workspaces/switch { workspaceId }
 *
 * Sets the active-workspace cookie (design doc §1) after re-validating that
 * the caller is actually a member of `workspaceId` — the cookie is a hint,
 * never an authority, so every switch is membership-checked fresh here
 * rather than trusting the client's request.
 */
export async function POST(request: Request) {
  const context = await getWorkspaceContext();

  if (!context) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: SwitchBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (typeof body.workspaceId !== "string" || !body.workspaceId.trim()) {
    return NextResponse.json({ error: "workspaceId is required." }, { status: 400 });
  }

  const membership = await prisma.workspaceMember.findFirst({
    where: { workspaceId: body.workspaceId, userId: context.user.id },
  });

  if (!membership) {
    return NextResponse.json(
      { error: "You're not a member of that workspace." },
      { status: 403 },
    );
  }

  const cookieStore = await cookies();
  cookieStore.set(ACTIVE_WORKSPACE_COOKIE, membership.workspaceId, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
  });

  return NextResponse.json({ ok: true, workspaceId: membership.workspaceId }, { status: 200 });
}
