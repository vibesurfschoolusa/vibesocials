import { NextResponse } from "next/server";

import { logger } from "@/lib/logger";
import { checkRateLimit } from "@/lib/rateLimit";
import {
  REVIEW_LINK_INACTIVE_MESSAGE,
  REVIEW_LINK_IP_LIMIT_MESSAGE,
  REVIEW_LINK_IP_PER_HOUR,
} from "@/lib/reviewLink";
import { requestIp } from "@/lib/uploadLink";
import { findActiveReviewLink, listReviewPosts } from "@/server/reviewLink";

/**
 * GET /api/review-link/[token] — the upcoming posts a client review link shows
 * (2026-11-10), signed out. The workspace comes from the link and nothing else;
 * the answer is the list and nothing about the link or the workspace
 * (listReviewPosts in server/reviewLink.ts decides which fields leave).
 *
 * Order: the per-IP limit (shared with the decision route), then the lookup.
 */

type RouteContext = { params: Promise<{ token: string }> };

export async function GET(request: Request, context: RouteContext): Promise<NextResponse> {
  const ipLimit = await checkRateLimit({
    userId: `ip:${requestIp(request)}`,
    route: "review-link/ip",
    limit: REVIEW_LINK_IP_PER_HOUR,
    windowMs: 60 * 60 * 1000,
    failClosed: true,
  });
  if (!ipLimit.allowed) {
    return NextResponse.json(
      { error: REVIEW_LINK_IP_LIMIT_MESSAGE, retryAfterSeconds: ipLimit.retryAfterSeconds },
      { status: 429, headers: { "Retry-After": String(ipLimit.retryAfterSeconds ?? 60) } },
    );
  }

  const { token } = await context.params;
  const link = await findActiveReviewLink(token);
  if (!link) return NextResponse.json({ error: REVIEW_LINK_INACTIVE_MESSAGE }, { status: 404 });

  try {
    const posts = await listReviewPosts(link.workspaceId, new Date());
    return NextResponse.json({ posts }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    logger.error("[review-link] Couldn't list the posts", { error, linkId: link.id });
    return NextResponse.json({ error: "Couldn't load the posts. Try again." }, { status: 500 });
  }
}
