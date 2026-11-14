import { NextResponse } from "next/server";

import { requireOwnerContext } from "@/lib/workspace";
import { prisma } from "@/lib/db";
import { Platform } from "@prisma/client";

import { listGbpLocations } from "../gbpLocations";

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
  return listed.ok ? NextResponse.json({ locations: listed.locations }) : listed.response;
}
