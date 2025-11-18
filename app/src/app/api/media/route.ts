import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { saveUploadedFile } from "@/server/storage";
import type { Platform } from "@prisma/client";

export async function GET(_request: Request) {
  const user = await getCurrentUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const items = await prisma.mediaItem.findMany({
    where: { userId: user.id },
    orderBy: { createdAt: "desc" },
  });

  return NextResponse.json({ items }, { status: 200 });
}

export async function POST(request: Request) {
  const user = await getCurrentUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const contentType = request.headers.get("content-type") || "";
  if (!contentType.includes("multipart/form-data")) {
    return NextResponse.json(
      { error: "Content-Type must be multipart/form-data" },
      { status: 400 },
    );
  }

  const formData = await request.formData();

  const file = formData.get("file");
  const baseCaptionRaw = formData.get("baseCaption");
  const overridesRaw = formData.get("perPlatformOverrides");

  if (!(file instanceof File)) {
    return NextResponse.json({ error: "file is required" }, { status: 400 });
  }

  const baseCaption =
    typeof baseCaptionRaw === "string" ? baseCaptionRaw.trim() : "";

  let perPlatformOverrides: Partial<Record<Platform, string>> | undefined;
  if (typeof overridesRaw === "string" && overridesRaw.trim()) {
    try {
      const parsed = JSON.parse(overridesRaw) as Record<string, string>;
      perPlatformOverrides = parsed as Partial<Record<Platform, string>>;
    } catch {
      return NextResponse.json(
        { error: "Invalid perPlatformOverrides JSON" },
        { status: 400 },
      );
    }
  }

  try {
    const saved = await saveUploadedFile(user.id, file);

    const mediaItem = await prisma.mediaItem.create({
      data: {
        userId: user.id,
        storageLocation: saved.storageLocation,
        originalFilename: saved.originalFilename,
        mimeType: saved.mimeType,
        sizeBytes: saved.sizeBytes,
        baseCaption,
        perPlatformOverrides: perPlatformOverrides
          ? (perPlatformOverrides as unknown as Record<string, string>)
          : undefined,
      },
    });

    return NextResponse.json({ mediaItem }, { status: 201 });
  } catch (error) {
    console.error("[POST /api/media] Unexpected error", { error });
    return NextResponse.json(
      { error: "Failed to save media item" },
      { status: 500 },
    );
  }
}
