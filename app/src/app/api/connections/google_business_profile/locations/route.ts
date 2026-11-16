import { NextResponse } from "next/server";

import { requireOwnerContext } from "@/lib/workspace";
import { prisma } from "@/lib/db";
import { Platform } from "@prisma/client";

import { listGbpLocations, unreadAccountsNotice } from "../gbpLocations";

export const runtime = "nodejs";

/**
 * GET /api/connections/google_business_profile/locations
 * Lists the workspace's GBP account locations for the picker. Owner-only —
 * it feeds the location POST above, which is itself owner-only (Team
 * Workspaces — design §1: GBP location selection is owner-only, not just
 * member-readable).
 */
export async function GET() {
  const contextOrError = await requireOwnerContext();
  if (contextOrError instanceof NextResponse) {
    return contextOrError;
  }
  const { workspace } = contextOrError;

  const connection = await prisma.socialConnection.findFirst({
    where: {
      workspaceId: workspace.id,
      platform: Platform.google_business_profile,
    },
  });

  if (!connection) {
    return NextResponse.json(
      { error: "No Google Business Profile connection found" },
      { status: 400 },
    );
  }

  const listed = await listGbpLocations(connection);
  if (!listed.ok) return listed.response;
  // JJ3 lead review: accounts whose locations could not be read are said, with why.
  const notice = unreadAccountsNotice(listed.unread);
  return NextResponse.json(notice ? { locations: listed.locations, notice } : { locations: listed.locations });
}
