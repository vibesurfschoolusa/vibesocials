import { NextResponse } from "next/server";

import { prisma } from "@/lib/db";
import { summarizeListingMetrics, type ListingMetricTotals } from "@/lib/listingMetrics";
import { getWorkspaceContext } from "@/lib/workspace";

export const dynamic = "force-dynamic";

/** Days in each window the dashboard card compares. */
export const LISTING_METRICS_WINDOW_DAYS = 28;

export interface ListingMetricsResponse {
  /** Null when the workspace has no Google listing chosen, or no stored day for it. */
  listing: {
    title: string;
    windowDays: number;
    /** The newest stored day (YYYY-MM-DD), the end of the current window. */
    endDay: string;
    current: ListingMetricTotals;
    /** Null when nothing is stored before the current window. */
    previous: ListingMetricTotals | null;
  } | null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/**
 * GET /api/insights/listing-metrics: the active workspace's Google listing
 * numbers (stored daily by the google-listing-metrics-sync job) over the last
 * 28 stored days and the 28 before. Any member may read it, like publish health.
 *
 * Only the CURRENT location's rows are read: rows of a listing the owner picked
 * before stay stored but never mix into this one. With one row per day, the 56
 * newest rows cover both windows. Calls no Google API.
 */
export async function GET() {
  const context = await getWorkspaceContext();
  if (!context) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const workspaceId = context.workspace.id;
  const empty: ListingMetricsResponse = { listing: null };

  const connection = await prisma.socialConnection.findUnique({
    where: { workspaceId_platform: { workspaceId, platform: "google_business_profile" } },
    select: { metadata: true },
  });
  const metadata =
    connection?.metadata && typeof connection.metadata === "object" && !Array.isArray(connection.metadata)
      ? (connection.metadata as Record<string, unknown>)
      : {};
  const locationName = nonEmptyString(metadata.locationName);
  if (!locationName) return NextResponse.json(empty);

  const rows = await prisma.locationMetricDaily.findMany({
    where: { workspaceId, locationName },
    orderBy: { day: "desc" },
    take: 2 * LISTING_METRICS_WINDOW_DAYS,
    select: {
      day: true,
      searchViews: true,
      mapsViews: true,
      calls: true,
      directionRequests: true,
      websiteClicks: true,
    },
  });

  const summary = summarizeListingMetrics(rows, LISTING_METRICS_WINDOW_DAYS);
  if (!summary.endDay || !summary.current) return NextResponse.json(empty);

  const payload: ListingMetricsResponse = {
    listing: {
      title: nonEmptyString(metadata.locationTitle) ?? context.workspace.name,
      windowDays: LISTING_METRICS_WINDOW_DAYS,
      endDay: summary.endDay,
      current: summary.current,
      previous: summary.previous,
    },
  };
  return NextResponse.json(payload);
}
