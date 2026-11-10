/**
 * The new Google review email (2026-11-10), sent by the `google-review-alerts`
 * cron to the owners of a workspace whose listing got new reviews. Pure builder
 * (tested); transport is sendEmail(). Same shape as problemDigestEmail.ts.
 */

/** One new review, as the daily check keeps it. */
export interface NewReviewSummary {
  /** Google's enum: "ONE" .. "FIVE", or "STAR_RATING_UNSPECIFIED". */
  starRating: string;
  reviewerName: string;
  comment?: string;
}

/** Reviews listed in full; the rest are counted. */
export const NEW_REVIEWS_SHOWN = 10;
/** Characters of a comment the email quotes. */
export const NEW_REVIEW_COMMENT_CHARS = 300;

const STARS: Record<string, number> = { ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5 };

/** Minimal HTML-entity escaper (same table as problemDigestEmail.ts). */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** The first `max` characters, counted by code point so an emoji is never split. */
export function firstChars(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length <= max ? text : `${chars.slice(0, max).join("")}…`;
}

function reviewLine(review: NewReviewSummary): string {
  const stars = STARS[review.starRating];
  const rating = stars ? `${stars} out of 5 stars` : "No star rating";
  const name = review.reviewerName.trim() || "A Google user";
  const comment = review.comment?.trim()
    ? escapeHtml(firstChars(review.comment.trim(), NEW_REVIEW_COMMENT_CHARS))
    : "No written comment.";
  return `<li><strong>${rating}</strong> from ${escapeHtml(name)}<br>${comment}</li>`;
}

export function buildNewReviewsEmail(params: {
  locationTitle: string;
  reviews: NewReviewSummary[];
  /** `process.env.NEXTAUTH_URL`. Null renders the email with no link. */
  appBaseUrl: string | null;
}): { subject: string; html: string } {
  const count = params.reviews.length;
  // The subject is plain text, not HTML: only line breaks are taken out.
  const title = params.locationTitle.replace(/[\r\n]+/g, " ").trim();
  const subject = `${count} new Google review${count === 1 ? "" : "s"} for ${title}`;

  const shown = params.reviews.slice(0, NEW_REVIEWS_SHOWN).map(reviewLine);
  const more = count - shown.length;

  // Trim a trailing slash so "https://host/" never yields "https://host//reviews".
  const base = params.appBaseUrl ? params.appBaseUrl.replace(/\/+$/, "") : null;
  const linkLine = base
    ? `<p><a href="${base}/reviews">Read and reply on the Reviews page</a></p>`
    : `<p>Open Reviews in Vibe Socials to read and reply.</p>`;

  return {
    subject,
    html: [
      `<p>${escapeHtml(title)} has ${count === 1 ? "a new Google review" : `${count} new Google reviews`}.</p>`,
      `<ul>\n${shown.join("\n")}\n</ul>`,
      ...(more > 0 ? [`<p>and ${more} more</p>`] : []),
      linkLine,
      `<p>To stop these emails, turn off "Email me when a new Google review arrives" in Settings, Notifications.</p>`,
      `<p>— Vibe Socials</p>`,
    ].join("\n"),
  };
}
