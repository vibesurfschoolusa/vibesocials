import { RetryAfterError } from "inngest";

import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import { isRetryableEmailError, sendEmailOutcome, type SendEmailOutcome } from "@/server/notifications/email";
import { sendOncePer } from "@/server/notifications/onceADay";

import { buildTrialEndedEmail, buildTrialEndingEmail } from "./billingEmails";

/**
 * The trial emails (21b), run once a day by the `billing-reminders` cron in
 * one step. Owners of a workspace whose trial ends within 3 days get one
 * reminder (marked by trialReminderSentAt); owners of one whose trial ended
 * get one notice (trialEndedEmailSentAt). Only workspaces with no plan, not
 * exempt by their flag, and used (a connection or a post). Each owner's send
 * goes through sendOncePer, claimed until the trial date (R40 security L3), so
 * an owner already reached is skipped when a co-owner's failed send is tried
 * again the next day. An owner counts as reached only when Resend took the
 * email. The workspace marker is set once every owner is reached; the
 * idempotency key per workspace, owner, kind and trial date stops a re-run of
 * the step sending twice. The operator's change of the trial date clears both
 * markers (admin/actions.ts), so a new date gets its own emails.
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
/**
 * How long a reached owner is skipped for the trial-ended notice, whose trial
 * date has passed: the claim is set on the first try and outlasts any spell
 * of failed sends to a co-owner.
 */
export const TRIAL_ENDED_CLAIM_MS = 30 * 24 * 60 * 60 * 1000;
/**
 * R41 lead review: the trial-ended notice is for a trial that ended in the
 * last 30 days. Past that it is news to nobody, and an owner never reached
 * would otherwise be tried every day for good.
 */
export const TRIAL_ENDED_NOTICE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

export type BillingReminderSummary = {
  /** Workspaces found for each kind this run (at most the cap plus one). */
  trialEnding: number;
  trialEnded: number;
  sent: number;
  failed: number;
  /** Owners whose email Resend refused for good (a 4xx such as 422): not tried again. */
  refused: number;
  /** Workspaces found but not reached because of the cap. */
  left: number;
};

type Kind = "trial-ending" | "trial-ended";

const KINDS: readonly Kind[] = ["trial-ending", "trial-ended"];

/** One owner's claim on one kind of trial email for one trial date. */
function ownerClaimKey(kind: Kind, workspaceId: string, userId: string, trialEndsAt: Date): string {
  return `${ownerClaimPrefix(kind, workspaceId)}${userId}:${trialEndsAt.toISOString()}`;
}

function ownerClaimPrefix(kind: Kind, workspaceId: string): string {
  return `billing-owner:${kind}:${workspaceId}:`;
}

/**
 * R41 lead review: every owner claim on this workspace's trial emails, for
 * every date. admin/actions.ts deletes them with the markers when the trial
 * date changes, so a date put back (A, B, then A) gets A's emails again.
 */
export function trialEmailClaimsWhere(workspaceId: string) {
  return { OR: KINDS.map((kind) => ({ key: { startsWith: ownerClaimPrefix(kind, workspaceId) } })) };
}

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
  members: { where: { role: "owner" as const }, select: { userId: true, user: { select: { email: true, timeZone: true } } } },
};

export async function runBillingReminders(
  now: Date,
  deps: { sleep?: (ms: number) => Promise<void> } = {},
): Promise<BillingReminderSummary> {
  const sleep = deps.sleep ?? defaultSleep;
  const take = REMINDER_MAX_EMAILS_PER_RUN + 1;
  // Only a workspace someone uses: every registration makes one, so a person who
  // signed up only to join another workspace by invite would otherwise be told
  // about a trial they never started using. Filtered in the query, and the
  // markers stay null, so a workspace used later can still get what applies then.
  const base = {
    billingExempt: false,
    plan: null,
    OR: [{ connections: { some: {} } }, { postJobs: { some: {} } }],
  };

  const [ending, ended] = await Promise.all([
    prisma.workspace.findMany({
      where: { ...base, trialEndsAt: { gt: now, lte: new Date(now.getTime() + TRIAL_REMINDER_LEAD_MS) }, trialReminderSentAt: null },
      select: SELECT,
      orderBy: { id: "asc" },
      take,
    }),
    prisma.workspace.findMany({
      where: {
        ...base,
        trialEndsAt: { gt: new Date(now.getTime() - TRIAL_ENDED_NOTICE_WINDOW_MS), lte: now },
        trialEndedEmailSentAt: null,
      },
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
  let refused = 0;
  let left = 0;
  let first = true;
  for (const [index, { kind, workspace }] of work.entries()) {
    if (sent + failed + refused + workspace.members.length > REMINDER_MAX_EMAILS_PER_RUN) {
      left = work.length - index;
      break;
    }

    let allSent = true;
    for (const owner of workspace.members) {
      // Per owner (R3-pages L1): the end time is shown in that owner's time zone.
      const email =
        kind === "trial-ending"
          ? buildTrialEndingEmail({
              workspaceId: workspace.id,
              workspaceName: workspace.name,
              trialEndsAt: workspace.trialEndsAt!,
              timeZone: owner.user.timeZone,
            })
          : buildTrialEndedEmail({ workspaceId: workspace.id, workspaceName: workspace.name });
      const trialEndsAt = workspace.trialEndsAt!;
      // R41 security L2: keyed with the trial date, as the claim is, so a date
      // the operator changes within 24 h of a send is a new email, not Resend's
      // 409 for a reused key with a new body (which counts as sent).
      const send = () =>
        sendEmailOutcome(
          { to: owner.user.email, ...email },
          {
            idempotencyKey: `billing/${kind}/${workspace.id}/${owner.userId}/${trialEndsAt.toISOString()}`,
            throwOnRetryable: true,
          },
        );
      let refusedForGood = false;
      const outcome = await sendOncePer(
        {
          key: ownerClaimKey(kind, workspace.id, owner.userId, trialEndsAt),
          resetAt: kind === "trial-ending" ? trialEndsAt : new Date(now.getTime() + TRIAL_ENDED_CLAIM_MS),
          // No per-recipient keys over this window, so a store error never sends.
          keysFrom: null,
        },
        // sendStarted is not called: a failed owner is tried again the next day,
        // as before; only owners already reached are skipped.
        async () => {
          if (!first) await sleep(REMINDER_SEND_INTERVAL_MS);
          first = false;
          // R41 security L1: the send's own answer, so an email Resend didn't
          // take fails and is tried tomorrow (a quota 429, no key or a bad key).
          // R41 lead review: one Resend refused for good (a 4xx such as 422)
          // answers true here only so sendOncePer keeps the claim and that
          // owner is not tried again; it is counted as refused, never sent.
          let answer: SendEmailOutcome;
          try {
            answer = await send();
          } catch (error) {
            if (!isRetryableEmailError(error)) throw error;
            await sleep(retryDelayMs(error));
            answer = await send();
          }
          refusedForGood = !answer.sent && answer.reason === "refused";
          return answer.sent || refusedForGood;
        },
        (error) =>
          logger.error("[billing] Couldn't send one trial email; trying again tomorrow", {
            kind,
            workspaceId: workspace.id,
            userId: owner.userId,
            error: error instanceof Error ? error.name : typeof error,
          }),
      );
      if (outcome === "sent" && refusedForGood) {
        refused++;
        logger.warn("[billing] Resend refused one trial email for good; not tried again", {
          kind,
          workspaceId: workspace.id,
          userId: owner.userId,
        });
      } else if (outcome === "sent") sent++;
      if (outcome === "failed") {
        failed++;
        allSent = false;
      }
    }

    if (allSent) {
      // R41 lead review: only for the date this run read. One the operator
      // changed meanwhile (markers and claims cleared) keeps its marker clear,
      // so the new date's email still goes.
      await prisma.workspace.updateMany({
        where: { id: workspace.id, trialEndsAt: workspace.trialEndsAt! },
        data: kind === "trial-ending" ? { trialReminderSentAt: now } : { trialEndedEmailSentAt: now },
      });
    }
  }

  if (left > 0) {
    logger.warn("[billing] Trial email cap reached; the rest go out tomorrow", { cap: REMINDER_MAX_EMAILS_PER_RUN, left });
  }
  return { trialEnding: ending.length, trialEnded: ended.length, sent, failed, refused, left };
}
