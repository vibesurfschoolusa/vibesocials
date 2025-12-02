import { NextResponse } from "next/server";
import type { SocialConnection } from "@prisma/client";

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

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

async function fetchInstagramComments(
  connection: SocialConnection,
  since: Date,
): Promise<CommentItem[]> {
  const accessToken = connection.accessToken;
  const igAccountId = connection.accountIdentifier;

  if (!accessToken || !igAccountId) {
    return [];
  }

  const metadata = (connection.metadata as any) ?? {};
  const username: string | undefined = metadata.username;

  const baseUrl = "https://graph.facebook.com/v21.0";

  try {
    const mediaUrl = new URL(`${baseUrl}/${igAccountId}/media`);
    mediaUrl.searchParams.set("fields", "id,caption,timestamp");
    mediaUrl.searchParams.set("limit", "25");
    mediaUrl.searchParams.set("access_token", accessToken);

    const mediaRes = await fetch(mediaUrl.toString());
    if (!mediaRes.ok) {
      const errorBody = await mediaRes.text().catch(() => "Unable to read error");
      console.error("[Engagement] Failed to fetch Instagram media", {
        status: mediaRes.status,
        errorBody,
      });
      return [];
    }

    const mediaJson = (await mediaRes.json().catch(() => null)) as
      | {
          data?: { id: string; caption?: string | null; timestamp?: string }[];
        }
      | null;

    const mediaItems = (mediaJson?.data ?? []).filter((item) => {
      if (!item.timestamp) return false;
      const ts = new Date(item.timestamp).getTime();
      return !Number.isNaN(ts) && ts >= since.getTime();
    });

    const comments: CommentItem[] = [];

    for (const media of mediaItems) {
      const commentsUrl = new URL(`${baseUrl}/${media.id}/comments`);
      commentsUrl.searchParams.set("fields", "id,text,timestamp,username");
      commentsUrl.searchParams.set("limit", "50");
      commentsUrl.searchParams.set("access_token", accessToken);

      const commentsRes = await fetch(commentsUrl.toString());
      if (!commentsRes.ok) {
        const errorBody = await commentsRes.text().catch(() => "Unable to read error");
        console.error("[Engagement] Failed to fetch Instagram comments", {
          mediaId: media.id,
          status: commentsRes.status,
          errorBody,
        });
        continue;
      }

      const commentsJson = (await commentsRes.json().catch(() => null)) as
        | {
            data?: {
              id: string;
              text?: string | null;
              timestamp?: string;
              username?: string | null;
            }[];
          }
        | null;

      for (const c of commentsJson?.data ?? []) {
        if (!c.id || !c.text || !c.timestamp) {
          continue;
        }

        const createdTime = new Date(c.timestamp).getTime();
        if (Number.isNaN(createdTime) || createdTime < since.getTime()) {
          continue;
        }

        // Skip our own comments so we only see incoming comments that may need replies
        if (username && c.username === username) {
          continue;
        }

        comments.push({
          id: c.id,
          platform: "instagram",
          authorName: c.username || "Instagram user",
          text: c.text,
          createdAt: new Date(createdTime).toISOString(),
          // For now we assume comments need replies; we can enhance this later
          replied: false,
          sourceTitle: media.caption ?? null,
        });
      }
    }

    return comments;
  } catch (error) {
    console.error("[Engagement] Unexpected error while fetching Instagram comments", {
      error,
    });
    return [];
  }
}

async function fetchFacebookPageComments(
  connection: SocialConnection,
  since: Date,
): Promise<CommentItem[]> {
  const accessToken = connection.accessToken;
  const pageId = connection.accountIdentifier;

  if (!accessToken || !pageId) {
    return [];
  }

  const baseUrl = "https://graph.facebook.com/v21.0";

  try {
    const postsUrl = new URL(`${baseUrl}/${pageId}/posts`);
    postsUrl.searchParams.set("fields", "id,message,created_time");
    postsUrl.searchParams.set("limit", "25");
    postsUrl.searchParams.set("access_token", accessToken);

    const postsRes = await fetch(postsUrl.toString());
    if (!postsRes.ok) {
      const errorBody = await postsRes.text().catch(() => "Unable to read error");
      console.error("[Engagement] Failed to fetch Facebook Page posts", {
        status: postsRes.status,
        errorBody,
      });
      return [];
    }

    const postsJson = (await postsRes.json().catch(() => null)) as
      | {
          data?: {
            id: string;
            message?: string | null;
            created_time?: string;
          }[];
        }
      | null;

    const posts = (postsJson?.data ?? []).filter((post) => {
      if (!post.created_time) return false;
      const ts = new Date(post.created_time).getTime();
      return !Number.isNaN(ts) && ts >= since.getTime();
    });

    const comments: CommentItem[] = [];

    for (const post of posts) {
      const commentsUrl = new URL(`${baseUrl}/${post.id}/comments`);
      commentsUrl.searchParams.set("fields", "id,from,message,created_time");
      commentsUrl.searchParams.set("order", "reverse_chronological");
      commentsUrl.searchParams.set("limit", "50");
      commentsUrl.searchParams.set("access_token", accessToken);

      const commentsRes = await fetch(commentsUrl.toString());
      if (!commentsRes.ok) {
        const errorBody = await commentsRes.text().catch(() => "Unable to read error");
        console.error("[Engagement] Failed to fetch Facebook Page comments", {
          postId: post.id,
          status: commentsRes.status,
          errorBody,
        });
        continue;
      }

      const commentsJson = (await commentsRes.json().catch(() => null)) as
        | {
            data?: {
              id: string;
              message?: string | null;
              created_time?: string;
              from?: {
                id?: string | null;
                name?: string | null;
              } | null;
            }[];
          }
        | null;

      for (const c of commentsJson?.data ?? []) {
        if (!c.id || !c.message || !c.created_time) {
          continue;
        }

        const createdTime = new Date(c.created_time).getTime();
        if (Number.isNaN(createdTime) || createdTime < since.getTime()) {
          continue;
        }

        // Skip comments authored by the page itself
        if (c.from?.id && c.from.id === pageId) {
          continue;
        }

        comments.push({
          id: c.id,
          platform: "facebook_page",
          authorName: c.from?.name || "Facebook user",
          text: c.message,
          createdAt: new Date(createdTime).toISOString(),
          // Initial implementation treats all external comments as needing replies
          replied: false,
          sourceTitle: post.message ?? null,
        });
      }
    }

    return comments;
  } catch (error) {
    console.error("[Engagement] Unexpected error while fetching Facebook Page comments", {
      error,
    });
    return [];
  }
}

export async function GET() {
  return NextResponse.json(
    { error: "Engagement comments have been removed from this application." },
    { status: 410 },
  );
}
