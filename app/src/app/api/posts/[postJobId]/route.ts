import { NextRequest, NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth";
import { prisma } from "@/lib/db";

interface PostJobRouteContext {
  params: Promise<{ postJobId: string }> | { postJobId: string };
}

export async function GET(_request: NextRequest, context: PostJobRouteContext) {
  const user = await getCurrentUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Preserve the existing synchronous params access (see PlatformRouteContext
  // in connections/[platform]); the union type keeps the handler signature
  // assignable to Next's generated route type.
  const { postJobId } = context.params as { postJobId: string };

  const postJob = await prisma.postJob.findFirst({
    where: { id: postJobId, userId: user.id },
  });

  if (!postJob) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const results = await prisma.postJobResult.findMany({
    where: { postJobId: postJob.id },
  });

  return NextResponse.json({ postJob, results }, { status: 200 });
}
