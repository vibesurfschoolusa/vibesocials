import { NextResponse } from "next/server";

import { requireOwnerContext } from "@/lib/workspace";
import { prisma } from "@/lib/db";
import { invalidJsonBodyResponse, readJsonObject } from "@/lib/http";
import { Platform, Prisma } from "@prisma/client";

export const runtime = "nodejs";

/** A business name longer than this is cut: it is only a label in Settings. */
const MAX_LOCATION_TITLE_LENGTH = 200;

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
  const { workspace } = contextOrError;

  const contentType = request.headers.get("content-type") || "";

  let locationNameRaw: unknown;
  let locationTitleRaw: unknown;
  if (contentType.includes("application/json")) {
    const body = await readJsonObject(request);
    if (!body) {
      return invalidJsonBodyResponse();
    }
    locationNameRaw = body.locationName;
    locationTitleRaw = body.locationTitle;
  } else {
    const form = await request.formData();
    locationNameRaw = form.get("locationName");
    locationTitleRaw = form.get("locationTitle");
  }
  // The location's display name, from Google's list in Settings, so the
  // connection reads "Connected as <business>" (lib/connectionSummary.ts).
  // A location saved without one (a pasted store code) clears the old name.
  const locationTitle =
    typeof locationTitleRaw === "string" && locationTitleRaw.trim()
      ? locationTitleRaw.trim().slice(0, MAX_LOCATION_TITLE_LENGTH)
      : null;
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
    return NextResponse.json(
      { error: "No Google Business Profile connection found" },
      { status: 400 },
    );
  }

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
