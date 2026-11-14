/**
 * The dashboard's "Needs you" card (N1): what wants the owner today, from the
 * GET /api/dashboard/summary counts plus the browser's one reviews call.
 * Pure, so the sentences and their order are tested without a page.
 */

export interface DashboardSummary {
  problemsLast7Days: number;
  /** Null for a member: only an owner decides approvals. */
  awaitingYourApproval: number | null;
  clientChangesRequested: number;
  nextScheduled: { scheduledFor: string; platformCount: number } | null;
  /**
   * F4: the workspace's name when its Google connection has no business
   * location yet (owners only; null otherwise). Optional: an older server's
   * answer has no such field.
   */
  chooseGoogleLocation?: string | null;
}

export type NeedsYouRowKind =
  | "google_location"
  | "reviews"
  | "problems"
  | "approvals"
  | "client_changes"
  | "next_post"
  | "add_many";

export interface NeedsYouRow {
  kind: NeedsYouRowKind;
  text: string;
  href: string;
}

export interface NeedsYouCard {
  title: "Needs you" | "You're all caught up";
  rows: NeedsYouRow[];
}

/** The URL of Activity's "Had a problem" tab (built in N3). */
export const PROBLEMS_HREF = "/activity?show=problems";

/** The same date and time format as the Queue's cards, in the browser's time zone. */
export function formatNextPostTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/**
 * How many reviews in a GET /api/reviews answer have no reply; null when the
 * answer is not a list of reviews, so the card shows no row rather than a 0.
 */
export function reviewsNeedingReply(body: unknown): number | null {
  if (!body || typeof body !== "object") return null;
  const reviews = (body as { reviews?: unknown }).reviews;
  if (!Array.isArray(reviews)) return null;
  return reviews.filter((review) => !(review as { reviewReply?: unknown } | null)?.reviewReply).length;
}

export function needsYouRows(
  summary: DashboardSummary,
  reviewsNeedingReplyCount: number | null,
  role: "owner" | "member",
  formatTime: (iso: string) => string = formatNextPostTime,
): NeedsYouCard {
  const rows: NeedsYouRow[] = [];
  // First: until it is done, every post to Google fails.
  if (role === "owner" && summary.chooseGoogleLocation) {
    rows.push({
      kind: "google_location",
      text: `Choose the Google business location for ${summary.chooseGoogleLocation}`,
      href: "/settings#connections",
    });
  }
  const reviews = reviewsNeedingReplyCount ?? 0;
  if (reviews > 0) {
    rows.push({
      kind: "reviews",
      text: reviews === 1 ? "1 Google review needs a reply" : `${reviews} Google reviews need a reply`,
      href: "/reviews",
    });
  }
  if (summary.problemsLast7Days > 0) {
    const n = summary.problemsLast7Days;
    rows.push({
      kind: "problems",
      text: `${n} ${n === 1 ? "post" : "posts"} didn't fully go out this week`,
      href: PROBLEMS_HREF,
    });
  }
  const approvals = role === "owner" ? (summary.awaitingYourApproval ?? 0) : 0;
  if (approvals > 0) {
    rows.push({
      kind: "approvals",
      text: approvals === 1 ? "1 post is waiting for your approval" : `${approvals} posts are waiting for your approval`,
      href: "/queue",
    });
  }
  if (summary.clientChangesRequested > 0) {
    const n = summary.clientChangesRequested;
    rows.push({
      kind: "client_changes",
      text: `A client asked for changes on ${n} ${n === 1 ? "post" : "posts"}`,
      href: "/queue",
    });
  }

  const title = rows.length > 0 ? "Needs you" : "You're all caught up";

  const next = summary.nextScheduled;
  if (next) {
    const count = next.platformCount;
    rows.push({
      kind: "next_post",
      text: `Next post: ${formatTime(next.scheduledFor)}, to ${count} ${count === 1 ? "platform" : "platforms"}`,
      href: "/queue",
    });
  } else {
    rows.push({
      kind: "add_many",
      text: "Nothing scheduled yet. Plan the next few weeks with Add many.",
      href: "/posts/bulk",
    });
  }

  return { title, rows };
}

/**
 * What the card shows right now. With Google connected it waits for the
 * reviews call as well as the summary: drawing "You're all caught up" first
 * and then flipping to "Needs you" when the reviews land would say something
 * untrue for a moment. A failed reviews call counts as settled (no row).
 */
export function needsYouView(input: {
  summary: "loading" | "loaded" | "failed";
  reviews: "not_asked" | "pending" | "settled";
}): "nothing" | "skeleton" | "card" {
  if (input.summary === "failed") return "nothing";
  if (input.summary === "loading" || input.reviews === "pending") return "skeleton";
  return "card";
}

/**
 * Whether the dashboard mounts the card: once its connections and posts
 * fetches have finished, loaded or failed, so the card is never mounted and
 * then pulled for the Get started checklist. Deliberately not
 * `onboarding.ready`, which needs every fetch to succeed.
 */
export function shouldMountNeedsYou(input: {
  connectionsLoading: boolean;
  postsLoading: boolean;
  gettingStartedShowing: boolean;
}): boolean {
  return !input.connectionsLoading && !input.postsLoading && !input.gettingStartedShowing;
}

/** A connected Google listing; false when the connections fetch failed. */
export function hasGoogleListing(
  connections: readonly { platform: string; connected: boolean }[] | null,
): boolean {
  return Boolean(
    connections?.some((connection) => connection.platform === "google_business_profile" && connection.connected),
  );
}
