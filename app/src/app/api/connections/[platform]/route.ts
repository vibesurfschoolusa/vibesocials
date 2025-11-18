import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { Platform } from "@prisma/client";

interface RouteContext {
  params: {
    platform: string;
  };
}

export async function DELETE(_request: Request, context: RouteContext) {
  const user = await getCurrentUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const platformParam = context.params.platform;

  const allPlatforms = Object.values(Platform) as string[];
  if (!allPlatforms.includes(platformParam)) {
    return NextResponse.json({ error: "Unknown platform" }, { status: 400 });
  }

  const platform = platformParam as Platform;

  try {
    const result = await prisma.socialConnection.deleteMany({
      where: {
        userId: user.id,
        platform,
      },
    });

    return NextResponse.json(
      { ok: true, deletedCount: result.count },
      { status: 200 },
    );
  } catch (error) {
    console.error("[DELETE /api/connections/[platform]] Unexpected error", {
      error,
    });
    return NextResponse.json(
      { error: "Failed to disconnect platform" },
      { status: 500 },
    );
  }
}
