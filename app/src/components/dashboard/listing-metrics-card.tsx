"use client";

import Link from "next/link";
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

/** After this many days without a new number, the card says Google has sent nothing new. */
const STALE_AFTER_DAYS = 10;

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** "6 November", with the year when it is not `today`'s. */
function dayLabel(key: string, today: Date): string {
  const [year, month, day] = key.split("-").map(Number);
  return `${day} ${MONTHS[month - 1]}${year === today.getFullYear() ? "" : ` ${year}`}`;
}

/** Whole days from `key` (YYYY-MM-DD) to the viewer's calendar day `today`. */
function daysSince(key: string, today: Date): number {
  const [year, month, day] = key.split("-").map(Number);
  return Math.round(
    (Date.UTC(today.getFullYear(), today.getMonth(), today.getDate()) - Date.UTC(year, month - 1, day)) / 86_400_000,
  );
}

/** The card itself, from the route's answer; nothing without a listing. */
export function ListingMetricsCardView({ listing, today }: { listing: Listing | null; today: Date }) {
  if (!listing) return null;
  const end = dayLabel(listing.endDay, today);
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">
          Google listing, {listing.windowDays} days to {end}
        </CardTitle>
        <CardDescription>
          From Google, for {listing.title}. Google&apos;s numbers arrive two to three days late.
        </CardDescription>
        {daysSince(listing.endDay, today) > STALE_AFTER_DAYS ? (
          <p className="text-sm text-warning-ontint">
            Google has sent no new numbers since {end}. Check the Google connection on the{" "}
            <Link href="/connections" className="underline">
              Connections page
            </Link>
            .
          </p>
        ) : null}
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

  return <ListingMetricsCardView listing={listing} today={new Date()} />;
}
