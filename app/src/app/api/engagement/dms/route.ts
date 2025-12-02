import { NextResponse } from "next/server";
import type { SocialConnection } from "@prisma/client";

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

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
const GRAPH_BASE_URL = "https://graph.facebook.com/v21.0";

async function fetchInstagramDms(
  connection: SocialConnection,
  since: Date,
): Promise<DMItem[]> {
  const accessToken = connection.accessToken;
  const igAccountId = connection.accountIdentifier;

  if (!accessToken || !igAccountId) {
    return [];
  }

  const metadata = (connection.metadata as any) ?? {};
  const businessUsername: string | undefined = metadata.username;

  try {
    const conversationsUrl = new URL(`${GRAPH_BASE_URL}/${igAccountId}/conversations`);
    conversationsUrl.searchParams.set(
      "fields",
      [
        "id",
        "updated_time",
        "unread_count",
        "participants",
        "messages.limit(1){id,from,to,text,created_time}",
      ].join(","),
    );
    conversationsUrl.searchParams.set("limit", "50");
    conversationsUrl.searchParams.set("access_token", accessToken);

    const convRes = await fetch(conversationsUrl.toString());
    if (!convRes.ok) {
      const errorBody = await convRes.text().catch(() => "Unable to read error body");
      console.error("[Engagement] Failed to fetch Instagram conversations", {
        status: convRes.status,
        errorBody,
      });
      return [];
    }

    const convJson = (await convRes.json().catch(() => null)) as
      | {
          data?: Array<{
            id?: string;
            updated_time?: string;
            unread_count?: number;
            participants?: {
              data?: Array<{
                id?: string;
                username?: string;
                name?: string;
              }>;
            };
            messages?: {
              data?: Array<{
                id?: string;
                text?: string | null;
                created_time?: string;
                from?: {
                  id?: string;
                  username?: string;
                } | null;
              }>;
            };
          }>;
        }
      | null;

    const conversations = convJson?.data ?? [];
    const items: DMItem[] = [];

    for (const conv of conversations) {
      if (!conv.id) continue;

      const lastMessage = conv.messages?.data?.[0];
      if (!lastMessage || (!lastMessage.text && !lastMessage.created_time)) {
        continue;
      }

      const lastCreated = lastMessage.created_time
        ? new Date(lastMessage.created_time).getTime()
        : conv.updated_time
          ? new Date(conv.updated_time).getTime()
          : NaN;

      if (Number.isNaN(lastCreated) || lastCreated < since.getTime()) {
        continue;
      }

      const participants = conv.participants?.data ?? [];
      const otherParticipant = participants.find((p) => p.id && p.id !== igAccountId) ??
        participants[0];

      const contactName =
        otherParticipant?.username || otherParticipant?.name || "Instagram user";
      const contactHandle = otherParticipant?.username
        ? `@${otherParticipant.username}`
        : null;

      const unreadCount = typeof conv.unread_count === "number" ? conv.unread_count : 0;

      let needsResponse = false;
      if (lastMessage.from?.id) {
        // If the last message is from someone other than the business account, assume it needs a reply
        needsResponse = lastMessage.from.id !== igAccountId;
      } else if (unreadCount > 0) {
        needsResponse = true;
      }

      items.push({
        id: conv.id,
        platform: "instagram",
        contactName,
        contactHandle,
        lastMessagePreview: lastMessage.text || "[Unsupported message type]",
        lastMessageAt: new Date(lastCreated).toISOString(),
        unreadCount,
        needsResponse,
      });
    }

    return items;
  } catch (error) {
    console.error("[Engagement] Unexpected error while fetching Instagram DMs", {
      error,
    });
    return [];
  }
}

async function fetchFacebookPageDms(
  connection: SocialConnection,
  since: Date,
): Promise<DMItem[]> {
  const accessToken = connection.accessToken;
  const pageId = connection.accountIdentifier;

  if (!accessToken || !pageId) {
    return [];
  }

  const metadata = (connection.metadata as any) ?? {};
  const pageName: string | undefined = metadata.pageName;

  try {
    const conversationsUrl = new URL(`${GRAPH_BASE_URL}/${pageId}/conversations`);
    conversationsUrl.searchParams.set(
      "fields",
      [
        "id",
        "updated_time",
        "unread_count",
        "participants",
        "messages.limit(1){id,from,to,message,created_time}",
      ].join(","),
    );
    conversationsUrl.searchParams.set("limit", "50");
    conversationsUrl.searchParams.set("access_token", accessToken);

    const convRes = await fetch(conversationsUrl.toString());
    if (!convRes.ok) {
      const errorBody = await convRes.text().catch(() => "Unable to read error body");
      console.error("[Engagement] Failed to fetch Facebook Page conversations", {
        status: convRes.status,
        errorBody,
      });
      return [];
    }

    const convJson = (await convRes.json().catch(() => null)) as
      | {
          data?: Array<{
            id?: string;
            updated_time?: string;
            unread_count?: number;
            participants?: {
              data?: Array<{
                id?: string;
                name?: string;
              }>;
            };
            messages?: {
              data?: Array<{
                id?: string;
                message?: string | null;
                created_time?: string;
                from?: {
                  id?: string;
                  name?: string;
                } | null;
              }>;
            };
          }>;
        }
      | null;

    const conversations = convJson?.data ?? [];
    const items: DMItem[] = [];

    for (const conv of conversations) {
      if (!conv.id) continue;

      const lastMessage = conv.messages?.data?.[0];
      if (!lastMessage || (!lastMessage.message && !lastMessage.created_time)) {
        continue;
      }

      const lastCreated = lastMessage.created_time
        ? new Date(lastMessage.created_time).getTime()
        : conv.updated_time
          ? new Date(conv.updated_time).getTime()
          : NaN;

      if (Number.isNaN(lastCreated) || lastCreated < since.getTime()) {
        continue;
      }

      const participants = conv.participants?.data ?? [];
      const otherParticipant = participants.find((p) => p.id && p.id !== pageId) ??
        participants[0];

      const contactName = otherParticipant?.name || "Facebook user";
      const contactHandle = null;

      const unreadCount = typeof conv.unread_count === "number" ? conv.unread_count : 0;

      let needsResponse = false;
      if (lastMessage.from?.id) {
        // If the last message is from someone other than the page, assume it needs a reply
        needsResponse = lastMessage.from.id !== pageId;
      } else if (unreadCount > 0) {
        needsResponse = true;
      }

      items.push({
        id: conv.id,
        platform: "facebook_page",
        contactName,
        contactHandle,
        lastMessagePreview: lastMessage.message || "[Unsupported message type]",
        lastMessageAt: new Date(lastCreated).toISOString(),
        unreadCount,
        needsResponse,
      });
    }

    return items;
  } catch (error) {
    console.error("[Engagement] Unexpected error while fetching Facebook Page DMs", {
      error,
    });
    return [];
  }
}

export async function GET() {
  return NextResponse.json(
    { error: "Engagement DMs have been removed from this application." },
    { status: 410 },
  );
}
