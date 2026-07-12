import { NextResponse } from "next/server";

import { requireOwnerContext } from "@/lib/workspace";
import { prisma } from "@/lib/db";
import { Platform, Prisma } from "@prisma/client";

export const runtime = "nodejs";

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
  if (contentType.includes("application/json")) {
    try {
      const body = await request.json();
      locationNameRaw = body?.locationName;
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }
  } else {
    const form = await request.formData();
    locationNameRaw = form.get("locationName");
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
