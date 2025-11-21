import { NextRequest, NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { Platform } from "@prisma/client";

export async function DELETE(_request: NextRequest, context: any) {
  const user = await getCurrentUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // In Next.js 15+, params might be a Promise
  const params = await Promise.resolve(context.params);
  const platformParam = params.platform;
  const allPlatforms = Object.values(Platform) as string[];

  console.log('[DELETE /api/connections/[platform]]', {
    platformParam,
    allPlatforms,
    isValid: allPlatforms.includes(platformParam),
  });

  if (!allPlatforms.includes(platformParam)) {
    return NextResponse.json({ 
      error: "Unknown platform",
      received: platformParam,
      expected: allPlatforms,
    }, { status: 400 });
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
