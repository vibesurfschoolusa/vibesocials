import { RetryAfterError } from "inngest";

import { billingFieldsSelect, type BillingFields } from "@/lib/billing";
import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import { defaultReportMonth } from "@/lib/monthlyReport";
import { planIncludes } from "@/lib/planFeatures";
import { isRetryableEmailError, sendEmail } from "@/server/notifications/email";
import { buildMonthlyReportEmail } from "@/server/notifications/monthlyReportEmail";
import { buildMonthlyReport } from "@/server/reports/monthlyReport";

/**
 * The monthly report email (18b). The `monthly-report-email` cron runs on the
 * first three days of each month, one step each, and calls
 * runMonthlyReportEmails once.
 *
 * Workspace.monthlyReportSentFor holds the month (YYYY-MM) a workspace was
 * handled for, whether an email went out or nothing was published. A run takes
 * the workspaces whose marker differs from the month just ended, oldest first,
 * and stops starting new ones after MONTHLY_REPORT_RUN_BUDGET_MS; the next
 * day's run carries on. One the third run does not reach is skipped for that
 * month and logged as a count.
 *
 * The marker is written after a workspace's sends, so a crash between the two
 * sends again on the next attempt; the (workspace, month, owner) idempotency
 * key is what stops the duplicate. The job only reads and emails, so a paused
 * workspace still gets its report.
 *
 * P1: a workspace whose plan does not include the email (Starter, with billing
 * on) is marked for the month without building its report, so the next runs
 * pass it by. The plan columns come in the page query, only with billing on.
 */

/** A run stops starting workspaces after this long. */
export const MONTHLY_REPORT_RUN_BUDGET_MS = 150_000;
/**
 * Pause between two sends, the daily digest's (problemDigest.ts): Resend allows
 * 10 requests a second per team, shared with other mail. Kept as its own number,
 * not imported, so neither job's tests depend on the other's module.
 */
export const MONTHLY_REPORT_SEND_INTERVAL_MS = 600;
/** Wait before the one retry of a send that failed retryably, as the daily digest. */
const RETRY_DELAY_MS = 2_000;
/** The cron's last day of the month: what this run does not reach waits for next month's report. */
export const MONTHLY_REPORT_LAST_RUN_DAY = 3;
/** Workspaces read per query. */
const PAGE_SIZE = 50;

export interface MonthlyReportRunResult {
  /** Workspaces given their marker this run. */
  handled: number;
  /** Of those, the ones with nothing published in the month: no email. */
  nothingToReport: number;
  emailed: number;
  /** Sends that failed twice: counted, and the workspace marked anyway. */
  failed: number;
  /** Workspaces whose report could not be built: left unmarked for the next run. */
  errors: number;
  /** Workspaces not reached in this run's time. */
  left: number;
  /** P1: of those handled, the ones whose plan does not include the email: marked, no report built. */
  notIncluded: number;
}

/** The month a run on `now` reports on: the UTC calendar month before it. */
export function monthJustEnded(now: Date): string {
  return defaultReportMonth(now);
}

/**
 * How long to wait before the one retry, as the daily digest: a rate limit's
 * own delay, never more than RETRY_DELAY_MS so the step keeps its time.
 * The SDK stores the delay as whole seconds or as an ISO date.
 */
function retryDelayMs(error: unknown): number {
  if (!(error instanceof RetryAfterError)) return RETRY_DELAY_MS;
  const raw = error.retryAfter;
  const ms = /^\d+$/.test(raw) ? Number(raw) * 1000 : Date.parse(raw) - Date.now();
  if (!Number.isFinite(ms)) return RETRY_DELAY_MS;
  return Math.min(Math.max(ms, 0), RETRY_DELAY_MS);
}

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function runMonthlyReportEmails(
  opts: { now?: Date; clock?: () => number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<MonthlyReportRunResult> {
  const now = opts.now ?? new Date();
  const clock = opts.clock ?? Date.now;
  const sleep = opts.sleep ?? realSleep;
  const month = monthJustEnded(now);
  const deadline = clock() + MONTHLY_REPORT_RUN_BUDGET_MS;
  const appBaseUrl = process.env.NEXTAUTH_URL || null;

  // A plain `not` would leave out the never-handled workspaces (NULL).
  const pending = { OR: [{ monthlyReportSentFor: null }, { monthlyReportSentFor: { not: month } }] };
  const result: MonthlyReportRunResult = {
    handled: 0,
    nothingToReport: 0,
    emailed: 0,
    failed: 0,
    errors: 0,
    left: 0,
    notIncluded: 0,
  };
  let sentAny = false;
  let after: { createdAt: Date; id: string } | null = null;
  let outOfTime = false;

  while (!outOfTime) {
    const page: ({ id: string; createdAt: Date } & BillingFields)[] = await prisma.workspace.findMany({
      where: after
        ? {
            ...pending,
            AND: [{ OR: [{ createdAt: { gt: after.createdAt } }, { createdAt: after.createdAt, id: { gt: after.id } }] }],
          }
        : pending,
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: PAGE_SIZE,
      select: { id: true, createdAt: true, ...billingFieldsSelect() },
    });

    for (const workspace of page) {
      if (clock() >= deadline) {
        outOfTime = true;
        break;
      }
      after = { createdAt: workspace.createdAt, id: workspace.id };
      const workspaceId = workspace.id;

      if (!planIncludes(workspace, "monthlyReportEmail", process.env, now)) {
        await prisma.workspace.updateMany({ where: { id: workspaceId }, data: { monthlyReportSentFor: month } });
        result.notIncluded++;
        result.handled++;
        continue;
      }

      let report;
      try {
        report = await buildMonthlyReport(workspaceId, month, now);
      } catch (error) {
        result.errors++;
        logger.error("[monthly-report] Couldn't build a report; the next run tries again", { workspaceId, error });
        continue;
      }

      if (report.postCount > 0) {
        const [owners, link] = await Promise.all([
          prisma.workspaceMember.findMany({
            where: { workspaceId, role: "owner", user: { notifyMonthlyReport: true } },
            orderBy: { userId: "asc" },
            select: { userId: true, user: { select: { email: true } } },
          }),
          // Whether a client link is on; the token is never read.
          prisma.workspaceReviewLink.findFirst({
            where: { workspaceId, revokedAt: null },
            select: { id: true },
          }),
        ]);
        const email = buildMonthlyReportEmail({ report, appBaseUrl, hasClientLink: link !== null });

        for (const owner of owners) {
          if (sentAny) await sleep(MONTHLY_REPORT_SEND_INTERVAL_MS);
          sentAny = true;
          const send = () =>
            sendEmail(
              { to: owner.user.email, ...email },
              { idempotencyKey: `monthly-report/${workspaceId}/${month}/${owner.userId}`, throwOnRetryable: true },
            );
          try {
            try {
              await send();
            } catch (error) {
              if (!isRetryableEmailError(error)) throw error;
              await sleep(retryDelayMs(error));
              await send();
            }
            result.emailed++;
          } catch (error) {
            // Not worth holding the other workspaces for: counted and passed.
            result.failed++;
            logger.error("[monthly-report] Couldn't send one report email; carrying on", {
              error,
              workspaceId,
              userId: owner.userId,
            });
          }
        }
      } else {
        result.nothingToReport++;
      }

      await prisma.workspace.updateMany({ where: { id: workspaceId }, data: { monthlyReportSentFor: month } });
      result.handled++;
    }

    if (page.length < PAGE_SIZE) break;
  }

  if (outOfTime) {
    result.left = await prisma.workspace.count({ where: pending });
    if (now.getUTCDate() >= MONTHLY_REPORT_LAST_RUN_DAY) {
      logger.warn("[monthly-report] Workspaces not reached by the last run are skipped for the month", {
        month,
        count: result.left,
      });
    }
  }

  logger.info("[monthly-report] Run complete", { month, ...result });
  return result;
}
