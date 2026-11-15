import { createHash } from "node:crypto";

import type { Platform, PostJobResultStatus, PostJobStatus } from "@prisma/client";

import { prisma } from "@/lib/db";
import { platformLabel } from "@/lib/platforms";
import { storyPlatformsOf } from "@/lib/storyPlacement";
import { WORKSPACE_PAUSED_CODE } from "@/lib/workspaceStatus";
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
  errorMessage?: string | null;
  /** Sent as a Story: the row reads "Instagram Story" (R5-client-journey L3). */
  story?: boolean;
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
  const failedCount = results.filter((r) => r.status === "failed").length;
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
function renderResultRow(result: PostOutcomeResultSummary): string {
  const label = escapeHtml(`${platformLabel(result.platform)}${result.story ? " Story" : ""}`);
  if (result.status === "success") {
    return `<li>${label}: Succeeded</li>`;
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
      link,
      optOut,
      "</div>",
    ].join("");
    return { subject: subjectFor(headline), html };
  }

  const headline = buildHeadline(results);

  const rows = results.map(renderResultRow).join("");

  const html = [
    "<div>",
    `<h1>${escapeHtml(headline)}</h1>`,
    about,
    `<ul>${rows}</ul>`,
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
      // The run that last published the result: a pair's key changes with a retry.
      claimRunId: true,
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

/** When a job finished: its last result's write, or the job's own for none. */
function finishedAt(job: OutcomeJob): number {
  const times = job.results.map((result) => new Date(result.updatedAt).getTime());
  return times.length > 0 ? Math.max(...times) : new Date(job.updatedAt).getTime();
}

/** The latest platform-limit wait among the job's pending results, or 0. */
function deferredUntil(job: OutcomeJob): number {
  const times = job.results
    .filter((result) => result.status === "pending" && result.deferredUntil)
    .map((result) => new Date(result.deferredUntil!).getTime());
  return times.length > 0 ? Math.max(...times) : 0;
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

/** A job's rows for the email, its Story platforms labelled. */
function summaryRows(job: OutcomeJob) {
  const stories = storyPlatformsOf(job.publishMetadata) as Platform[];
  return job.results.map((result) => ({ ...result, story: stories.includes(result.platform) }));
}

/** One Resend key per pair outcome: the same from either half, new after a retry. */
function pairIdempotencyKey(feed: OutcomeJob, story: OutcomeJob): string {
  const outcome = [feed, story].map((job) =>
    job.results
      .map((result) => [result.id, result.status, result.errorCode, result.claimRunId])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
  );
  return `post-outcome-pair/${feed.id}/${createHash("sha256").update(JSON.stringify(outcome)).digest("hex")}`;
}

export interface DeliverPostOutcomeNotificationParams {
  userId: string;
  postJobId: string;
  /**
   * Resend `Idempotency-Key` for this outcome (`post-outcome/<runId>`): a retry
   * after a lost ack is a no-op instead of a second email.
   */
  idempotencyKey?: string;
  /** The second delivery, after the pair wait: never asks to wait again. */
  afterPairWait?: boolean;
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
  idempotencyKey,
  afterPairWait = false,
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

    // R5-client-journey L3: a Feed and Story pair that finishes within
    // PAIR_EMAIL_WAIT_MS sends one email for both; see pairDecision.
    const partner = await pairPartnerOf(postJob);
    const decision = pairDecision(postJob, partner, Date.now(), afterPairWait);
    if (decision.send === "wait") {
      return { waitUntil: new Date(decision.until).toISOString() };
    }
    const together = decision.send === "together" ? partner : null;
    const [feed, story] = together
      ? postJob.storyOfPostJobId
        ? [together, postJob]
        : [postJob, together]
      : [postJob, null];
    const rows = [...summaryRows(feed), ...(story ? summaryRows(story) : [])];

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
    });

    await sendEmail(
      { to: user.email, subject, html },
      // Both halves can find the pair finished at once (they publish side by
      // side): the pair's key is the same for both, so Resend delivers it once.
      // A later retry changes a result, and so the key: a new outcome, a new email.
      { idempotencyKey: story ? pairIdempotencyKey(feed, story) : idempotencyKey, throwOnRetryable: true },
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
