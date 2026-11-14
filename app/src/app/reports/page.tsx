import Link from "next/link";
import { redirect } from "next/navigation";

import { cn } from "@/lib/cn";
import { APP_PAGE_CLASS } from "@/lib/pageLayout";
import { MonthlyReportView, ReportMonthPicker } from "@/components/reports/monthly-report";
import { PrintReportButton } from "@/components/reports/print-button";
import { prisma } from "@/lib/db";
import { parseReportMonth, reportMonths } from "@/lib/monthlyReport";
import { getWorkspaceContext } from "@/lib/workspace";
import { planIncludes } from "@/lib/planFeatures";
import { buildMonthlyReport } from "@/server/reports/monthlyReport";

export const metadata = { title: "Reports | Vibe Socials" };

export const dynamic = "force-dynamic";

/**
 * /reports — the active workspace's monthly report (18a), for any member. The
 * month is in the address (?month=YYYY-MM) so a report can be bookmarked; the
 * workspace is only ever the signed-in member's active one, never the address.
 * The client sees the same report through their review link (/v/[token]/report).
 */

interface ReportsPageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function ReportsPage({ searchParams }: ReportsPageProps) {
  const context = await getWorkspaceContext();
  if (!context) {
    redirect(`/login?callbackUrl=${encodeURIComponent("/reports")}`);
  }

  const now = new Date();
  const { month } = await searchParams;
  const parsed = parseReportMonth(month, now);
  const months = reportMonths(now);
  const workspaceId = context.workspace.id;

  const report = parsed.ok ? await buildMonthlyReport(workspaceId, parsed.month, now) : null;
  // Owners only: whether a client link is on. The token is never read here.
  // P1: a link the plan pauses cannot be opened, so it is not mentioned.
  const hasClientLink =
    context.role === "owner" && planIncludes(context.workspace, "clientLinks")
      ? (await prisma.workspaceReviewLink.findFirst({
          where: { workspaceId, revokedAt: null },
          select: { id: true },
        })) !== null
      : false;

  return (
    <div className={cn(APP_PAGE_CLASS, "space-y-6")}>
      <div data-report-noprint className="print:hidden">
        <h1 className="text-2xl font-bold tracking-tight text-foreground">Reports</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          A month of posts and Google listing numbers for this workspace, ready to share or print.
        </p>
      </div>
      <div data-report-noprint className="flex flex-wrap items-end justify-between gap-3">
        <ReportMonthPicker months={months} selected={parsed.ok ? parsed.month : months[1]} />
        {report ? <PrintReportButton /> : null}
      </div>
      {hasClientLink ? (
        <p data-report-noprint className="text-sm text-muted-foreground">
          Your client can open this report from their link: it is the client review link in the{" "}
          <Link href="/queue" className="underline">
            Queue
          </Link>
          , with Reports at the top of their page.
        </p>
      ) : null}
      {report ? (
        <MonthlyReportView report={report} activityHref="/activity" titleAs="h2" />
      ) : (
        <p className="text-sm">{parsed.ok ? null : parsed.error}</p>
      )}
    </div>
  );
}
