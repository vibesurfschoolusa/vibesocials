import { RetryAfterError } from "inngest";

import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import { isRetryableEmailError, sendEmail } from "@/server/notifications/email";

import { buildTrialEndedEmail, buildTrialEndingEmail } from "./billingEmails";

/**
 * The trial emails (21b), run once a day by the `billing-reminders` cron in
 * one step. Owners of a workspace whose trial ends within 3 days get one
 * reminder (marked by trialReminderSentAt); owners of one whose trial ended
 * get one notice (trialEndedEmailSentAt). Only workspaces with no plan and not
 * exempt by their flag. A marker is set once every owner's send went out, so
 * a failed one is tried again the next day; the idempotency key per
 * workspace, owner and kind stops a re-run of the step sending twice.
 *
 * Bounded and paced as the daily problems email is (problemDigest.ts), so the
 * step fits Vercel's limit even when every send fails retryably.
 */

export const TRIAL_REMINDER_LEAD_MS = 3 * 24 * 60 * 60 * 1000;
/** Pause between two sends: Resend allows 10 requests a second, shared with other mail. */
export const REMINDER_SEND_INTERVAL_MS = 600;
/** Wait before the one retry of a send that failed retryably and carried no usable delay. */
export const REMINDER_RETRY_DELAY_MS = 2_000;
/** Per run, as DIGEST_MAX_EMAILS_PER_RUN: 40 x 4.6 s worst case fits one step. */
export const REMINDER_MAX_EMAILS_PER_RUN = 40;

export type BillingReminderSummary = {
  /** Workspaces found for each kind this run (at most the cap plus one). */
  trialEnding: number;
  trialEnded: number;
  sent: number;
  failed: number;
  /** Workspaces found but not reached because of the cap. */
  left: number;
};

type Kind = "trial-ending" | "trial-ended";

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** The delay a RetryAfterError carries (whole seconds or an ISO date), capped so the step keeps its time. */
function retryDelayMs(error: unknown): number {
  if (!(error instanceof RetryAfterError)) return REMINDER_RETRY_DELAY_MS;
  const raw = error.retryAfter;
  const ms = /^\d+$/.test(raw) ? Number(raw) * 1000 : Date.parse(raw) - Date.now();
  if (!Number.isFinite(ms)) return REMINDER_RETRY_DELAY_MS;
  return Math.min(Math.max(ms, 0), REMINDER_RETRY_DELAY_MS);
}

const SELECT = {
  id: true,
  name: true,
  trialEndsAt: true,
  members: { where: { role: "owner" as const }, select: { userId: true, user: { select: { email: true } } } },
};

export async function runBillingReminders(
  now: Date,
  deps: { sleep?: (ms: number) => Promise<void> } = {},
): Promise<BillingReminderSummary> {
  const sleep = deps.sleep ?? defaultSleep;
  const take = REMINDER_MAX_EMAILS_PER_RUN + 1;
  const base = { billingExempt: false, plan: null };

  const [ending, ended] = await Promise.all([
    prisma.workspace.findMany({
      where: { ...base, trialEndsAt: { gt: now, lte: new Date(now.getTime() + TRIAL_REMINDER_LEAD_MS) }, trialReminderSentAt: null },
      select: SELECT,
      orderBy: { id: "asc" },
      take,
    }),
    prisma.workspace.findMany({
      where: { ...base, trialEndsAt: { lte: now }, trialEndedEmailSentAt: null },
      select: SELECT,
      orderBy: { id: "asc" },
      take,
    }),
  ]);

  const work: Array<{ kind: Kind; workspace: (typeof ending)[number] }> = [
    ...ending.map((workspace) => ({ kind: "trial-ending" as const, workspace })),
    ...ended.map((workspace) => ({ kind: "trial-ended" as const, workspace })),
  ];

  let sent = 0;
  let failed = 0;
  let left = 0;
  let first = true;
  for (const [index, { kind, workspace }] of work.entries()) {
    if (sent + failed + workspace.members.length > REMINDER_MAX_EMAILS_PER_RUN) {
      left = work.length - index;
      break;
    }

    const email =
      kind === "trial-ending"
        ? buildTrialEndingEmail({ workspaceName: workspace.name, trialEndsAt: workspace.trialEndsAt! })
        : buildTrialEndedEmail({ workspaceName: workspace.name });

    let allSent = true;
    for (const owner of workspace.members) {
      if (!first) await sleep(REMINDER_SEND_INTERVAL_MS);
      first = false;
      const send = () =>
        sendEmail(
          { to: owner.user.email, ...email },
          { idempotencyKey: `billing/${kind}/${workspace.id}/${owner.userId}`, throwOnRetryable: true },
        );
      try {
        try {
          await send();
        } catch (error) {
          if (!isRetryableEmailError(error)) throw error;
          await sleep(retryDelayMs(error));
          await send();
        }
        sent++;
      } catch (error) {
        failed++;
        allSent = false;
        logger.error("[billing] Couldn't send one trial email; trying again tomorrow", {
          kind,
          workspaceId: workspace.id,
          userId: owner.userId,
          error: error instanceof Error ? error.name : typeof error,
        });
      }
    }

    if (allSent) {
      await prisma.workspace.update({
        where: { id: workspace.id },
        data: kind === "trial-ending" ? { trialReminderSentAt: now } : { trialEndedEmailSentAt: now },
      });
    }
  }

  if (left > 0) {
    logger.warn("[billing] Trial email cap reached; the rest go out tomorrow", { cap: REMINDER_MAX_EMAILS_PER_RUN, left });
  }
  return { trialEnding: ending.length, trialEnded: ended.length, sent, failed, left };
}
