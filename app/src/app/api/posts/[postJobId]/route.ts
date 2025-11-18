import { NextRequest, NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth";
import { prisma } from "@/lib/db";

export async function GET(_request: NextRequest, context: any) {
  const user = await getCurrentUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { postJobId } = context.params;

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
