import type { Metadata } from "next";
import Link from "next/link";

import { ClientPageShell } from "@/components/client-page-header";
import { ReportMonthPicker } from "@/components/reports/monthly-report";
import { PrintReportButton } from "@/components/reports/print-button";
import { findClientPageLogo } from "@/lib/clientPageLogo";
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
      <ClientPageShell workspace={null} width="2xl">
        <p className="text-base">{REVIEW_LINK_INACTIVE_MESSAGE}</p>
      </ClientPageShell>
    );
  }

  const logoUrl = await findClientPageLogo(link.workspaceId);
  const now = new Date();
  const { month } = await searchParams;
  const parsed = parseReportMonth(month, now);
  const months = reportMonths(now);

  // No title in the header: the report carries its own, with the month. The
  // header is a <header>, which the print sheet hides.
  return (
    <ClientPageShell workspace={{ name: link.workspaceName, logoUrl }} width="2xl">
      <div className="space-y-6">
        <div data-report-noprint className="space-y-4">
          <Link href={`/v/${token}`} className="inline-flex min-h-10 items-center text-sm underline">
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
    </ClientPageShell>
  );
}
