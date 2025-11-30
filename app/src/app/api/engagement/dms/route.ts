import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

interface DMItem {
  id: string;
  platform:
    | "tiktok"
    | "youtube"
    | "x"
    | "linkedin"
    | "instagram"
    | "google_business_profile"
    | "facebook_page";
  contactName: string;
  contactHandle?: string | null;
  lastMessagePreview: string;
  lastMessageAt: string;
  unreadCount: number;
  needsResponse: boolean;
}

export async function GET() {
  const user = await getCurrentUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const dms: DMItem[] = [];

  return NextResponse.json({ dms });
}
