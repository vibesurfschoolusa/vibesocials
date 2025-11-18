import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { Platform } from "@prisma/client";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const user = await getCurrentUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const contentType = request.headers.get("content-type") || "";

  let locationNameRaw: any;
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
      userId: user.id,
      platform: Platform.google_business_profile,
    },
  });

  if (!connection) {
    return NextResponse.json(
      { error: "No Google Business Profile connection found" },
      { status: 400 },
    );
  }

  const existingMetadata = (connection.metadata as any) ?? {};

  const updated = await prisma.socialConnection.update({
    where: { id: connection.id },
    data: {
      metadata: {
        ...existingMetadata,
        locationName,
      },
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
