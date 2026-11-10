import type { Prisma } from "@prisma/client";
import { RetryAfterError } from "inngest";

import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import { utcDayKey } from "@/lib/usageLimits";
import { fetchReviews, refreshAccessToken, type GoogleReview } from "@/server/googleReviews";
import { isRetryableEmailError, sendEmail } from "@/server/notifications/email";
import {
  buildNewReviewsEmail,
  firstChars,
  NEW_REVIEW_COMMENT_CHARS,
  type NewReviewSummary,
} from "@/server/notifications/newReviewsEmail";

/**
 * The new Google review email (2026-11-10). The `google-review-alerts` cron
 * runs one step each: `collectReviewAlertConnections` lists the Google
 * connections, oldest-checked first; `checkReviewConnections` asks Google for
 * each one's newest reviews for at most REVIEW_CHECK_BUDGET_MS; and
 * `sendReviewAlerts` emails the owners of each listing that got new reviews.
 *
 * Nothing about reviews is stored but two times in `SocialConnection.metadata`:
 * - `reviewsSeenThrough`, the createTime of the newest review seen. A review
 *   created after it is new. The first check of a connection only sets it, so
 *   nobody is emailed about old reviews. An edited old review keeps its
 *   createTime, so it is not new.
 * - `reviewsCheckedAt`, when the connection was last checked: the order of the
 *   next run, so a run cut short by its time budget carries on from there.
 *
 * Both are written by a guarded merge onto the row as it is at that moment
 * (saveReviewMarkerIfUnchanged), as gbpLocationTitle.ts writes a title.
 *
 * Order: for a listing with new reviews the marker is saved only after its
 * owners' emails were attempted. A send that fails after its retry is logged and
 * the marker still moves: one missed email is better than the same reviews
 * emailed every day. A re-run of the send step on the same day sends nothing
 * twice: Resend drops a repeat of the idempotency key.
 *
 * Step outputs carry ids, names, ratings and comment excerpts; owners' addresses
 * are read in the send step and never land in a step's stored output.
 */

/** No new connection is checked after this long; the rest wait for the next day. */
export const REVIEW_CHECK_BUDGET_MS = 120_000;

/** Pause between two sends: Resend allows 10 requests a second per team, shared with other mail. */
export const REVIEW_ALERT_SEND_INTERVAL_MS = 600;

/** Wait before the one retry of a send that failed retryably and carried no usable delay. */
export const REVIEW_ALERT_RETRY_DELAY_MS = 2_000;

/**
 * A run sends at most this many emails; the listings left over keep their
 * marker and are emailed the next day. Sized like the daily problems email
 * (problemDigest.ts): 40 x 4.6 s worst case fits one step.
 */
export const REVIEW_ALERT_MAX_EMAILS_PER_RUN = 40;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** As problemDigest.ts: a RetryAfterError's delay, capped; the default otherwise. */
function retryDelayMs(error: unknown): number {
  if (!(error instanceof RetryAfterError)) return REVIEW_ALERT_RETRY_DELAY_MS;
  const raw = error.retryAfter;
  const ms = /^\d+$/.test(raw) ? Number(raw) * 1000 : Date.parse(raw) - Date.now();
  if (!Number.isFinite(ms)) return REVIEW_ALERT_RETRY_DELAY_MS;
  return Math.min(Math.max(ms, 0), REVIEW_ALERT_RETRY_DELAY_MS);
}

function metadataOf(row: { metadata: unknown }): Record<string, unknown> {
  return row.metadata && typeof row.metadata === "object" && !Array.isArray(row.metadata)
    ? (row.metadata as Record<string, unknown>)
    : {};
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/** Epoch ms of an RFC 3339 time, or NaN. Google sends up to nine fraction digits. */
function timeOf(value: string): number {
  return Date.parse(value);
}

/** The later of two RFC 3339 times; a time that does not parse loses. */
function later(a: string | null, b: string): string {
  if (!a || !(timeOf(a) > timeOf(b))) return b;
  return a;
}

export interface NewReviewsResult {
  /** Reviews created after the marker, newest first. Empty on a first check. */
  newReviews: GoogleReview[];
  /** The marker to save: the newest createTime seen. */
  seenThrough: string;
  /** No marker was saved before: nothing is reported. */
  firstCheck: boolean;
}

/**
 * Which of `reviews` are new since `seenThrough`. With no marker yet, the marker
 * becomes the newest review's createTime (or `now` for a listing with none) and
 * nothing is new.
 */
export function findNewReviews(
  reviews: GoogleReview[],
  seenThrough: string | null,
  now: Date,
): NewReviewsResult {
  const dated = reviews.filter((review) => Number.isFinite(timeOf(review.createTime)));
  const newest = dated.reduce<string | null>(
    (best, review) => (best === null ? review.createTime : later(best, review.createTime)),
    null,
  );

  if (!seenThrough || !Number.isFinite(timeOf(seenThrough))) {
    return { newReviews: [], seenThrough: newest ?? now.toISOString(), firstCheck: true };
  }

  const since = timeOf(seenThrough);
  const newReviews = dated
    .filter((review) => timeOf(review.createTime) > since)
    .sort((a, b) => timeOf(b.createTime) - timeOf(a.createTime));
  return {
    newReviews,
    seenThrough: newReviews.length > 0 ? newReviews[0].createTime : seenThrough,
    firstCheck: false,
  };
}

/**
 * Saves the check time, and `seenThrough` when given, merged onto the metadata
 * as it is NOW, so nothing written meanwhile is lost. Writes nothing when the
 * connection is gone or another location was chosen meanwhile (that location's
 * reviews are not the ones checked), and never moves a marker backwards (an
 * overlapping run may have moved it further).
 */
export async function saveReviewMarkerIfUnchanged(
  id: string,
  locationName: string,
  marker: { seenThrough?: string; checkedAt: Date },
): Promise<boolean> {
  const fresh = await prisma.socialConnection.findUnique({ where: { id }, select: { metadata: true } });
  if (!fresh) return false;
  const metadata = metadataOf(fresh);
  if (nonEmptyString(metadata.locationName) !== locationName) return false;

  const stored = nonEmptyString(metadata.reviewsSeenThrough);
  const next: Record<string, unknown> = { ...metadata, reviewsCheckedAt: marker.checkedAt.toISOString() };
  if (marker.seenThrough) next.reviewsSeenThrough = later(stored, marker.seenThrough);

  await prisma.socialConnection.update({
    where: { id },
    data: { metadata: next as Prisma.InputJsonValue },
  });
  return true;
}

/**
 * Every Google Business Profile connection's id, never-checked first, then
 * oldest `reviewsCheckedAt` first. The checks themselves skip the ones that
 * cannot be checked, and log why.
 */
export async function collectReviewAlertConnections(): Promise<string[]> {
  const rows = await prisma.socialConnection.findMany({
    where: { platform: "google_business_profile" },
    select: { id: true, metadata: true },
    orderBy: { id: "asc" },
  });
  const checkedAt = (row: { metadata: unknown }) => {
    const value = nonEmptyString(metadataOf(row).reviewsCheckedAt);
    const time = value ? timeOf(value) : NaN;
    return Number.isFinite(time) ? time : -Infinity;
  };
  return rows
    .map((row) => ({ id: row.id, at: checkedAt(row) }))
    .sort((a, b) => (a.at === b.at ? 0 : a.at < b.at ? -1 : 1))
    .map((row) => row.id);
}

/** A listing with new reviews, for the send step. No secrets, no addresses. */
export interface ReviewAlert {
  connectionId: string;
  workspaceId: string;
  locationName: string;
  locationTitle: string;
  /** The marker to save once the owners' emails were attempted. */
  seenThrough: string;
  reviews: NewReviewSummary[];
}

export interface ReviewCheckResult {
  alerts: ReviewAlert[];
  /** Connections Google was asked about (or whose token refresh was tried). */
  checked: number;
  /** Connections not asked: gone, needing reconnection, or no location chosen. */
  skipped: number;
  /** Checked connections whose check failed; retried the next day. */
  failed: number;
  /** Connections not reached before the time budget ran out. */
  left: number;
}

function summarize(review: GoogleReview): NewReviewSummary {
  const comment = review.comment?.trim();
  return {
    starRating: review.starRating,
    reviewerName: review.reviewer?.displayName ?? "",
    ...(comment ? { comment: firstChars(comment, NEW_REVIEW_COMMENT_CHARS) } : {}),
  };
}

/**
 * Checks the connections in `ids` in order until REVIEW_CHECK_BUDGET_MS has
 * passed (`clock` is the real clock). A connection with new reviews comes back
 * as an alert and keeps its marker for the send step; every other checked
 * connection gets its check time (and, on a first check, its marker) now.
 */
export async function checkReviewConnections(
  ids: string[],
  now: Date,
  clock: () => number = Date.now,
): Promise<ReviewCheckResult> {
  const startedAt = clock();
  const result: ReviewCheckResult = { alerts: [], checked: 0, skipped: 0, failed: 0, left: 0 };

  for (let index = 0; index < ids.length; index++) {
    if (clock() - startedAt > REVIEW_CHECK_BUDGET_MS) {
      result.left = ids.length - index;
      logger.info("[reviews] Review check time budget reached; the rest are checked tomorrow", {
        left: result.left,
      });
      break;
    }
    const id = ids[index];

    const connection = await prisma.socialConnection.findUnique({
      where: { id },
      include: { workspace: { select: { name: true } } },
    });
    if (!connection) {
      result.skipped++;
      continue;
    }
    const metadata = metadataOf(connection);
    const locationName = nonEmptyString(metadata.locationName);
    if (connection.needsReconnect || !locationName) {
      result.skipped++;
      logger.warn("[reviews] Skipped a Google connection in the review check", {
        connectionId: id,
        reason: connection.needsReconnect ? "needs_reconnect" : "no_location",
      });
      continue;
    }

    result.checked++;
    try {
      let current = connection;
      if (current.expiresAt && new Date(current.expiresAt).getTime() <= now.getTime()) {
        current = { ...current, ...(await refreshAccessToken(current)) };
      }
      const reviews = await fetchReviews(current.accessToken, locationName, { newestFirst: true });
      const found = findNewReviews(reviews, nonEmptyString(metadata.reviewsSeenThrough), now);

      if (found.newReviews.length === 0) {
        await saveReviewMarkerIfUnchanged(id, locationName, {
          ...(found.firstCheck ? { seenThrough: found.seenThrough } : {}),
          checkedAt: now,
        });
        continue;
      }

      result.alerts.push({
        connectionId: id,
        workspaceId: connection.workspaceId,
        locationName,
        locationTitle: nonEmptyString(metadata.locationTitle) ?? connection.workspace.name,
        seenThrough: found.seenThrough,
        reviews: found.newReviews.map(summarize),
      });
    } catch (error) {
      result.failed++;
      // The error kind only: a message could quote a URL.
      logger.warn("[reviews] Review check failed for a Google connection; carrying on", {
        connectionId: id,
        error: error instanceof Error ? error.name : "unknown",
        code: (error as { code?: unknown } | null)?.code,
      });
      // Stamped, so a connection that keeps failing goes behind the others tomorrow.
      try {
        await saveReviewMarkerIfUnchanged(id, locationName, { checkedAt: now });
      } catch {
        // Best effort: the next run checks it again either way.
      }
    }
  }

  return result;
}

export interface ReviewAlertSendResult {
  sent: number;
  failed: number;
  /** Listings over the per-run cap, not emailed; their marker waits for tomorrow. */
  left: number;
}

/**
 * Emails each alert's workspace owners who kept `notifyNewReviews` on, one send
 * every REVIEW_ALERT_SEND_INTERVAL_MS, then saves that listing's marker. A
 * retryable failure (thrown under throwOnRetryable) is retried once after its
 * delay; one owner's failure never stops the rest. At most
 * REVIEW_ALERT_MAX_EMAILS_PER_RUN sends: a listing whose owners would go over it
 * is left, marker unchanged, for the next day.
 */
export async function sendReviewAlerts(alerts: ReviewAlert[], now: Date): Promise<ReviewAlertSendResult> {
  const day = utcDayKey(now);
  const appBaseUrl = process.env.NEXTAUTH_URL || null;
  let sent = 0;
  let failed = 0;
  let attempts = 0;
  let first = true;

  for (let index = 0; index < alerts.length; index++) {
    const alert = alerts[index];
    let recipients: Array<{ userId: string; user: { email: string } }>;
    try {
      recipients = await prisma.workspaceMember.findMany({
        where: { workspaceId: alert.workspaceId, role: "owner", user: { notifyNewReviews: true } },
        select: { userId: true, user: { select: { email: true } } },
        orderBy: { userId: "asc" },
      });
    } catch (error) {
      // Marker unchanged: the same reviews are found again tomorrow.
      logger.error("[reviews] Couldn't read a listing's owners; carrying on", {
        error,
        connectionId: alert.connectionId,
      });
      continue;
    }

    if (attempts > 0 && attempts + recipients.length > REVIEW_ALERT_MAX_EMAILS_PER_RUN) {
      const left = alerts.length - index;
      logger.warn("[reviews] New review email cap reached; the rest are sent tomorrow", {
        cap: REVIEW_ALERT_MAX_EMAILS_PER_RUN,
        left,
      });
      return { sent, failed, left };
    }

    const email = buildNewReviewsEmail({
      locationTitle: alert.locationTitle,
      reviews: alert.reviews,
      appBaseUrl,
    });
    for (const recipient of recipients) {
      if (!first) await sleep(REVIEW_ALERT_SEND_INTERVAL_MS);
      first = false;
      attempts++;

      const send = () =>
        sendEmail(
          { to: recipient.user.email, ...email },
          {
            idempotencyKey: `reviews/${alert.connectionId}/${recipient.userId}/${day}`,
            throwOnRetryable: true,
          },
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
        logger.error("[reviews] Couldn't send one new review email; carrying on", {
          error,
          userId: recipient.userId,
          connectionId: alert.connectionId,
        });
      }
    }

    try {
      await saveReviewMarkerIfUnchanged(alert.connectionId, alert.locationName, {
        seenThrough: alert.seenThrough,
        checkedAt: now,
      });
    } catch (error) {
      // Tomorrow's key differs, so these reviews may be emailed once more.
      logger.error("[reviews] Couldn't save a listing's review marker", {
        error,
        connectionId: alert.connectionId,
      });
    }
  }

  return { sent, failed, left: 0 };
}
