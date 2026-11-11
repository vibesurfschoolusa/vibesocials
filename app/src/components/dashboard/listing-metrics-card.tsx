"use client";

import { useEffect, useState } from "react";

import type { ListingMetricsResponse } from "@/app/api/insights/listing-metrics/route";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { describeListingChange, type ListingMetricTotals } from "@/lib/listingMetrics";

type Listing = NonNullable<ListingMetricsResponse["listing"]>;

const NUMBERS: Array<{ key: keyof ListingMetricTotals; label: string }> = [
  { key: "views", label: "Views" },
  { key: "calls", label: "Calls" },
  { key: "directionRequests", label: "Direction requests" },
  { key: "websiteClicks", label: "Website clicks" },
];

/** The card itself, from the route's answer; nothing without a listing. */
export function ListingMetricsCardView({ listing }: { listing: Listing | null }) {
  if (!listing) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Google listing, last {listing.windowDays} days</CardTitle>
        <CardDescription>
          From Google, for {listing.title}. Google&apos;s numbers arrive two to three days late.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <dl className="grid grid-cols-2 gap-4">
          {NUMBERS.map(({ key, label }) => {
            const change = describeListingChange(listing.current[key], listing.previous?.[key] ?? null);
            return (
              <div key={key} className="space-y-0.5">
                <dt className="text-xs text-muted-foreground">{label}</dt>
                <dd className="text-2xl font-semibold tabular-nums tracking-tight text-foreground">
                  {listing.current[key].toLocaleString("en-US")}
                </dd>
                {change ? <dd className="text-xs text-muted-foreground">{change}</dd> : null}
              </div>
            );
          })}
        </dl>
      </CardContent>
    </Card>
  );
}

/**
 * Dashboard card with the Google listing's views, calls, direction requests and
 * website clicks. Renders nothing until the workspace has a chosen listing with
 * a stored day, and nothing on a failed fetch: like publish health, it is
 * supplementary.
 */
export function ListingMetricsCard() {
  const [listing, setListing] = useState<Listing | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch("/api/insights/listing-metrics");
        if (!response.ok) return;
        const payload: ListingMetricsResponse = await response.json();
        if (!cancelled) setListing(payload.listing);
      } catch {
        // Supplementary card: stay silent and render nothing.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return <ListingMetricsCardView listing={listing} />;
}
