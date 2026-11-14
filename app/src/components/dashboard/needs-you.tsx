"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  AlertTriangle,
  CalendarClock,
  CalendarPlus,
  ChevronRight,
  MessageSquare,
  Star,
  UserCheck,
  type LucideIcon,
} from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  needsYouRows,
  reviewsNeedingReply,
  type DashboardSummary,
  type NeedsYouRowKind,
} from "@/lib/needsYou";

const ICONS: Record<NeedsYouRowKind, LucideIcon> = {
  reviews: Star,
  problems: AlertTriangle,
  approvals: UserCheck,
  client_changes: MessageSquare,
  next_post: CalendarClock,
  add_many: CalendarPlus,
};

/**
 * The dashboard's "Needs you" card (N1). Mounted only once the dashboard knows
 * its connections, so `hasGoogleListing` is settled on mount: both fetches run
 * once per visit and are never polled. The reviews call reaches Google, which
 * is why it has no retry; any failure there just leaves its row out.
 */
export function NeedsYou({ hasGoogleListing }: { hasGoogleListing: boolean }) {
  const [summary, setSummary] = useState<DashboardSummary | null>(null);
  const [failed, setFailed] = useState(false);
  const [reviews, setReviews] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/dashboard/summary")
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
  }, []);

  useEffect(() => {
    if (!hasGoogleListing) return;
    let cancelled = false;
    fetch("/api/reviews")
      .then(async (response) => {
        if (!response.ok) return;
        const count = reviewsNeedingReply(await response.json());
        if (!cancelled) setReviews(count);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [hasGoogleListing]);

  if (failed) return null;

  if (!summary) {
    return (
      <Card>
        <CardHeader>
          <Skeleton className="h-5 w-32" aria-hidden />
        </CardHeader>
        <CardContent className="space-y-2" aria-hidden>
          <Skeleton className="h-7 w-full" />
          <Skeleton className="h-7 w-3/4" />
        </CardContent>
        <p role="status" className="sr-only">Loading what needs you…</p>
      </Card>
    );
  }

  // Only owners get a number for approvals; the server sends null to a member.
  const role = summary.awaitingYourApproval === null ? "member" : "owner";
  const card = needsYouRows(summary, reviews, role);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{card.title}</CardTitle>
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
  );
}
