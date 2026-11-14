import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { checkRateLimit } from "@/lib/rateLimit";
import { ACTIVE_WORKSPACE_COOKIE } from "@/lib/workspace";
import { goTarget } from "@/server/notifications/links";

import { OTHER_WORKSPACE_NOTICE } from "./notice";

export const dynamic = "force-dynamic";

/**
 * GET /go?w=<workspaceId>&to=<path> (fix round 1, F4): where every email link
 * points (server/notifications/links.ts workspaceLink). The active workspace is
 * one cookie, so a plain link opened while another workspace is active would
 * show the wrong one. This switches to `w` when the signed-in person is a
 * member of it, exactly as the account picker does (POST
 * /api/workspaces/switch: membership checked fresh, the same cookie), then
 * opens `to`.
 *
 * - Signed out: sign-in, which comes back here (the proxy does the same for a
 *   page; this covers a request it lets through).
 * - Not a member: the dashboard with a notice naming the signed-in account,
 *   nothing switched.
 * - `to` must be a same-site path; anything else opens the dashboard.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const workspaceId = url.searchParams.get("w");
  const target = goTarget(url.searchParams.get("to"));

  const user = await getCurrentUser();
  if (!user) {
    const login = new URL("/login", request.url);
    login.searchParams.set("callbackUrl", `/go${url.search}`);
    return NextResponse.redirect(login);
  }

  const rateLimit = await checkRateLimit({
    userId: user.id,
    route: "go",
    limit: 120,
    windowMs: 5 * 60 * 1000,
  });
  if (!rateLimit.allowed) {
    return NextResponse.redirect(new URL("/", request.url));
  }

  if (!workspaceId) {
    return NextResponse.redirect(new URL(target, request.url));
  }

  const membership = await prisma.workspaceMember.findFirst({
    where: { workspaceId, userId: user.id },
    select: { workspaceId: true },
  });
  if (!membership) {
    // R2-client-journey L2: the dashboard says the link is for another workspace.
    const home = new URL("/", request.url);
    home.searchParams.set("notice", OTHER_WORKSPACE_NOTICE);
    return NextResponse.redirect(home);
  }

  const response = NextResponse.redirect(new URL(target, request.url));
  // The same cookie and options as POST /api/workspaces/switch.
  response.cookies.set(ACTIVE_WORKSPACE_COOKIE, membership.workspaceId, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
  });
  return response;
}
