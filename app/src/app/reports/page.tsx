import Link from "next/link";
import { redirect } from "next/navigation";

import { MonthlyReportView, ReportMonthPicker } from "@/components/reports/monthly-report";
import { PrintReportButton } from "@/components/reports/print-button";
import { prisma } from "@/lib/db";
import { parseReportMonth, reportMonths } from "@/lib/monthlyReport";
import { getWorkspaceContext } from "@/lib/workspace";
import { planIncludes } from "@/lib/planFeatures";
import { buildMonthlyReport } from "@/server/reports/monthlyReport";

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
    <div className="mx-auto w-full max-w-3xl space-y-6 px-4 py-6 md:px-6">
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
        <MonthlyReportView report={report} activityHref="/activity" />
      ) : (
        <p className="text-sm">{parsed.ok ? null : parsed.error}</p>
      )}
    </div>
  );
}
