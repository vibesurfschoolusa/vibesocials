import type { Platform, PostJobResultStatus, PostJobStatus } from "@prisma/client";

import { prisma } from "@/lib/db";
import { platformLabel } from "@/lib/platforms";
import { PUBLISH_UNCONFIRMED_CODE, PUBLISH_UNCONFIRMED_MESSAGE } from "@/lib/publishOutcomes";
import { failedRowStep, needsReconnecting } from "@/lib/retryAll";
import { sentenceForRecipient } from "@/lib/publishFailureText";
import { storyPlatformsOf } from "@/lib/storyPlacement";
import { WORKSPACE_PAUSED_CODE } from "@/lib/workspaceStatus";
import { PUBLISH_STALLED_FAILURE } from "@/server/jobs/failPendingResults";
import { isRetryableEmailError, sendEmail } from "@/server/notifications/email";
import { emailSettingsLine, workspaceLink } from "@/server/notifications/links";

/**
 * Roadmap Phase 6 — post-outcome notification email (spec §7.2).
 *
 * A scheduled post can fire unattended (e.g. 3am) and silently fail on a
 * platform, so when a PostJob reaches a terminal state we email the owner its
 * per-platform outcome. Split into pure/impure halves so the decision and
 * content logic are unit-testable without a database or network:
 *  - `shouldSendPostOutcomeEmail` decides WHETHER to send (pure).
 *  - `buildPostOutcomeEmail` decides WHAT to send (pure).
 *  - `deliverPostOutcomeNotification` is the impure orchestrator the
 *    `sendNotification` Inngest function calls: it re-fetches fresh data from
 *    just `{ userId, postJobId }` (never trusts anything beyond those ids —
 *    see inngest-functions.ts), applies the two pure helpers, and calls
 *    `sendEmail`. It never throws except for a RETRYABLE delivery failure
 *    (a Resend 429 / 5xx / network error): every other branch is a clean early
 *    return or a caught error, so a bad notification can never affect the
 *    publish/retry job that already completed before this runs.
 */

export interface ShouldSendPostOutcomeEmailParams {
  /** Whether `RESEND_API_KEY` is configured (env-level kill switch). */
  hasApiKey: boolean;
  /** The user's `notifyOnPostComplete` preference. */
  pref: boolean;
  /** Whether the user record (and thus a delivery address) exists. */
  hasEmail: boolean;
}

/**
 * Pure decision of whether a post-outcome email should be attempted. All
 * three gates are independent and required. It's a plain AND, but named and
 * exported so the "why" (env kill switch / user preference / user exists) is
 * legible at call sites and unit-testable without a database. Folding a
 * missing user into `hasEmail: false` means callers don't need a separate
 * `!user` branch — see `deliverPostOutcomeNotification`.
 */
export function shouldSendPostOutcomeEmail({
  hasApiKey,
  pref,
  hasEmail,
}: ShouldSendPostOutcomeEmailParams): boolean {
  return hasApiKey && pref && hasEmail;
}

/** Minimal, DTO-safe per-platform outcome — no tokens, no connection ids. */
export interface PostOutcomeResultSummary {
  platform: Platform;
  status: PostJobResultStatus;
  /** Internal code, read only to word a stalled or unconfirmed row (R27 MM4). */
  errorCode?: string | null;
  errorMessage?: string | null;
  /** A success's note (a chosen cover the platform did not take), shown after "Succeeded". */
  note?: string | null;
  /** A stalled row's connection needs reconnecting (or is gone), read when the email is sent. */
  needsReconnect?: boolean;
  /** Sent as a Story: the row reads "Instagram Story" (R5-client-journey L3). */
  story?: boolean;
  /**
   * Still pending on a job that was closed (the stale sweep fails a job whose run
   * never got to it): it was never sent, and counts as not published.
   */
  notSent?: boolean;
}

export interface BuildPostOutcomeEmailParams {
  results: PostOutcomeResultSummary[];
  /**
   * PostJob.status. Optional and consulted ONLY by the zero-results branch
   * below (Task 9: a scheduled post that fires with no eligible connections
   * is marked `failed` with zero PostJobResult rows) — every other branch is
   * derived purely from `results`, so existing callers that never pass it
   * keep the pre-existing neutral "finished processing" behavior.
   */
  status?: PostJobStatus;
  /** `process.env.NEXTAUTH_URL`. Omit/null to render the email with no link. */
  appBaseUrl?: string | null;
  /** The post's workspace: its links open it (/go), and its name is in the subject. */
  workspaceId: string;
  workspaceName: string;
  /** The post's caption; the email quotes its start so the owner knows which post it was. */
  caption: string;
  /** The scanner's once-a-day notice (scannerNotice.ts): adds {@link SCAN_NOTICE_ONCE_A_DAY_LINE}. */
  scanNotice?: boolean;
  /** Who reads it: a member is told the owner can reconnect (R9-client-journey L4). */
  recipientRole?: "owner" | "member";
}

export interface PostOutcomeEmail {
  subject: string;
  html: string;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * R9-pages L6 / client-journey L2: the scanner sends one such email per
 * workspace, recipient and reason a day, so it says the others are in Activity.
 */
export const SCAN_NOTICE_ONCE_A_DAY_LINE =
  "If more posts can't be sent today for the same reason, you won't get another email; Activity lists them.";

/** Characters of the caption the email quotes (F4: instead of the internal id). */
export const POST_OUTCOME_CAPTION_CHARS = 80;

/** The first `max` characters, counted by code point so an emoji is never split. */
function captionExcerpt(caption: string): string {
  const chars = Array.from(caption.trim().replace(/\s+/g, " "));
  return chars.length <= POST_OUTCOME_CAPTION_CHARS
    ? chars.join("")
    : `${chars.slice(0, POST_OUTCOME_CAPTION_CHARS).join("")}…`;
}

/** A subject is plain text on one line. */
function oneLine(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

function buildHeadline(results: readonly PostOutcomeResultSummary[]): string {
  const total = results.length;
  const succeededCount = results.filter((r) => r.status === "success").length;
  const failedCount = results.filter((r) => r.status === "failed" || r.notSent).length;
  if (total === 0) return "Your post has finished processing";
  const stories = results.filter((r) => r.story).length;
  // A Feed and Story pair: its rows are feed posts and Stories, not platforms.
  if (stories > 0 && stories < total) {
    if (failedCount === 0) return "Your post and Story published successfully";
    if (succeededCount === 0) return "Your post and Story failed to publish";
    return `Your post and Story finished: ${succeededCount} of ${total} succeeded`;
  }
  const subject = stories === total ? "Your Story" : "Your post";
  if (failedCount === 0) {
    return total === 1
      ? `${subject} published successfully`
      : `${subject} published successfully to all ${total} platforms`;
  }
  if (succeededCount === 0) {
    return total === 1
      ? `${subject} failed to publish`
      : `${subject} failed to publish to all ${total} platforms`;
  }
  return `${subject} finished: ${succeededCount} of ${total} platforms succeeded`;
}

// Field-by-field rendering (never a blanket JSON.stringify of `result`) so a
// result object that happens to carry extra runtime fields beyond this
// module's DTO type can never leak into the email body.
function renderResultRow(result: PostOutcomeResultSummary, recipientRole: "owner" | "member"): string {
  const label = escapeHtml(`${platformLabel(result.platform)}${result.story ? " Story" : ""}`);
  const stopped = `Not sent — publishing stopped before it reached ${escapeHtml(platformLabel(result.platform))}.`;
  // R27 MM4: the stale sweep now marks a closed job's pending rows (stalled, or
  // unconfirmed when a step had claimed them), so a row still pending is one a
  // job closed before that; Activity offers it no control, so none is named.
  if (result.notSent) {
    return `<li>${label}: ${stopped} Open the post in Activity to see where it stands.</li>`;
  }
  // The card's rule (lib/retryAll.ts failedRowStep): an unconfirmed row may
  // already be live, so the platform is checked first; a stalled one never
  // reached the platform and is retried, after a reconnect when it needs one.
  const unconfirmed = result.status === "failed" && result.errorCode === PUBLISH_UNCONFIRMED_CODE;
  if (unconfirmed || (result.status === "failed" && result.errorCode === PUBLISH_STALLED_FAILURE.errorCode)) {
    const step = failedRowStep({ unconfirmed }, result.needsReconnect === true);
    if (step === "check_platform") return `<li>${label}: ${escapeHtml(PUBLISH_UNCONFIRMED_MESSAGE)}</li>`;
    const name = escapeHtml(platformLabel(result.platform));
    if (step === "retry") return `<li>${label}: ${stopped} Retry it in Activity.</li>`;
    return recipientRole === "member"
      ? `<li>${label}: ${stopped} The workspace owner can reconnect ${name}; then retry it in Activity.</li>`
      : `<li>${label}: ${stopped} Reconnect ${name} in Settings, then retry it in Activity.</li>`;
  }
  if (result.status === "success") {
    // R44 publishing L3: the note the Activity card shows, so a success that
    // lost its chosen cover does not read as complete.
    const note = result.note ? ` — ${escapeHtml(result.note)}` : "";
    return `<li>${label}: Succeeded${note}</li>`;
  }
  if (result.status === "failed") {
    const reason = result.errorMessage ? ` — ${escapeHtml(result.errorMessage)}` : "";
    return `<li>${label}: Failed${reason}</li>`;
  }
  // Defensive only: notifications fire after a job reaches a terminal state,
  // so a `pending` result here would mean a bug upstream, not a state to
  // design a real UX around.
  return `<li>${label}: Pending</li>`;
}

/**
 * Pure email content builder. `results` is already the minimal DTO shape, so
 * there is nothing secret in scope to leak — no tokens, connection ids, or
 * raw connection metadata ever reach this function.
 */
export function buildPostOutcomeEmail({
  results,
  status,
  appBaseUrl,
  workspaceId,
  workspaceName,
  caption,
  scanNotice = false,
  recipientRole = "owner",
}: BuildPostOutcomeEmailParams): PostOutcomeEmail {
  const base = appBaseUrl || null;
  // Omitted cleanly (no dead link, no crash) when no base URL is available.
  // Through /go, so it opens this post's workspace whichever one is active.
  const link = base
    ? `<p><a href="${escapeHtml(workspaceLink(workspaceId, "/activity", base))}">View in Activity</a></p>`
    : "";
  const excerpt = captionExcerpt(caption);
  // F4: which post this was, in words the owner wrote (the id meant nothing to them).
  const about = [
    `<p>In <strong>${escapeHtml(workspaceName)}</strong>.</p>`,
    excerpt ? `<p>Caption: ${escapeHtml(excerpt)}</p>` : "",
  ].join("");
  const optOut = emailSettingsLine({
    action: 'turn off "Email me when a post finishes"',
    workspaceId,
    appBaseUrl: base,
  });
  const onceADay = scanNotice ? `<p>${escapeHtml(SCAN_NOTICE_ONCE_A_DAY_LINE)}</p>` : "";
  const subjectFor = (headline: string) =>
    `${oneLine(workspaceName)}: ${headline.charAt(0).toLowerCase()}${headline.slice(1)}`;

  // Task 9 (Phase-6 review gap close): a scheduled post that fires with zero
  // eligible connections is marked `failed` with NO PostJobResult rows at
  // all, so — left unhandled — it falls straight through to the neutral
  // "finished processing" subject below and silently under-reports a real
  // failure. Any OTHER empty-results status (e.g. a job caught mid-flight)
  // keeps that pre-existing neutral copy; only `failed` gets this dedicated
  // subject/body.
  if (results.length === 0 && status === "failed") {
    const headline = "Your scheduled post couldn't be published";
    const html = [
      "<div>",
      `<h1>${escapeHtml(headline)}</h1>`,
      about,
      // F1 review: no platform was tried, because no connection could take the
      // post or because our side gave up after 2 h. The job records neither
      // cause, so this says what is true for both, like the Activity card.
      "<p>This post was not sent. Open it in Activity and use Send again to try once more.</p>",
      onceADay,
      link,
      optOut,
      "</div>",
    ].join("");
    return { subject: subjectFor(headline), html };
  }

  const headline = buildHeadline(results);

  const rows = results.map((result) => renderResultRow(result, recipientRole)).join("");

  const html = [
    "<div>",
    `<h1>${escapeHtml(headline)}</h1>`,
    about,
    `<ul>${rows}</ul>`,
    onceADay,
    link,
    optOut,
    "</div>",
  ].join("");

  return { subject: subjectFor(headline), html };
}

/** What the email reads from a job, and from the other half of its pair. */
const OUTCOME_JOB_SELECT = {
  id: true,
  // Task 9: needed so buildPostOutcomeEmail can tell a
  // zero-eligible-connections `failed` job apart from any other
  // empty-results state.
  status: true,
  // F4: the workspace (its name and /go links) and the caption the email quotes.
  workspaceId: true,
  baseCaption: true,
  mediaItem: { select: { baseCaption: true } },
  workspace: { select: { name: true } },
  // R5-client-journey L3: the pair (F6) and which platforms went as a Story.
  storyOfPostJobId: true,
  publishMetadata: true,
  // When the job finished, for a job without results (see finishedAt).
  updatedAt: true,
  // The publish attempt the email is about (a Retry sets it): its key.
  retriedAt: true,
  // R6-publishing L2: the email this job's outcome already went out in.
  outcomeEmailAttempt: true,
  outcomeEmailKey: true,
  results: {
    // Only what the email renders or keys on — externalPostId was selected but
    // never read (review Minor #3), so it's dropped.
    select: {
      id: true,
      platform: true,
      status: true,
      // Pause (2026-11-10): to send nothing for a paused workspace's job.
      errorCode: true,
      errorMessage: true,
      // R44 publishing L3: a success's note, shown in its row.
      note: true,
      // When the result finished, and a platform limit the other half waits out.
      updatedAt: true,
      deferredUntil: true,
    },
  },
} as const;

type OutcomeJob = NonNullable<
  Awaited<ReturnType<typeof prisma.postJob.findUnique<{ where: { id: string }; select: typeof OUTCOME_JOB_SELECT }>>>
>;

/** Still sending: a pair half in this state may still finish, so it is waited for. */
const PUBLISHING_STATUSES: readonly PostJobStatus[] = ["pending", "in_progress"];
/** Done: may share one email. Any other state (held, scheduled, cancelled) is not waited for. */
const FINISHED_STATUSES: readonly PostJobStatus[] = ["completed", "failed"];

/**
 * R5-client-journey L3 review: the two halves of a Feed and Story pair share one
 * email when they finish within this long of each other; otherwise each sends
 * its own. A half whose partner is still publishing waits this long
 * (sendNotification sleeps), so the pair never ends without an email. Longer
 * than the stuck-run reconciler takes (STUCK_IN_PROGRESS_MS, 2 h, plus a scanner
 * tick; it notifies the half it closes), so a half whose run died still shares
 * the email. A partner waiting out a platform limit beyond it is not waited for.
 * Both halves apply the same rule to the same two finish times, so they agree.
 */
export const PAIR_EMAIL_WAIT_MS = 3 * 60 * 60 * 1000;

/**
 * When a job finished: its last write, the job's own or a result's. A job the
 * stale sweep or the reconciler closed finished at that write, however old its
 * results' times are.
 */
function finishedAt(job: OutcomeJob): number {
  return Math.max(
    new Date(job.updatedAt).getTime(),
    ...job.results.map((result) => new Date(result.updatedAt).getTime()),
  );
}

/** The latest platform-limit wait among the job's pending results, or 0. */
function deferredUntil(job: OutcomeJob): number {
  const times = job.results
    .filter((result) => result.status === "pending" && result.deferredUntil)
    .map((result) => new Date(result.deferredUntil!).getTime());
  return times.length > 0 ? Math.max(...times) : 0;
}

/** A half that failed with no result at all: no platform was tried. */
function givenUpUnsent(job: OutcomeJob): boolean {
  return job.status === "failed" && job.results.length === 0;
}

/**
 * Which email this half sends: "wait" (until `until`), "alone", or "together"
 * (one email for the pair).
 */
function pairDecision(
  job: OutcomeJob,
  partner: OutcomeJob | null,
  now: number,
  afterPairWait: boolean,
): { send: "alone" | "together" } | { send: "wait"; until: number } {
  if (!partner) return { send: "alone" };
  // R46 publishing part-A L1: a half given up with no results was never sent.
  // The pair's email would hold only the other half's rows and say it all
  // worked, so each half sends its own (the empty one: "use Send again").
  if (givenUpUnsent(job) || givenUpUnsent(partner)) return { send: "alone" };
  const mine = finishedAt(job);
  if (PUBLISHING_STATUSES.includes(partner.status)) {
    const deadline = mine + PAIR_EMAIL_WAIT_MS;
    // It will finish after the deadline whatever happens: its own email then.
    if (afterPairWait || now >= deadline || deferredUntil(partner) > deadline) return { send: "alone" };
    return { send: "wait", until: deadline };
  }
  if (!FINISHED_STATUSES.includes(partner.status)) return { send: "alone" };
  return Math.abs(finishedAt(partner) - mine) < PAIR_EMAIL_WAIT_MS ? { send: "together" } : { send: "alone" };
}

/** What {@link pairPartnerStillToSend} reads of the other half. */
const PARTNER_STATE_SELECT = {
  workspaceId: true,
  status: true,
  scheduledFor: true,
  results: { select: { status: true, deferredUntil: true } },
} as const;

/**
 * R9-publishing L1: will the other half of this post's Feed and Story pair
 * still be sent, so that its run sends the pair's one email? True while it is
 * publishing, or scheduled and already due (this scan or the next sends it).
 * Not for one waiting out a platform limit past {@link PAIR_EMAIL_WAIT_MS}: it
 * would never share this half's email, so this half is told now.
 */
export async function pairPartnerStillToSend(postJobId: string, now: Date = new Date()): Promise<boolean> {
  const job = await prisma.postJob.findUnique({
    where: { id: postJobId },
    select: { id: true, workspaceId: true, storyOfPostJobId: true },
  });
  if (!job) return false;
  const partner = job.storyOfPostJobId
    ? await prisma.postJob.findUnique({ where: { id: job.storyOfPostJobId }, select: PARTNER_STATE_SELECT })
    : await prisma.postJob.findFirst({ where: { storyOfPostJobId: job.id }, select: PARTNER_STATE_SELECT });
  if (!partner || partner.workspaceId !== job.workspaceId) return false;
  if (PUBLISHING_STATUSES.includes(partner.status)) {
    const waits = partner.results
      .filter((result) => result.status === "pending" && result.deferredUntil)
      .map((result) => new Date(result.deferredUntil!).getTime());
    return !waits.some((until) => until > now.getTime() + PAIR_EMAIL_WAIT_MS);
  }
  return (
    partner.status === "scheduled" &&
    partner.scheduledFor !== null &&
    new Date(partner.scheduledFor).getTime() <= now.getTime()
  );
}

/**
 * The other half of a Feed and Story pair (F6: the Story job names its feed job
 * in storyOfPostJobId), or null. A partner in another workspace is no pair.
 */
async function pairPartnerOf(job: OutcomeJob): Promise<OutcomeJob | null> {
  const partner = job.storyOfPostJobId
    ? await prisma.postJob.findUnique({ where: { id: job.storyOfPostJobId }, select: OUTCOME_JOB_SELECT })
    : await prisma.postJob.findFirst({ where: { storyOfPostJobId: job.id }, select: OUTCOME_JOB_SELECT });
  return partner && partner.workspaceId === job.workspaceId ? partner : null;
}

/** A job's rows for the email, its Story platforms labelled, its never-sent rows marked. */
function summaryRows(job: OutcomeJob) {
  const stories = storyPlatformsOf(job.publishMetadata) as Platform[];
  const closed = FINISHED_STATUSES.includes(job.status);
  return job.results.map((result) => ({
    ...result,
    story: stories.includes(result.platform),
    notSent: closed && result.status === "pending",
  }));
}

/**
 * Review 2: which publish of the job an email is about. Stable for one publish
 * (the job's first, or the Retry that set `retriedAt`), so every notice of that
 * publish, from its run, onFailure, the reconciler or the stale sweep, builds
 * the same Resend key and Resend sends one email; a Retry is a new attempt and
 * emails again.
 */
function attemptOf(job: OutcomeJob): string {
  return job.retriedAt ? String(new Date(job.retriedAt).getTime()) : "first";
}

/** The Resend key of one job's email for one publish attempt. */
function outcomeIdempotencyKey(postJobId: string, job: OutcomeJob): string {
  return `post-outcome/${postJobId}/${attemptOf(job)}`;
}

/** The Resend key of a pair's one email: the same from either half, new after a Retry of either. */
function pairIdempotencyKey(feed: OutcomeJob, story: OutcomeJob): string {
  return `post-outcome-pair/${feed.id}/${attemptOf(feed)}/${attemptOf(story)}`;
}

/**
 * R6-publishing L2: the key of the email this job's outcome went out in for
 * its current attempt, or null. A Retry is a new attempt, so its outcome is
 * not yet in any email.
 */
function emailedThisAttempt(job: OutcomeJob): string | null {
  return job.outcomeEmailAttempt === attemptOf(job) ? job.outcomeEmailKey : null;
}

/**
 * Records, before sending, that `job`'s outcome for its current attempt goes
 * out under `key`. Refused (false) when it already went out under another key
 * for that attempt; the same key is allowed again, so a replay or a lost ack
 * sends again under it and Resend delivers once. One conditional UPDATE, so of
 * two halves deciding at once only one can record a different email.
 * `force` overwrites: only for this job's own claim that its partner refused.
 */
async function claimOutcomeEmail(job: OutcomeJob, key: string, force = false): Promise<boolean> {
  const attempt = attemptOf(job);
  const { count } = await prisma.postJob.updateMany({
    where: force
      ? { id: job.id }
      : {
          id: job.id,
          OR: [{ outcomeEmailAttempt: null }, { outcomeEmailAttempt: { not: attempt } }, { outcomeEmailKey: key }],
        },
    data: { outcomeEmailAttempt: attempt, outcomeEmailKey: key },
  });
  return count === 1;
}

/**
 * Which email this job's delivery sends, recorded on the job(s) it covers:
 * the pair's one email (`partner` given) only when neither half went out in
 * another for its attempt, else its own. Null when its outcome already went
 * out in the pair's email, so there is nothing left to send.
 */
async function claimEmail(
  job: OutcomeJob,
  partner: OutcomeJob | null,
): Promise<{ feed: OutcomeJob; story: OutcomeJob | null; key: string } | null> {
  if (partner) {
    const [feed, story] = job.storyOfPostJobId ? [partner, job] : [job, partner];
    const key = pairIdempotencyKey(feed, story);
    const free = (half: OutcomeJob) => [null, key].includes(emailedThisAttempt(half));
    if (free(job) && free(partner)) {
      const mine = await claimOutcomeEmail(job, key);
      if (mine && (await claimOutcomeEmail(partner, key))) return { feed, story, key };
      // The partner went out in another email after it was read: this half's own.
      if (mine) {
        const own = outcomeIdempotencyKey(job.id, job);
        await claimOutcomeEmail(job, own, true);
        return { feed: job, story: null, key: own };
      }
    }
  }
  const own = outcomeIdempotencyKey(job.id, job);
  return (await claimOutcomeEmail(job, own)) ? { feed: job, story: null, key: own } : null;
}

export interface DeliverPostOutcomeNotificationParams {
  userId: string;
  postJobId: string;
  /** The second delivery, after the pair wait: never asks to wait again. */
  afterPairWait?: boolean;
  /** The scanner's once-a-day notice of a post it did not send (scannerNotice.ts). */
  scanNotice?: boolean;
}

/** Only when this half of a pair waits for the other: deliver again at `waitUntil` (ISO). */
export interface DeliverPostOutcomeNotificationResult {
  waitUntil?: string;
}

/**
 * Impure orchestrator invoked by the `sendNotification` Inngest function.
 * Re-fetches fresh User + PostJobResult data from just the event's ids and,
 * if `shouldSendPostOutcomeEmail` allows it, sends the email built by
 * `buildPostOutcomeEmail`.
 *
 * Throws ONLY a retryable delivery failure (`isRetryableEmailError`: a Resend
 * 429 / 5xx / network error; 2026-11-01 scale audit, jobs notifications), so the
 * `deliver-notification` step is retried instead of the email being dropped.
 * Missing job, missing user, a DB error, or any other email error are all either
 * a clean early return or caught right here. That is defense-in-depth on top of
 * `sendEmail`'s own try/catch: the invariant ("posting is never affected by
 * notifications") is owned end-to-end by this module, not by the caller - the
 * publish/retry job finished before this event was even sent.
 */
export async function deliverPostOutcomeNotification({
  userId,
  postJobId,
  afterPairWait = false,
  scanNotice = false,
}: DeliverPostOutcomeNotificationParams): Promise<DeliverPostOutcomeNotificationResult | undefined> {
  try {
    const hasApiKey = Boolean(process.env.RESEND_API_KEY);

    // Top-level kill switch: with no key configured (the default today), do
    // not even touch the database. This is the strongest form of the "email
    // is a complete no-op" guarantee — every post completion (immediate and
    // retry) hits this function, so skipping the two queries below also
    // keeps the feature's cost at zero for installs that haven't opted in.
    if (!hasApiKey) {
      return undefined;
    }

    const [user, postJob] = await Promise.all([
      prisma.user.findUnique({
        where: { id: userId },
        select: { email: true, notifyOnPostComplete: true },
      }),
      prisma.postJob.findUnique({ where: { id: postJobId }, select: OUTCOME_JOB_SELECT }),
    ]);

    const shouldSend = shouldSendPostOutcomeEmail({
      hasApiKey,
      pref: user?.notifyOnPostComplete ?? false,
      hasEmail: Boolean(user?.email),
    });

    if (!shouldSend || !user || !postJob) {
      return undefined;
    }
    // Publishing again (a retry took it, e.g. while this waited for its pair):
    // that run notifies when it finishes.
    if (PUBLISHING_STATUSES.includes(postJob.status)) {
      return undefined;
    }

    // R6-publishing L1: only a member of the post's workspace hears about its
    // posts. An author who was removed or left gets nothing, and nobody is
    // emailed in their place (the owners see the outcome in Activity).
    const membership = await prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId: postJob.workspaceId, userId } },
      select: { id: true, role: true },
    });
    if (!membership) {
      return undefined;
    }

    // R5-client-journey L3: a Feed and Story pair that finishes within
    // PAIR_EMAIL_WAIT_MS sends one email for both; see pairDecision.
    const partner = await pairPartnerOf(postJob);
    const decision = pairDecision(postJob, partner, Date.now(), afterPairWait);
    if (decision.send === "wait") {
      return { waitUntil: new Date(decision.until).toISOString() };
    }
    // R6-publishing L2: and only when neither half went out in another email.
    const claimed = await claimEmail(postJob, decision.send === "together" ? partner : null);
    if (!claimed) {
      return undefined;
    }
    const { feed, story } = claimed;
    // R9-client-journey L4: a member can't reconnect, so is told the owner can.
    const role = membership.role === "member" ? "member" : "owner";
    const summaries = [...summaryRows(feed), ...(story ? summaryRows(story) : [])];
    // R27 MM4 review: a stalled row is worded by the card's rule, which needs
    // its connection now; read only when there is one.
    const stalledPlatforms = [
      ...new Set(
        summaries
          .filter((result) => result.status === "failed" && result.errorCode === PUBLISH_STALLED_FAILURE.errorCode)
          .map((result) => result.platform),
      ),
    ];
    const connections =
      stalledPlatforms.length > 0
        ? await prisma.socialConnection.findMany({
            where: { workspaceId: feed.workspaceId, platform: { in: stalledPlatforms } },
            select: { platform: true, needsReconnect: true },
          })
        : [];
    const rows = summaries.map((result) => ({
      ...result,
      errorMessage: sentenceForRecipient(result.errorMessage, result.platform, role),
      needsReconnect: needsReconnecting(connections.find((connection) => connection.platform === result.platform)),
    }));

    // Pause (2026-11-10): a paused workspace's due posts are all failed with this
    // code, and the owners already had the pause email, so a job whose every
    // result is a paused failure sends nothing. Any other mix is reported in
    // full, paused results included (fix round 2): leaving them out would let a
    // partial retry after a resume read as a full success while a platform is
    // still unpublished.
    const allPaused =
      rows.length > 0 && rows.every((result) => result.status === "failed" && result.errorCode === WORKSPACE_PAUSED_CODE);
    if (allPaused) {
      return undefined;
    }

    const { subject, html } = buildPostOutcomeEmail({
      results: rows,
      status: feed.status,
      appBaseUrl: process.env.NEXTAUTH_URL || null,
      workspaceId: feed.workspaceId,
      workspaceName: postJob.workspace.name,
      // The pair is described by its feed post (its caption; a Story has none).
      caption: feed.baseCaption ?? feed.mediaItem?.baseCaption ?? "",
      scanNotice,
      recipientRole: role,
    });

    await sendEmail(
      { to: user.email, subject, html },
      // Keyed on the outcome, not on who asked: a replay, a lost ack, or a second
      // notice of the same attempt (or the other half of the pair) is a no-op at
      // Resend, so no outcome is emailed twice; a Retry is a new attempt.
      { idempotencyKey: claimed.key, throwOnRetryable: true },
    );
  } catch (error) {
    if (isRetryableEmailError(error)) throw error;
    console.error("[Notifications] Failed to deliver post-outcome email", {
      userId,
      postJobId,
      error,
    });
  }
  return undefined;
}
