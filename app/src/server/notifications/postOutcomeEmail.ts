import type { Platform, PostJobResultStatus } from "@prisma/client";

import { prisma } from "@/lib/db";
import { platformLabel } from "@/lib/platforms";
import { sendEmail } from "@/server/notifications/email";

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
 *    `sendEmail`. It never throws: every branch is a clean early return or a
 *    caught error, so a bad notification can never affect the publish/retry
 *    job that already completed before this runs.
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
}

export interface BuildPostOutcomeEmailParams {
  results: PostOutcomeResultSummary[];
  /** `process.env.NEXTAUTH_URL`. Omit/null to render the email with no link. */
  appBaseUrl?: string | null;
  postJobId: string;
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

function buildSubject(succeededCount: number, failedCount: number, total: number): string {
  if (total === 0) return "Your post has finished processing";
  if (failedCount === 0) {
    return total === 1
      ? "Your post published successfully"
      : `Your post published successfully to all ${total} platforms`;
  }
  if (succeededCount === 0) {
    return total === 1
      ? "Your post failed to publish"
      : `Your post failed to publish to all ${total} platforms`;
  }
  return `Your post finished: ${succeededCount} of ${total} platforms succeeded`;
}

// Field-by-field rendering (never a blanket JSON.stringify of `result`) so a
// result object that happens to carry extra runtime fields beyond this
// module's DTO type can never leak into the email body.
function renderResultRow(result: PostOutcomeResultSummary): string {
  const label = escapeHtml(platformLabel(result.platform));
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
  appBaseUrl,
  postJobId,
}: BuildPostOutcomeEmailParams): PostOutcomeEmail {
  const succeededCount = results.filter((r) => r.status === "success").length;
  const failedCount = results.filter((r) => r.status === "failed").length;
  const subject = buildSubject(succeededCount, failedCount, results.length);

  const rows = results.map(renderResultRow).join("");
  // Omitted cleanly (no dead link, no crash) when no base URL is available.
  // Trim a trailing slash so a NEXTAUTH_URL like "https://host/" doesn't yield
  // "https://host//activity" (review Minor #4).
  const link = appBaseUrl
    ? `<p><a href="${escapeHtml(appBaseUrl.replace(/\/+$/, ""))}/activity">View in Activity</a></p>`
    : "";

  const html = [
    "<div>",
    `<h1>${escapeHtml(subject)}</h1>`,
    `<ul>${rows}</ul>`,
    link,
    `<p style="color:#888888;font-size:12px;">Reference: ${escapeHtml(postJobId)}</p>`,
    "</div>",
  ].join("");

  return { subject, html };
}

export interface DeliverPostOutcomeNotificationParams {
  userId: string;
  postJobId: string;
}

/**
 * Impure orchestrator invoked by the `sendNotification` Inngest function.
 * Re-fetches fresh User + PostJobResult data from just the event's ids and,
 * if `shouldSendPostOutcomeEmail` allows it, sends the email built by
 * `buildPostOutcomeEmail`.
 *
 * NEVER throws: missing job, missing user, a DB error, or an email error are
 * all either a clean early return or caught right here. This is
 * defense-in-depth on top of `sendEmail`'s own try/catch and the Inngest
 * function's `retries: 1` — the invariant ("posting is never affected by
 * notifications") is owned end-to-end by this module, not by the caller.
 */
export async function deliverPostOutcomeNotification({
  userId,
  postJobId,
}: DeliverPostOutcomeNotificationParams): Promise<void> {
  try {
    const hasApiKey = Boolean(process.env.RESEND_API_KEY);

    // Top-level kill switch: with no key configured (the default today), do
    // not even touch the database. This is the strongest form of the "email
    // is a complete no-op" guarantee — every post completion (immediate and
    // retry) hits this function, so skipping the two queries below also
    // keeps the feature's cost at zero for installs that haven't opted in.
    if (!hasApiKey) {
      return;
    }

    const [user, postJob] = await Promise.all([
      prisma.user.findUnique({
        where: { id: userId },
        select: { email: true, notifyOnPostComplete: true },
      }),
      prisma.postJob.findUnique({
        where: { id: postJobId },
        select: {
          results: {
            // Only what buildPostOutcomeEmail renders — externalPostId was
            // selected but never read (review Minor #3), so it's dropped.
            select: {
              platform: true,
              status: true,
              errorMessage: true,
            },
          },
        },
      }),
    ]);

    const shouldSend = shouldSendPostOutcomeEmail({
      hasApiKey,
      pref: user?.notifyOnPostComplete ?? false,
      hasEmail: Boolean(user?.email),
    });

    if (!shouldSend || !user || !postJob) {
      return;
    }

    const { subject, html } = buildPostOutcomeEmail({
      results: postJob.results,
      appBaseUrl: process.env.NEXTAUTH_URL || null,
      postJobId,
    });

    await sendEmail({ to: user.email, subject, html });
  } catch (error) {
    console.error("[Notifications] Failed to deliver post-outcome email", {
      userId,
      postJobId,
      error,
    });
  }
}
