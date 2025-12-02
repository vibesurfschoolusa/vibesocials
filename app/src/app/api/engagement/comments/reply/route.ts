import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function POST() {
  return NextResponse.json(
    { error: "Engagement comment replies have been removed from this application." },
    { status: 410 },
  );
}
