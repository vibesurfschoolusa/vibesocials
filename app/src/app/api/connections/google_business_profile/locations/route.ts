import { NextResponse } from "next/server";

import { requireOwnerContext } from "@/lib/workspace";
import { prisma } from "@/lib/db";
import { renderedWorkspaceRefusal } from "@/lib/workspaceChanged";
import { Platform } from "@prisma/client";

import { GBP_DISCONNECTED_MESSAGE, googleRouteRateLimit, listGbpLocations, listingNotice } from "../gbpLocations";

export const runtime = "nodejs";

/**
 * GET /api/connections/google_business_profile/locations
 * Lists the workspace's GBP account locations for the picker. Owner-only —
 * it feeds the location POST above, which is itself owner-only (Team
 * Workspaces — design §1: GBP location selection is owner-only, not just
 * member-readable).
 *
 * R27 new-customer L6: `?workspaceId=` is the workspace the Settings page was
 * rendered for; another one (a switch in another tab) is refused (409
 * WORKSPACE_CHANGED) before anything is read, so the list is never another
 * workspace's.
 */
export async function GET(request: Request) {
  const contextOrError = await requireOwnerContext();
  if (contextOrError instanceof NextResponse) {
    return contextOrError;
  }
  const { user, workspace } = contextOrError;

  const sent = new URL(request.url).searchParams.get("workspaceId");
  // No id is a page open from before the id was sent: it lists as before, until reloaded.
  const refusal = sent === null ? null : renderedWorkspaceRefusal(sent, workspace.id);
  if (refusal) return refusal;

  const limited = await googleRouteRateLimit(user.id, "google_business_profile/locations");
  if (limited) return limited;

  const connection = await prisma.socialConnection.findFirst({
    where: {
      workspaceId: workspace.id,
      platform: Platform.google_business_profile,
    },
  });

  if (!connection) {
    return NextResponse.json({ error: GBP_DISCONNECTED_MESSAGE }, { status: 400 });
  }

  const listed = await listGbpLocations(connection);
  if (!listed.ok) return listed.response;
  // JJ3 lead review: accounts whose locations could not be read are said, with
  // why. R25 client-journey L1: no listing at all; the step is the in-place
  // sign-in. R26: the Reviews list adds the same, from the same helper.
  return NextResponse.json({ locations: listed.locations, ...listingNotice(listed, "picker") });
}
