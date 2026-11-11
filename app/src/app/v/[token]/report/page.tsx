import type { Metadata } from "next";
import Link from "next/link";

import { ReportMonthPicker } from "@/components/reports/monthly-report";
import { PrintReportButton } from "@/components/reports/print-button";
import { parseReportMonth, reportMonths } from "@/lib/monthlyReport";
import { REVIEW_LINK_INACTIVE_MESSAGE } from "@/lib/reviewLink";
import { findActiveReviewLink } from "@/server/reviewLink";

import { ClientReportView } from "./client-report-view";

/**
 * /v/[token]/report?month=YYYY-MM — the monthly report through a client review
 * link (18a), signed out, no app shell (/v is public in proxy.ts and nav.ts).
 * Built as /v/[token] is: an unknown and a revoked link get the same single
 * sentence, and the report itself comes from GET
 * /api/review-link/[token]/report, which is rate limited and takes the
 * workspace from the link alone. The view is given the token and the month.
 */

interface ClientReportPageProps {
  params: Promise<{ token: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export const metadata: Metadata = {
  title: "Monthly report",
  robots: { index: false, follow: false },
  // The token is in the address: never pass it on to another site.
  referrer: "no-referrer",
};

export default async function ClientReportPage({ params, searchParams }: ClientReportPageProps) {
  const { token } = await params;
  const link = await findActiveReviewLink(token);

  if (!link) {
    return (
      <main className="min-h-screen bg-background px-4 py-8 text-foreground sm:py-10">
        <div className="mx-auto w-full max-w-2xl">
          <p className="text-base">{REVIEW_LINK_INACTIVE_MESSAGE}</p>
        </div>
      </main>
    );
  }

  const now = new Date();
  const { month } = await searchParams;
  const parsed = parseReportMonth(month, now);
  const months = reportMonths(now);

  return (
    <main className="min-h-screen bg-background px-4 py-8 text-foreground sm:py-10">
      <div className="mx-auto w-full max-w-2xl space-y-6">
        <div data-report-noprint className="space-y-4">
          <Link href={`/v/${token}`} className="text-sm underline">
            Back to upcoming posts
          </Link>
          <div className="flex flex-wrap items-end justify-between gap-3">
            <ReportMonthPicker months={months} selected={parsed.ok ? parsed.month : months[1]} />
            {parsed.ok ? <PrintReportButton /> : null}
          </div>
        </div>
        {parsed.ok ? (
          <ClientReportView token={token} month={parsed.month} />
        ) : (
          <p className="text-sm">{parsed.error}</p>
        )}
      </div>
    </main>
  );
}
