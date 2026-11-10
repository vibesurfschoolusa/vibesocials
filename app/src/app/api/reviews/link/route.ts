import { NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";

import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import { checkRateLimit } from "@/lib/rateLimit";
import { getWorkspaceContext } from "@/lib/workspace";
import { fetchNewReviewUri, refreshAccessToken, savedNewReviewUri } from "@/server/googleReviews";

export const dynamic = "force-dynamic";

const NOT_CONNECTED =
  "Connect Google Business Profile in Settings, Connections to get your review link.";
const NO_LOCATION =
  "Choose your Maps location for Google Business Profile in Settings, Connections to get your review link.";
const NEEDS_RECONNECT =
  "Reconnect Google Business Profile in Settings, Connections to get your review link.";
const GOOGLE_HAS_NONE =
  "Google has no review link for this location yet. Check that the listing is verified in Google Business Profile, then reload this page.";
const GOOGLE_FAILED = "Couldn't get your review link from Google. Reload this page to try again.";

function metadataOf(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Saves the link merged onto the metadata as it is NOW (so nothing written
 * meanwhile is lost), unless another location was chosen meanwhile.
 */
async function saveLinkIfUnchanged(id: string, locationName: string, url: string): Promise<void> {
  const fresh = await prisma.socialConnection.findUnique({ where: { id }, select: { metadata: true } });
  if (!fresh) return;
  const metadata = metadataOf(fresh.metadata);
  if (typeof metadata.locationName !== "string" || metadata.locationName.trim() !== locationName) return;
  await prisma.socialConnection.update({
    where: { id },
    data: {
      metadata: { ...metadata, newReviewUri: url, newReviewUriFor: locationName } as Prisma.InputJsonValue,
    },
  });
}

/**
 * GET /api/reviews/link - the link where a customer leaves a Google review for
 * the workspace's chosen location (2026-11-10, the "Get more reviews" panel).
 * Any member may read, like the rest of the reviews surface. Returns `{ url }`,
 * or `{ url: null, reason }` with one line on what to do.
 *
 * The link is read from Google (metadata.newReviewUri) only while none is saved
 * for the chosen location, then kept in the connection's metadata, so a page
 * load normally costs no Google request.
 */
export async function GET() {
  const context = await getWorkspaceContext();
  if (!context) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const rateLimit = await checkRateLimit({
    userId: context.user.id,
    route: "reviews/link",
    limit: 60,
    windowMs: 5 * 60 * 1000,
  });
  if (!rateLimit.allowed) {
    return NextResponse.json(
      { error: "Too many requests. Please slow down.", retryAfterSeconds: rateLimit.retryAfterSeconds },
      { status: 429, headers: { "Retry-After": String(rateLimit.retryAfterSeconds ?? 1) } },
    );
  }

  const connection = await prisma.socialConnection.findFirst({
    where: { workspaceId: context.workspace.id, platform: "google_business_profile" },
  });
  if (!connection) return NextResponse.json({ url: null, reason: NOT_CONNECTED });

  const saved = savedNewReviewUri(connection.metadata);
  if (saved) return NextResponse.json({ url: saved });

  const rawLocation = metadataOf(connection.metadata).locationName;
  const locationName = typeof rawLocation === "string" ? rawLocation.trim() : "";
  if (!locationName) return NextResponse.json({ url: null, reason: NO_LOCATION });
  if (connection.needsReconnect) return NextResponse.json({ url: null, reason: NEEDS_RECONNECT });

  try {
    let accessToken = connection.accessToken;
    if (connection.expiresAt && new Date(connection.expiresAt) <= new Date()) {
      accessToken = (await refreshAccessToken(connection)).accessToken;
    }

    const url = await fetchNewReviewUri(accessToken, locationName);
    if (!url) return NextResponse.json({ url: null, reason: GOOGLE_HAS_NONE });

    await saveLinkIfUnchanged(connection.id, locationName, url);
    return NextResponse.json({ url });
  } catch (error) {
    // The error kind only: a message could quote a URL.
    logger.warn("[GET /api/reviews/link] Couldn't read the review link", {
      connectionId: connection.id,
      error: error instanceof Error ? error.name : "unknown",
      code: (error as { code?: unknown } | null)?.code,
    });
    const reason =
      (error as { code?: unknown } | null)?.code === "RECONNECT_REQUIRED" ? NEEDS_RECONNECT : GOOGLE_FAILED;
    return NextResponse.json({ url: null, reason });
  }
}
