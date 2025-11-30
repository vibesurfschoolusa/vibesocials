import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

interface CommentItem {
  id: string;
  platform:
    | "tiktok"
    | "youtube"
    | "x"
    | "linkedin"
    | "instagram"
    | "google_business_profile"
    | "facebook_page";
  authorName: string;
  text: string;
  createdAt: string;
  replied: boolean;
  sourceTitle?: string | null;
}

export async function GET() {
  const user = await getCurrentUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const comments: CommentItem[] = [];

  return NextResponse.json({ comments });
}
