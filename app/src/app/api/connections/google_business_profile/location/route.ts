import { NextResponse } from "next/server";

import { requireOwnerContext } from "@/lib/workspace";
import { prisma } from "@/lib/db";
import { invalidJsonBodyResponse, readJsonObject } from "@/lib/http";
import { renderedWorkspaceRefusal } from "@/lib/workspaceChanged";
import { truncateGraphemesWithinCodePoints } from "@/lib/truncate";
import { Platform, Prisma } from "@prisma/client";

import { STORE_CODE_NOT_UNIQUE_MESSAGE, exactStoreCodeMatches } from "@/server/platforms/gbpLocation";

import { GBP_DISCONNECTED_MESSAGE, GOOGLE_NO_ANSWER_MESSAGE, googleRouteRateLimit, listGbpLocations } from "../gbpLocations";

export const runtime = "nodejs";

/** A business name longer than this is cut: it is only a label in Settings. */
const MAX_LOCATION_TITLE_LENGTH = 200;

const LOCATION_NOT_LISTED_MESSAGE =
  "That location isn't one this Google account manages. Click Fetch locations from Google and choose it from the list.";

/**
 * POST /api/connections/google_business_profile/location
 * Sets the chosen Maps location on the workspace's GBP connection.
 * Owner-only — it drives setup (Team Workspaces — design §1: "Connect /
 * disconnect / switch platform accounts, GBP location" is owner-only).
 */
export async function POST(request: Request) {
  const contextOrError = await requireOwnerContext();
  if (contextOrError instanceof NextResponse) {
    return contextOrError;
  }
  const { user, workspace } = contextOrError;

  const limited = await googleRouteRateLimit(user.id, "google_business_profile/location");
  if (limited) return limited;

  const contentType = request.headers.get("content-type") || "";

  let locationNameRaw: unknown;
  let workspaceIdRaw: unknown;
  if (contentType.includes("application/json")) {
    const body = await readJsonObject(request);
    if (!body) {
      return invalidJsonBodyResponse();
    }
    locationNameRaw = body.locationName;
    workspaceIdRaw = body.workspaceId;
  } else {
    const form = await request.formData();
    locationNameRaw = form.get("locationName");
    workspaceIdRaw = form.get("workspaceId");
  }
  const refusal = renderedWorkspaceRefusal(workspaceIdRaw, workspace.id);
  if (refusal) {
    return refusal;
  }
  if (typeof locationNameRaw !== "string" || !locationNameRaw.trim()) {
    return NextResponse.json(
      { error: "locationName is required" },
      { status: 400 },
    );
  }

  const locationName = locationNameRaw.trim();

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
  if (!listed.ok) {
    return listed.response;
  }
  const byName = listed.locations.find((location) => location.resourceName === locationName);
  const byCode = byName ? [] : exactStoreCodeMatches(listed.locations, locationName);
  // R26 platform-clients L3: a store code several locations share names none of
  // them, so every post to it would fail (gbpLocation.ts resolveGbpLocationName).
  if (byCode.length > 1) {
    return NextResponse.json({ error: STORE_CODE_NOT_UNIQUE_MESSAGE }, { status: 400 });
  }
  const matched = byName ?? byCode[0];
  if (!matched) {
    // Found nowhere, but an account's list could not all be read: the
    // location may be on the part that is missing, so this is Google's
    // failure, not a refusal. Found in an account that answered, it saves.
    // JJ3 lead review: accounts that refused access cannot be posted to
    // either, so when they are all that is missing, it is a refusal.
    return listed.complete || listed.refusedOnly
      ? NextResponse.json({ error: LOCATION_NOT_LISTED_MESSAGE }, { status: 400 })
      : NextResponse.json({ error: GOOGLE_NO_ANSWER_MESSAGE }, { status: 503 });
  }

  // The business name comes from Google's list, never the browser: Save from
  // the Advanced field sends none, and wiped "Connected as <business>"
  // (lib/connectionSummary.ts) until the daily backfill (R56 new-customer-2 L1).
  const title = matched.title?.trim();
  const locationTitle = (title && truncateGraphemesWithinCodePoints(title, MAX_LOCATION_TITLE_LENGTH)) || null;

  const existingMetadata = (connection.metadata as Record<string, unknown> | null) ?? {};

  const updated = await prisma.socialConnection.update({
    where: { id: connection.id },
    data: {
      metadata: {
        ...existingMetadata,
        locationName,
        locationTitle,
      } as Prisma.InputJsonObject,
    },
  });

  return NextResponse.json({
    ok: true,
    connection: {
      id: updated.id,
      metadata: updated.metadata,
    },
  });
}
