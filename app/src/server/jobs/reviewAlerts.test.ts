import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  connectionFindMany: vi.fn(),
  connectionFindUnique: vi.fn(),
  connectionUpdate: vi.fn(),
  memberFindMany: vi.fn(),
}));
const { sendEmailMock, loggerMock, fetchReviewsMock, refreshMock } = vi.hoisted(() => ({
  sendEmailMock: vi.fn(),
  loggerMock: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  fetchReviewsMock: vi.fn(),
  refreshMock: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    socialConnection: {
      findMany: db.connectionFindMany,
      findUnique: db.connectionFindUnique,
      update: db.connectionUpdate,
    },
    workspaceMember: { findMany: db.memberFindMany },
  },
}));
// Only the transport is replaced; the error classes stay real (see problemDigest.test.ts).
vi.mock("@/server/notifications/email", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/notifications/email")>()),
  sendEmail: sendEmailMock,
}));
vi.mock("@/server/googleReviews", () => ({
  fetchReviews: fetchReviewsMock,
  refreshAccessToken: refreshMock,
}));
vi.mock("@/lib/logger", () => ({ logger: loggerMock }));

import { RetryAfterError } from "inngest";

import type { GoogleReview } from "@/server/googleReviews";
import { EmailRetryableError } from "@/server/notifications/email";

import {
  REVIEW_ALERT_MAX_EMAILS_PER_RUN,
  REVIEW_ALERT_FETCH_BUDGET_MS,
  REVIEW_CHECK_BUDGET_MS,
  checkReviewConnections,
  collectReviewAlertConnections,
  findNewReviews,
  saveReviewMarkerIfUnchanged,
  seenThroughFor,
  sendReviewAlerts,
  type ReviewAlert,
} from "./reviewAlerts";

const NOW = new Date("2026-11-10T13:00:00.000Z");
const HOUR = 60 * 60 * 1000;
const LOCATION = "accounts/1/locations/22";
const OTHER_LOCATION = "accounts/1/locations/99";

function review(id: string, createTime: string, over: Partial<GoogleReview> = {}): GoogleReview {
  return {
    name: `${LOCATION}/reviews/${id}`,
    reviewId: id,
    reviewer: { displayName: `Reviewer ${id}`, isAnonymous: false },
    starRating: "FIVE",
    comment: `Comment ${id}`,
    createTime,
    updateTime: createTime,
    ...over,
  };
}

interface Row {
  id: string;
  workspaceId: string;
  platform: string;
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date | null;
  needsReconnect: boolean;
  metadata: Record<string, unknown> | null;
  workspace: { name: string };
}

function row(over: Partial<Row> = {}): Row {
  return {
    id: "conn-1",
    workspaceId: "ws-1",
    platform: "google_business_profile",
    accessToken: "gbp-access",
    refreshToken: "gbp-refresh",
    expiresAt: new Date(NOW.getTime() + HOUR),
    needsReconnect: false,
    metadata: {
      locationName: LOCATION,
      locationTitle: "Surf Co",
      reviewsSeenThrough: "2026-11-09T10:00:00Z",
      reviewsSeenFor: LOCATION,
    },
    workspace: { name: "Surf Workspace" },
    ...over,
  };
}

/** The rows by id: the check, the send step and the guarded write all read them. */
function useRows(rows: Row[]) {
  db.connectionFindUnique.mockImplementation(async ({ where }: { where: { id: string } }) => {
    const found = rows.find((r) => r.id === where.id);
    return found ? { ...found } : null;
  });
}

beforeEach(() => {
  for (const mock of Object.values(db)) mock.mockReset();
  for (const mock of [sendEmailMock, fetchReviewsMock, refreshMock]) mock.mockReset();
  for (const mock of Object.values(loggerMock)) mock.mockReset();
  db.connectionUpdate.mockResolvedValue({});
  db.memberFindMany.mockResolvedValue([]);
  sendEmailMock.mockResolvedValue(undefined);
  fetchReviewsMock.mockResolvedValue([]);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("findNewReviews", () => {
  it("on the first check only sets the marker, to the newest review, and reports nothing", () => {
    const result = findNewReviews(
      [review("a", "2026-11-01T00:00:00Z"), review("b", "2026-11-05T00:00:00Z")],
      null,
      NOW,
    );
    expect(result).toEqual({ newReviews: [], seenThrough: "2026-11-05T00:00:00Z", firstCheck: true });
  });

  it("on the first check of a listing with no reviews sets the marker to now", () => {
    expect(findNewReviews([], null, NOW)).toEqual({
      newReviews: [],
      seenThrough: NOW.toISOString(),
      firstCheck: true,
    });
  });

  it("later reports only reviews created after the marker, newest first, and moves the marker to the newest", () => {
    const result = findNewReviews(
      [
        review("old", "2026-11-08T00:00:00Z"),
        review("new1", "2026-11-09T12:00:00Z"),
        review("new2", "2026-11-10T08:00:00.123456789Z"),
      ],
      "2026-11-09T10:00:00Z",
      NOW,
    );
    expect(result.newReviews.map((r) => r.reviewId)).toEqual(["new2", "new1"]);
    expect(result.seenThrough).toBe("2026-11-10T08:00:00.123456789Z");
    expect(result.firstCheck).toBe(false);
  });

  it("does not report an old review that was edited since", () => {
    const edited = review("old", "2026-11-01T00:00:00Z", { updateTime: "2026-11-10T09:00:00Z" });
    expect(findNewReviews([edited], "2026-11-09T10:00:00Z", NOW)).toEqual({
      newReviews: [],
      seenThrough: "2026-11-09T10:00:00Z",
      firstCheck: false,
    });
  });

  it("does not report the review the marker points at", () => {
    const result = findNewReviews([review("a", "2026-11-09T10:00:00Z")], "2026-11-09T10:00:00Z", NOW);
    expect(result.newReviews).toEqual([]);
  });
});

describe("seenThroughFor", () => {
  it("is the marker saved for this location", () => {
    expect(seenThroughFor({ reviewsSeenThrough: "2026-11-09T10:00:00Z", reviewsSeenFor: LOCATION }, LOCATION)).toBe(
      "2026-11-09T10:00:00Z",
    );
  });

  it("is missing for a marker saved for another location", () => {
    expect(
      seenThroughFor({ reviewsSeenThrough: "2026-11-09T10:00:00Z", reviewsSeenFor: OTHER_LOCATION }, LOCATION),
    ).toBeNull();
  });

  it("is missing for a marker with no location recorded", () => {
    expect(seenThroughFor({ reviewsSeenThrough: "2026-11-09T10:00:00Z" }, LOCATION)).toBeNull();
  });
});

describe("saveReviewMarkerIfUnchanged", () => {
  it("merges the marker and its location onto the metadata as it is now, keeping what else was written", async () => {
    db.connectionFindUnique.mockResolvedValue({
      metadata: { locationName: LOCATION, newReviewUri: "https://g.page/r/x/review" },
    });

    await expect(
      saveReviewMarkerIfUnchanged("conn-1", LOCATION, { seenThrough: "2026-11-10T08:00:00Z", checkedAt: NOW }),
    ).resolves.toBe(true);
    expect(db.connectionUpdate).toHaveBeenCalledWith({
      where: { id: "conn-1" },
      data: {
        metadata: {
          locationName: LOCATION,
          newReviewUri: "https://g.page/r/x/review",
          reviewsSeenThrough: "2026-11-10T08:00:00Z",
          reviewsSeenFor: LOCATION,
          reviewsCheckedAt: NOW.toISOString(),
        },
      },
    });
  });

  it("writes nothing when another location was chosen meanwhile", async () => {
    db.connectionFindUnique.mockResolvedValue({ metadata: { locationName: OTHER_LOCATION } });

    await expect(
      saveReviewMarkerIfUnchanged("conn-1", LOCATION, { seenThrough: "2026-11-10T08:00:00Z", checkedAt: NOW }),
    ).resolves.toBe(false);
    expect(db.connectionUpdate).not.toHaveBeenCalled();
  });

  it("writes nothing for a connection removed meanwhile", async () => {
    db.connectionFindUnique.mockResolvedValue(null);

    await expect(saveReviewMarkerIfUnchanged("conn-1", LOCATION, { checkedAt: NOW })).resolves.toBe(false);
    expect(db.connectionUpdate).not.toHaveBeenCalled();
  });

  it("never moves a marker that another run moved further back", async () => {
    db.connectionFindUnique.mockResolvedValue({
      metadata: { locationName: LOCATION, reviewsSeenThrough: "2026-11-10T12:00:00Z", reviewsSeenFor: LOCATION },
    });

    await saveReviewMarkerIfUnchanged("conn-1", LOCATION, { seenThrough: "2026-11-10T08:00:00Z", checkedAt: NOW });

    expect(db.connectionUpdate.mock.calls[0][0].data.metadata.reviewsSeenThrough).toBe("2026-11-10T12:00:00Z");
  });

  it("replaces a later marker that was saved for another location", async () => {
    db.connectionFindUnique.mockResolvedValue({
      metadata: { locationName: LOCATION, reviewsSeenThrough: "2026-11-10T12:00:00Z", reviewsSeenFor: OTHER_LOCATION },
    });

    await saveReviewMarkerIfUnchanged("conn-1", LOCATION, { seenThrough: "2026-11-10T08:00:00Z", checkedAt: NOW });

    expect(db.connectionUpdate.mock.calls[0][0].data.metadata).toMatchObject({
      reviewsSeenThrough: "2026-11-10T08:00:00Z",
      reviewsSeenFor: LOCATION,
    });
  });

  it("only stamps the check time when given no marker", async () => {
    db.connectionFindUnique.mockResolvedValue({
      metadata: { locationName: LOCATION, reviewsSeenThrough: "2026-11-09T10:00:00Z", reviewsSeenFor: LOCATION },
    });

    await saveReviewMarkerIfUnchanged("conn-1", LOCATION, { checkedAt: NOW });

    expect(db.connectionUpdate.mock.calls[0][0].data.metadata).toEqual({
      locationName: LOCATION,
      reviewsSeenThrough: "2026-11-09T10:00:00Z",
      reviewsSeenFor: LOCATION,
      reviewsCheckedAt: NOW.toISOString(),
    });
  });
});

describe("collectReviewAlertConnections", () => {
  it("lists Google connections, never-checked first, then oldest checked first", async () => {
    db.connectionFindMany.mockResolvedValue([
      { id: "recent", metadata: { reviewsCheckedAt: "2026-11-09T13:00:00Z" } },
      { id: "never", metadata: { locationName: LOCATION } },
      { id: "older", metadata: { reviewsCheckedAt: "2026-11-08T13:00:00Z" } },
      { id: "no-metadata", metadata: null },
    ]);

    await expect(collectReviewAlertConnections()).resolves.toEqual(["never", "no-metadata", "older", "recent"]);
    expect(db.connectionFindMany.mock.calls[0][0]).toEqual({
      where: { platform: "google_business_profile" },
      select: { id: true, metadata: true },
      orderBy: { id: "asc" },
    });
  });
});

describe("checkReviewConnections", () => {
  it("returns ids and counts only, no review text, and leaves the marker for the send step", async () => {
    useRows([row()]);
    fetchReviewsMock.mockResolvedValue([
      review("old", "2026-11-08T00:00:00Z"),
      review("new", "2026-11-10T08:00:00Z", { starRating: "FOUR" }),
    ]);

    const result = await checkReviewConnections(["conn-1"], NOW);

    expect(fetchReviewsMock).toHaveBeenCalledWith("gbp-access", LOCATION, { newestFirst: true });
    expect(result.alerts).toEqual([
      {
        connectionId: "conn-1",
        workspaceId: "ws-1",
        locationName: LOCATION,
        seenThrough: "2026-11-10T08:00:00Z",
        count: 1,
        reviewIds: ["new"],
      },
    ]);
    expect(JSON.stringify(result)).not.toContain("Comment");
    expect(JSON.stringify(result)).not.toContain("Reviewer");
    expect(db.connectionUpdate).not.toHaveBeenCalled();
  });

  it("keeps at most 10 review ids, newest first, and the full count", async () => {
    useRows([row()]);
    fetchReviewsMock.mockResolvedValue(
      Array.from({ length: 12 }, (_, i) => review(`r${i}`, `2026-11-10T0${Math.floor(i / 10)}:${String(i % 10).padStart(2, "0")}:00Z`)),
    );

    const [alert] = (await checkReviewConnections(["conn-1"], NOW)).alerts;

    expect(alert.count).toBe(12);
    expect(alert.reviewIds).toEqual(["r11", "r10", "r9", "r8", "r7", "r6", "r5", "r4", "r3", "r2"]);
  });

  it("on the first check saves the marker for the location and returns no alert", async () => {
    useRows([row({ metadata: { locationName: LOCATION } })]);
    fetchReviewsMock.mockResolvedValue([review("a", "2026-11-05T00:00:00Z")]);

    const result = await checkReviewConnections(["conn-1"], NOW);

    expect(result.alerts).toEqual([]);
    expect(db.connectionUpdate.mock.calls[0][0].data.metadata).toEqual({
      locationName: LOCATION,
      reviewsSeenThrough: "2026-11-05T00:00:00Z",
      reviewsSeenFor: LOCATION,
      reviewsCheckedAt: NOW.toISOString(),
    });
  });

  // An owner who first picked a quiet listing and then the real one must not
  // get the real one's history emailed as new.
  it("after a switch of location emails nothing on the next check, and records the new location", async () => {
    useRows([
      row({
        metadata: {
          locationName: OTHER_LOCATION,
          locationTitle: "Real Shop",
          reviewsSeenThrough: "2026-01-01T00:00:00Z",
          reviewsSeenFor: LOCATION,
        },
      }),
    ]);
    fetchReviewsMock.mockResolvedValue(
      Array.from({ length: 50 }, (_, i) => review(`h${i}`, `2026-10-${String((i % 28) + 1).padStart(2, "0")}T00:00:00Z`)),
    );

    const result = await checkReviewConnections(["conn-1"], NOW);

    expect(result.alerts).toEqual([]);
    expect(fetchReviewsMock).toHaveBeenCalledWith("gbp-access", OTHER_LOCATION, { newestFirst: true });
    expect(db.connectionUpdate.mock.calls[0][0].data.metadata).toMatchObject({
      locationName: OTHER_LOCATION,
      reviewsSeenThrough: "2026-10-28T00:00:00Z",
      reviewsSeenFor: OTHER_LOCATION,
    });
  });

  it("treats a marker with no location recorded as a first check", async () => {
    useRows([row({ metadata: { locationName: LOCATION, reviewsSeenThrough: "2026-01-01T00:00:00Z" } })]);
    fetchReviewsMock.mockResolvedValue([review("a", "2026-11-05T00:00:00Z")]);

    const result = await checkReviewConnections(["conn-1"], NOW);

    expect(result.alerts).toEqual([]);
    expect(db.connectionUpdate.mock.calls[0][0].data.metadata).toMatchObject({
      reviewsSeenThrough: "2026-11-05T00:00:00Z",
      reviewsSeenFor: LOCATION,
    });
  });

  it("with nothing new only stamps the check time", async () => {
    useRows([row()]);
    fetchReviewsMock.mockResolvedValue([review("old", "2026-11-08T00:00:00Z")]);

    const result = await checkReviewConnections(["conn-1"], NOW);

    expect(result.alerts).toEqual([]);
    expect(fetchReviewsMock).toHaveBeenCalledTimes(1);
    expect(db.connectionUpdate.mock.calls[0][0].data.metadata.reviewsCheckedAt).toBe(NOW.toISOString());
    expect(db.connectionUpdate.mock.calls[0][0].data.metadata.reviewsSeenThrough).toBe("2026-11-09T10:00:00Z");
  });

  it("skips a connection that needs reconnecting, one with no location, and one that errors; the rest continue", async () => {
    useRows([
      row({ id: "flagged", needsReconnect: true }),
      row({ id: "no-location", metadata: { locationTitle: "x" } }),
      row({ id: "broken" }),
      row({ id: "good" }),
    ]);
    fetchReviewsMock
      .mockRejectedValueOnce(Object.assign(new Error("boom"), { code: "GBP_REVIEWS_FETCH_FAILED" }))
      .mockResolvedValueOnce([review("new", "2026-11-10T08:00:00Z")]);

    const result = await checkReviewConnections(["flagged", "no-location", "missing", "broken", "good"], NOW);

    expect(fetchReviewsMock).toHaveBeenCalledTimes(2);
    expect(result.alerts.map((a) => a.connectionId)).toEqual(["good"]);
    expect(result).toMatchObject({ checked: 2, skipped: 3, failed: 1, left: 0 });
    expect(loggerMock.warn).toHaveBeenCalled();
    // The failed one is stamped, so it goes to the back of tomorrow's queue.
    expect(db.connectionUpdate).toHaveBeenCalledTimes(1);
    expect(db.connectionUpdate.mock.calls[0][0].where).toEqual({ id: "broken" });
    expect(db.connectionUpdate.mock.calls[0][0].data.metadata.reviewsSeenThrough).toBe("2026-11-09T10:00:00Z");
  });

  it("refreshes an expired token through the shared refresh path first", async () => {
    const expired = row({ expiresAt: new Date(NOW.getTime() - HOUR) });
    useRows([expired]);
    refreshMock.mockResolvedValue({ ...expired, accessToken: "gbp-access-2" });

    await checkReviewConnections(["conn-1"], NOW);

    expect(refreshMock).toHaveBeenCalledTimes(1);
    expect(fetchReviewsMock.mock.calls[0][0]).toBe("gbp-access-2");
  });

  it("skips a connection whose token refresh fails, and carries on", async () => {
    useRows([row({ id: "dead", expiresAt: new Date(NOW.getTime() - HOUR) }), row({ id: "good" })]);
    refreshMock.mockRejectedValue(Object.assign(new Error("invalid_grant"), { code: "RECONNECT_REQUIRED" }));

    const result = await checkReviewConnections(["dead", "good"], NOW);

    expect(fetchReviewsMock).toHaveBeenCalledTimes(1);
    expect(result.failed).toBe(1);
  });

  it(`starts no new connection after ${REVIEW_CHECK_BUDGET_MS / 1000} seconds; the rest wait for tomorrow`, async () => {
    expect(REVIEW_CHECK_BUDGET_MS).toBe(120_000);
    useRows([row({ id: "a" }), row({ id: "b" }), row({ id: "c" })]);
    // The clock jumps past the budget after the first connection.
    const times = [0, 0, REVIEW_CHECK_BUDGET_MS + 1];
    const clock = () => times.shift() ?? REVIEW_CHECK_BUDGET_MS + 1;

    const result = await checkReviewConnections(["a", "b", "c"], NOW, clock);

    expect(fetchReviewsMock).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ checked: 1, left: 2 });
  });
});

function alert(over: Partial<ReviewAlert> = {}): ReviewAlert {
  return {
    connectionId: "conn-1",
    workspaceId: "ws-1",
    locationName: LOCATION,
    seenThrough: "2026-11-10T08:00:00Z",
    count: 1,
    reviewIds: ["new"],
    ...over,
  };
}

function owners(...ids: string[]) {
  return ids.map((id) => ({ userId: id, user: { email: `${id}@example.com` } }));
}

/** The send step's second read of the listing: the review the alert names. */
function serveReviews() {
  fetchReviewsMock.mockResolvedValue([
    review("new", "2026-11-10T08:00:00Z", { comment: "Loved the lesson", reviewer: { displayName: "Dana", isAnonymous: false } }),
    review("old", "2026-11-08T00:00:00Z"),
  ]);
}

async function sendWithTimers(alerts: ReviewAlert[], clock?: () => number) {
  vi.useFakeTimers({ now: NOW });
  const pending = sendReviewAlerts(alerts, NOW, clock);
  await vi.runAllTimersAsync();
  return pending;
}

const rateLimited = () => new RetryAfterError("Resend rate limited the send", 2_000);
const serverError = () => new EmailRetryableError("Resend send failed (status 500)");

describe("sendReviewAlerts", () => {
  beforeEach(() => {
    useRows([row()]);
    serveReviews();
  });

  it("emails each owner who kept the preference on, with the key reviews/<connection>/<user>/<UTC day>", async () => {
    db.memberFindMany.mockResolvedValue(owners("user-1"));

    const result = await sendWithTimers([alert()]);

    expect(db.memberFindMany.mock.calls[0][0]).toEqual({
      where: { workspaceId: "ws-1", role: "owner", user: { notifyNewReviews: true } },
      select: { userId: true, user: { select: { email: true } } },
      orderBy: { userId: "asc" },
    });
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    const [params, options] = sendEmailMock.mock.calls[0];
    expect(params.to).toBe("user-1@example.com");
    expect(params.subject).toBe("1 new Google review for Surf Co");
    expect(options).toEqual({ idempotencyKey: "reviews/conn-1/user-1/2026-11-10", throwOnRetryable: true });
    expect(result).toEqual({ sent: 1, failed: 0, left: 0 });
  });

  it("reads the listing again and quotes only the reviews the alert names", async () => {
    db.memberFindMany.mockResolvedValue(owners("user-1"));

    await sendWithTimers([alert()]);

    expect(fetchReviewsMock).toHaveBeenCalledWith("gbp-access", LOCATION, { newestFirst: true, timeoutMs: 10_000 });
    const { html } = sendEmailMock.mock.calls[0][0];
    expect(html).toContain("Loved the lesson");
    expect(html).toContain("Dana");
    expect(html).not.toContain("Comment old");
  });

  it("says and m more for the new reviews beyond the ids it was given", async () => {
    db.memberFindMany.mockResolvedValue(owners("user-1"));

    await sendWithTimers([alert({ count: 14 })]);

    const { subject, html } = sendEmailMock.mock.calls[0][0];
    expect(subject).toBe("14 new Google reviews for Surf Co");
    expect(html).toContain("and 13 more");
  });

  it("when the second read fails, sends the count and the link, and still moves the marker", async () => {
    db.memberFindMany.mockResolvedValue(owners("user-1"));
    fetchReviewsMock.mockReset();
    fetchReviewsMock.mockRejectedValue(new Error("Google down"));

    const result = await sendWithTimers([alert({ count: 3 })]);

    const { subject, html } = sendEmailMock.mock.calls[0][0];
    expect(subject).toBe("3 new Google reviews for Surf Co");
    expect(html).toContain("3 new Google reviews for Surf Co. Open Reviews to read them.");
    expect(html).not.toContain("<li>");
    expect(result.sent).toBe(1);
    expect(db.connectionUpdate.mock.calls[0][0].data.metadata).toMatchObject({
      reviewsSeenThrough: "2026-11-10T08:00:00Z",
      reviewsSeenFor: LOCATION,
    });
  });

  it("refreshes an expired token before the second read", async () => {
    const expired = row({ expiresAt: new Date(NOW.getTime() - HOUR) });
    useRows([expired]);
    refreshMock.mockResolvedValue({ ...expired, accessToken: "gbp-access-2" });
    db.memberFindMany.mockResolvedValue(owners("user-1"));

    await sendWithTimers([alert()]);

    expect(fetchReviewsMock.mock.calls[0][0]).toBe("gbp-access-2");
  });

  it(`reads no listing again once ${REVIEW_ALERT_FETCH_BUDGET_MS / 1000} seconds have passed; the email goes without excerpts`, async () => {
    useRows([row({ id: "a" }), row({ id: "b" })]);
    db.memberFindMany.mockResolvedValue(owners("user-1"));
    const times = [0, 0, REVIEW_ALERT_FETCH_BUDGET_MS + 1];
    const clock = () => times.shift() ?? REVIEW_ALERT_FETCH_BUDGET_MS + 1;

    await sendWithTimers([alert({ connectionId: "a" }), alert({ connectionId: "b" })], clock);

    expect(fetchReviewsMock).toHaveBeenCalledTimes(1);
    expect(sendEmailMock.mock.calls[1][0].html).toContain("Open Reviews to read it.");
  });

  it("saves the marker after the emails were attempted", async () => {
    db.memberFindMany.mockResolvedValue(owners("user-1"));
    const order: string[] = [];
    sendEmailMock.mockImplementation(async () => void order.push("send"));
    db.connectionUpdate.mockImplementation(async () => void order.push("save"));

    await sendWithTimers([alert()]);

    expect(order).toEqual(["send", "save"]);
    expect(db.connectionUpdate.mock.calls[0][0].data.metadata).toMatchObject({
      reviewsSeenThrough: "2026-11-10T08:00:00Z",
      reviewsSeenFor: LOCATION,
      reviewsCheckedAt: NOW.toISOString(),
    });
  });

  it("still saves the marker when no owner wants the email, and reads nothing from Google", async () => {
    db.memberFindMany.mockResolvedValue([]);

    await sendWithTimers([alert()]);

    expect(sendEmailMock).not.toHaveBeenCalled();
    expect(fetchReviewsMock).not.toHaveBeenCalled();
    expect(db.connectionUpdate).toHaveBeenCalledTimes(1);
  });

  it("makes no request at all with nothing to send", async () => {
    await expect(sendWithTimers([])).resolves.toEqual({ sent: 0, failed: 0, left: 0 });
    expect(fetchReviewsMock).not.toHaveBeenCalled();
    expect(db.memberFindMany).not.toHaveBeenCalled();
  });

  it("sends nothing for a listing whose location was changed since the check", async () => {
    useRows([row({ metadata: { locationName: OTHER_LOCATION } })]);
    db.memberFindMany.mockResolvedValue(owners("user-1"));

    await sendWithTimers([alert()]);

    expect(sendEmailMock).not.toHaveBeenCalled();
    expect(db.connectionUpdate).not.toHaveBeenCalled();
  });

  it("retries a retryable failure once with the same key, and counts it sent", async () => {
    db.memberFindMany.mockResolvedValue(owners("user-1"));
    sendEmailMock.mockRejectedValueOnce(rateLimited());

    const result = await sendWithTimers([alert()]);

    expect(sendEmailMock).toHaveBeenCalledTimes(2);
    expect(sendEmailMock.mock.calls[1][1]).toEqual(sendEmailMock.mock.calls[0][1]);
    expect(result).toEqual({ sent: 1, failed: 0, left: 0 });
  });

  it("logs a send that fails after its retry, carries on, and still moves the marker", async () => {
    db.memberFindMany.mockResolvedValue(owners("user-1", "user-2"));
    sendEmailMock.mockRejectedValueOnce(serverError()).mockRejectedValueOnce(serverError());

    const result = await sendWithTimers([alert()]);

    expect(sendEmailMock.mock.calls.map(([params]) => params.to)).toEqual([
      "user-1@example.com",
      "user-1@example.com",
      "user-2@example.com",
    ]);
    expect(result).toEqual({ sent: 1, failed: 1, left: 0 });
    expect(loggerMock.error).toHaveBeenCalledTimes(1);
    expect(db.connectionUpdate).toHaveBeenCalledTimes(1);
  });

  it("does not retry an error that is not retryable", async () => {
    db.memberFindMany.mockResolvedValue(owners("user-1"));
    sendEmailMock.mockRejectedValueOnce(new Error("boom"));

    const result = await sendWithTimers([alert()]);

    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ sent: 0, failed: 1, left: 0 });
  });

  it("keeps going to the next connection when one connection's owners cannot be read", async () => {
    useRows([row({ id: "a" }), row({ id: "b", workspaceId: "ws-2" })]);
    db.memberFindMany.mockRejectedValueOnce(new Error("db blip")).mockResolvedValueOnce(owners("user-2"));

    const result = await sendWithTimers([alert({ connectionId: "a" }), alert({ connectionId: "b", workspaceId: "ws-2" })]);

    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    expect(result.sent).toBe(1);
  });

  it(`sends at most ${REVIEW_ALERT_MAX_EMAILS_PER_RUN} emails a run; a connection left over keeps its marker for tomorrow`, async () => {
    expect(REVIEW_ALERT_MAX_EMAILS_PER_RUN).toBe(40);
    const ids = Array.from({ length: REVIEW_ALERT_MAX_EMAILS_PER_RUN + 3 }, (_, i) => `c-${i}`);
    useRows(ids.map((id) => row({ id })));
    db.memberFindMany.mockImplementation(async () => owners("user-1"));

    const result = await sendWithTimers(ids.map((id) => alert({ connectionId: id })));

    expect(sendEmailMock).toHaveBeenCalledTimes(REVIEW_ALERT_MAX_EMAILS_PER_RUN);
    expect(db.connectionUpdate).toHaveBeenCalledTimes(REVIEW_ALERT_MAX_EMAILS_PER_RUN);
    expect(result).toEqual({ sent: REVIEW_ALERT_MAX_EMAILS_PER_RUN, failed: 0, left: 3 });
  });

  it("links the email to the Reviews page", async () => {
    vi.stubEnv("NEXTAUTH_URL", "https://app.example");
    db.memberFindMany.mockResolvedValue(owners("user-1"));

    await sendWithTimers([alert()]);

    expect(sendEmailMock.mock.calls[0][0].html).toContain('href="https://app.example/reviews"');
  });
});
