"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

import { withWorkspaceId } from "@/lib/workspaceChanged";
import {
  AlertTriangle,
  CalendarClock,
  CalendarPlus,
  ChevronRight,
  MapPin,
  MessageSquare,
  Star,
  UserCheck,
  type LucideIcon,
} from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  CHECKING_REVIEWS_TEXT,
  needsYouHeading,
  needsYouRows,
  needsYouView,
  reviewsNeedingReply,
  type DashboardSummary,
  type NeedsYouRowKind,
} from "@/lib/needsYou";

const ICONS: Record<NeedsYouRowKind, LucideIcon> = {
  google_location: MapPin,
  reviews: Star,
  problems: AlertTriangle,
  approvals: UserCheck,
  client_changes: MessageSquare,
  next_post: CalendarClock,
  add_many: CalendarPlus,
};

/**
 * The dashboard's "Needs you" card (N1). Mounted once the dashboard's
 * connections fetch has finished; if it failed, a Retry may bring the Google
 * listing later, and the reviews call starts then. Both fetches run at most
 * once per visit and are never polled. The reviews call
 * reaches Google, which is why it has no retry; any failure there just leaves
 * its row out. Both send the workspace the page was drawn for (R32), so a
 * tab left on it after another tab switched gets nothing, not the other's counts.
 */
export function NeedsYou({
  workspaceId,
  hasGoogleListing: googleNow,
}: {
  workspaceId: string | null;
  hasGoogleListing: boolean;
}) {
  // Latched: true from the first render that has the listing (at mount, or after
  // the Connections card's Retry, R35 new-customer L2), never false again, so a
  // later connections reload starts no second Google call.
  const [hasGoogleListing, setHasGoogleListing] = useState(googleNow);
  if (googleNow && !hasGoogleListing) setHasGoogleListing(true);
  // R36 client-journey L1: only a reviews call started at mount shows the
  // skeleton; a later one keeps the loaded card.
  const [askedAtMount] = useState(googleNow);
  const [summary, setSummary] = useState<DashboardSummary | null>(null);
  const [failed, setFailed] = useState(false);
  const [reviews, setReviews] = useState<number | null>(null);
  const [reviewsSettled, setReviewsSettled] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch(withWorkspaceId("/api/dashboard/summary", workspaceId))
      .then(async (response) => {
        if (!response.ok) throw new Error("summary");
        const body = (await response.json()) as DashboardSummary;
        if (!cancelled) setSummary(body);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  useEffect(() => {
    if (!hasGoogleListing) return;
    let cancelled = false;
    fetch(withWorkspaceId("/api/reviews", workspaceId))
      .then(async (response) => {
        if (!response.ok) return;
        const count = reviewsNeedingReply(await response.json());
        if (!cancelled) setReviews(count);
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setReviewsSettled(true);
      });
    return () => {
      cancelled = true;
    };
  }, [hasGoogleListing, workspaceId]);

  const view = needsYouView({
    summary: failed ? "failed" : summary ? "loaded" : "loading",
    reviews: !hasGoogleListing ? "not_asked" : reviewsSettled ? "settled" : askedAtMount ? "pending" : "checking",
  });
  const loadingShown = view !== "nothing" && (view === "skeleton" || !summary);
  // Only owners get a number for approvals; the server sends null to a member.
  const card =
    view === "nothing" || loadingShown || !summary
      ? null
      : needsYouRows(summary, reviews, summary.awaitingYourApproval === null ? "member" : "owner");
  const checking = view === "checking";
  const heading = card && (view === "card" || view === "checking") ? needsYouHeading(card, view) : null;

  // R30 PP2: the loading line is outside the views, on the page from the
  // first render; only its text changes.
  return (
    <>
      <p role="status" className="sr-only">
        {loadingShown ? "Loading what needs you…" : checking && card ? CHECKING_REVIEWS_TEXT : ""}
      </p>
      {loadingShown ? (
        <Card>
          <CardHeader>
            <Skeleton className="h-5 w-32" aria-hidden />
          </CardHeader>
          <CardContent className="space-y-2" aria-hidden>
            <Skeleton className="h-7 w-full" />
            <Skeleton className="h-7 w-3/4" />
          </CardContent>
        </Card>
      ) : card ? (
        <Card>
          <CardHeader>
            {heading ? <CardTitle className="text-base">{heading}</CardTitle> : null}
            {/* Read out by the status line above; shown here as the quiet stand-in. */}
            {checking ? (
              <p aria-hidden className="text-sm text-muted-foreground">
                {CHECKING_REVIEWS_TEXT}
              </p>
            ) : null}
          </CardHeader>
          <CardContent>
            <ul className="-mx-2 space-y-1">
              {card.rows.map((row) => {
                const Icon = ICONS[row.kind];
                return (
                  <li key={row.kind}>
                    <Link
                      href={row.href}
                      className="flex items-center gap-3 rounded-md px-2 py-2 text-sm text-foreground hover:bg-muted"
                    >
                      <Icon aria-hidden className="h-4 w-4 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 flex-1">{row.text}</span>
                      <ChevronRight aria-hidden className="h-4 w-4 shrink-0 text-muted-foreground" />
                    </Link>
                  </li>
                );
              })}
            </ul>
          </CardContent>
        </Card>
      ) : null}
    </>
  );
}
