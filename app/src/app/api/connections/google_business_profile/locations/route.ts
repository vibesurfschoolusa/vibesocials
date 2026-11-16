import { NextResponse } from "next/server";

import { requireOwnerContext } from "@/lib/workspace";
import { prisma } from "@/lib/db";
import { Platform } from "@prisma/client";

import { GBP_NO_LISTING_NOTICE, googleRouteRateLimit, listGbpLocations, unreadAccountsNotice } from "../gbpLocations";

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
  const { user, workspace } = contextOrError;

  const limited = await googleRouteRateLimit(user.id, "google_business_profile/locations");
  if (limited) return limited;

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
  if (notice) return NextResponse.json({ locations: listed.locations, notice });
  // R25 client-journey L1: no listing at all; the step is the in-place sign-in.
  if (listed.locations.length === 0) {
    return NextResponse.json({ locations: [], notice: GBP_NO_LISTING_NOTICE, signIn: true });
  }
  return NextResponse.json({ locations: listed.locations });
}
