import { NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";

import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import { checkRateLimit } from "@/lib/rateLimit";
import { getWorkspaceContext } from "@/lib/workspace";
import { fetchNewReviewUri, refreshAccessToken, reviewLinkReason, savedNewReviewUri } from "@/server/googleReviews";
import { signedOutResponse } from "@/lib/signedOutResponse";

export const dynamic = "force-dynamic";

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
 * or `{ url: null, reason }` with one line on what to do, worded for the
 * caller's role (R12 L1: only an owner can connect, choose or reconnect).
 *
 * The link is read from Google (metadata.newReviewUri) only while none is saved
 * for the chosen location, then kept in the connection's metadata, so a page
 * load normally costs no Google request.
 */
export async function GET() {
  const context = await getWorkspaceContext();
  if (!context) {
    return signedOutResponse();
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

  const reason = (problem: Parameters<typeof reviewLinkReason>[0]) => reviewLinkReason(problem, context.role);

  const connection = await prisma.socialConnection.findFirst({
    where: { workspaceId: context.workspace.id, platform: "google_business_profile" },
  });
  if (!connection) return NextResponse.json({ url: null, reason: reason("not_connected") });

  const saved = savedNewReviewUri(connection.metadata);
  if (saved) return NextResponse.json({ url: saved });

  const rawLocation = metadataOf(connection.metadata).locationName;
  const locationName = typeof rawLocation === "string" ? rawLocation.trim() : "";
  if (!locationName) return NextResponse.json({ url: null, reason: reason("no_location") });
  if (connection.needsReconnect) return NextResponse.json({ url: null, reason: reason("needs_reconnect") });

  try {
    let accessToken = connection.accessToken;
    if (connection.expiresAt && new Date(connection.expiresAt) <= new Date()) {
      accessToken = (await refreshAccessToken(connection)).accessToken;
    }

    const url = await fetchNewReviewUri(accessToken, locationName);
    if (!url) return NextResponse.json({ url: null, reason: reason("google_has_none") });

    await saveLinkIfUnchanged(connection.id, locationName, url);
    return NextResponse.json({ url });
  } catch (error) {
    // The error kind only: a message could quote a URL.
    logger.warn("[GET /api/reviews/link] Couldn't read the review link", {
      connectionId: connection.id,
      error: error instanceof Error ? error.name : "unknown",
      code: (error as { code?: unknown } | null)?.code,
    });
    return NextResponse.json({
      url: null,
      reason: (error as { code?: unknown } | null)?.code === "RECONNECT_REQUIRED" ? reason("needs_reconnect") : GOOGLE_FAILED,
    });
  }
}
