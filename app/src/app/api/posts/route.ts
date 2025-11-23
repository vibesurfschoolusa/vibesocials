import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth";
import type { Platform } from "@prisma/client";
import {
  createAndRunPostJob,
  createAndRunPostJobForExistingMedia,
} from "@/server/jobs/posting";
import { saveUploadedFile } from "@/server/storage";
import { prisma } from "@/lib/db";

export async function POST(request: Request) {
  const user = await getCurrentUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const contentType = request.headers.get("content-type") || "";

  if (contentType.includes("application/json")) {
    let body: any;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const mediaItemIdRaw = body?.mediaItemId;
    const baseCaptionRaw = body?.baseCaption;
    const locationRaw = body?.location;
    const overridesRaw = body?.perPlatformOverrides;

    if (typeof mediaItemIdRaw !== "string" || !mediaItemIdRaw.trim()) {
      return NextResponse.json(
        { error: "mediaItemId is required" },
        { status: 400 },
      );
    }

    if (typeof baseCaptionRaw !== "string" || !baseCaptionRaw.trim()) {
      return NextResponse.json(
        { error: "baseCaption is required" },
        { status: 400 },
      );
    }

    let perPlatformOverrides: Partial<Record<Platform, string>> | undefined;
    if (overridesRaw != null) {
      if (typeof overridesRaw !== "object") {
        return NextResponse.json(
          { error: "perPlatformOverrides must be an object if provided" },
          { status: 400 },
        );
      }
      perPlatformOverrides = overridesRaw as Partial<Record<Platform, string>>;
    }

    const location = typeof locationRaw === "string" && locationRaw.trim() ? locationRaw.trim() : undefined;

    try {
      const { postJob, results } = await createAndRunPostJobForExistingMedia({
        userId: user.id,
        mediaItemId: mediaItemIdRaw.trim(),
        baseCaption: baseCaptionRaw,
        location,
        perPlatformOverrides: perPlatformOverrides ?? null,
      });

      return NextResponse.json({ postJob, results }, { status: 201 });
    } catch (error: any) {
      if (error instanceof Error && error.message === "MEDIA_ITEM_NOT_FOUND") {
        return NextResponse.json(
          { error: "Media item not found" },
          { status: 404 },
        );
      }
      if (error instanceof Error && error.message === "NO_CONNECTIONS") {
        return NextResponse.json(
          {
            error: "No connected platforms",
            code: "NO_CONNECTIONS",
            message: "Connect at least one platform before creating a post.",
          },
          { status: 400 },
        );
      }

      console.error("[POST /api/posts] Unexpected error (JSON)", { error });
      return NextResponse.json(
        { error: "Failed to create post" },
        { status: 500 },
      );
    }
  }

  if (!contentType.includes("multipart/form-data")) {
    return NextResponse.json(
      { error: "Content-Type must be multipart/form-data or application/json" },
      { status: 400 },
    );
  }

  const formData = await request.formData();

  const file = formData.get("file");
  const baseCaption = formData.get("baseCaption");
  const locationFormData = formData.get("location");
  const overridesRaw = formData.get("perPlatformOverrides");

  if (!(file instanceof File)) {
    return NextResponse.json({ error: "file is required" }, { status: 400 });
  }

  if (typeof baseCaption !== "string" || !baseCaption.trim()) {
    return NextResponse.json(
      { error: "baseCaption is required" },
      { status: 400 },
    );
  }

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

  const location = typeof locationFormData === "string" && locationFormData.trim() ? locationFormData.trim() : undefined;

  try {
    const saved = await saveUploadedFile(user.id, file);

    const { postJob, results } = await createAndRunPostJob({
      userId: user.id,
      media: saved,
      baseCaption,
      location,
      perPlatformOverrides: perPlatformOverrides ?? null,
    });

    return NextResponse.json({ postJob, results }, { status: 201 });
  } catch (error: any) {
    if (error instanceof Error && error.message === "NO_CONNECTIONS") {
      return NextResponse.json(
        {
          error: "No connected platforms",
          code: "NO_CONNECTIONS",
          message: "Connect at least one platform before creating a post.",
        },
        { status: 400 },
      );
    }

    console.error("[POST /api/posts] Unexpected error (multipart)", { error });
    return NextResponse.json(
      { error: "Failed to create post" },
      { status: 500 },
    );
  }
}
