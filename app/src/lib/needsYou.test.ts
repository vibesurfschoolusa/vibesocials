import { describe, expect, it } from "vitest";

import {
  formatNextPostTime,
  hasGoogleListing,
  needsYouRows,
  CHECKING_REVIEWS_TEXT,
  needsYouHeading,
  needsYouView,
  reviewsNeedingReply,
  shouldMountNeedsYou,
  type DashboardSummary,
} from "./needsYou";

const QUIET: DashboardSummary = {
  problemsLast7Days: 0,
  awaitingYourApproval: 0,
  clientChangesRequested: 0,
  nextScheduled: null,
  chooseGoogleLocation: null,
};

const formatTime = (iso: string) => `T(${iso})`;

function rows(summary: Partial<DashboardSummary>, reviews: number | null, role: "owner" | "member" = "owner") {
  return needsYouRows({ ...QUIET, ...summary }, reviews, role, formatTime);
}

describe("needsYouRows", () => {
  it("is all caught up with only the Add many row when nothing applies", () => {
    const result = rows({}, 0);
    expect(result.title).toBe("You're all caught up");
    expect(result.rows).toEqual([
      {
        kind: "add_many",
        text: "Nothing scheduled yet. Plan the next few weeks with Add many.",
        href: "/posts/bulk",
      },
    ]);
  });

  // R5-new-customer L6: with billing on, Add many is offered only when the plan includes it.
  it("offers Create a post instead of Add many when the plan does not include Add many", () => {
    const result = rows({ addManyIncluded: false }, 0);
    expect(result.rows).toEqual([
      { kind: "next_post", text: "Nothing scheduled yet. Create a post to plan the next one.", href: "/posts/new" },
    ]);
    expect(rows({ addManyIncluded: true }, 0).rows.map((row) => row.kind)).toEqual(["add_many"]);
  });

  it("shows the next post row, in the given time format, with its platform count", () => {
    const result = rows({ nextScheduled: { scheduledFor: "2026-11-18T23:00:00.000Z", platformCount: 5 } }, 0);
    expect(result.title).toBe("You're all caught up");
    expect(result.rows).toEqual([
      { kind: "next_post", text: "Next post: T(2026-11-18T23:00:00.000Z), to 5 platforms", href: "/queue" },
    ]);
  });

  it("says 'platform' for a single one", () => {
    const result = rows({ nextScheduled: { scheduledFor: "2026-11-18T23:00:00.000Z", platformCount: 1 } }, 0);
    expect(result.rows[0].text).toBe("Next post: T(2026-11-18T23:00:00.000Z), to 1 platform");
  });

  it("lists every applicable row in order, the next-post row last", () => {
    const result = rows(
      {
        problemsLast7Days: 2,
        awaitingYourApproval: 3,
        clientChangesRequested: 4,
        nextScheduled: { scheduledFor: "x", platformCount: 2 },
      },
      9,
    );
    expect(result.title).toBe("Needs you");
    expect(result.rows).toEqual([
      { kind: "reviews", text: "9 Google reviews need a reply", href: "/reviews" },
      { kind: "problems", text: "2 posts didn't fully go out this week", href: "/activity?show=problems" },
      { kind: "approvals", text: "3 posts are waiting for your approval", href: "/queue" },
      { kind: "client_changes", text: "A client asked for changes on 4 posts", href: "/queue" },
      { kind: "next_post", text: "Next post: T(x), to 2 platforms", href: "/queue" },
    ]);
  });

  it("uses the singular sentences for one", () => {
    const result = rows({ problemsLast7Days: 1, awaitingYourApproval: 1, clientChangesRequested: 1 }, 1);
    expect(result.rows.map((row) => row.text)).toEqual([
      "1 Google review needs a reply",
      "1 post didn't fully go out this week",
      "1 post is waiting for your approval",
      "A client asked for changes on 1 post",
      "Nothing scheduled yet. Plan the next few weeks with Add many.",
    ]);
  });

  it("hides the reviews row when the count is unknown", () => {
    const result = rows({ problemsLast7Days: 1 }, null);
    expect(result.rows.map((row) => row.kind)).toEqual(["problems", "add_many"]);
  });

  it("never gives a member the approval row", () => {
    expect(rows({ awaitingYourApproval: 3 }, 0, "member").rows.map((row) => row.kind)).toEqual(["add_many"]);
    expect(rows({ awaitingYourApproval: null }, 0, "member").title).toBe("You're all caught up");
  });

  it("each single row alone switches the title to Needs you", () => {
    expect(rows({}, 1).title).toBe("Needs you");
    expect(rows({ problemsLast7Days: 1 }, 0).title).toBe("Needs you");
    expect(rows({ awaitingYourApproval: 1 }, 0).title).toBe("Needs you");
    expect(rows({ clientChangesRequested: 1 }, 0).title).toBe("Needs you");
  });
});

describe("reviewsNeedingReply", () => {
  it("counts reviews with no reply", () => {
    expect(
      reviewsNeedingReply({
        reviews: [{ reviewReply: { comment: "Thanks", updateTime: "t" } }, {}, { reviewReply: undefined }],
      }),
    ).toBe(2);
  });

  it("is null for an answer it cannot read", () => {
    expect(reviewsNeedingReply(null)).toBeNull();
    expect(reviewsNeedingReply({})).toBeNull();
    expect(reviewsNeedingReply({ reviews: "nope" })).toBeNull();
  });

  it("is zero for an empty list", () => {
    expect(reviewsNeedingReply({ reviews: [] })).toBe(0);
  });
});

describe("formatNextPostTime", () => {
  it("formats like the Queue, in the browser's time zone", () => {
    const iso = "2026-11-18T23:00:00.000Z";
    expect(formatNextPostTime(iso)).toBe(
      new Date(iso).toLocaleString(undefined, {
        weekday: "short",
        month: "short",
        day: "numeric",
        year: "numeric",
        hour: "numeric",
        minute: "2-digit",
      }),
    );
  });
});

describe("needsYouView", () => {
  it("renders on the summary alone when Google is not connected", () => {
    expect(needsYouView({ summary: "loaded", reviews: "not_asked" })).toBe("card");
    expect(needsYouView({ summary: "loading", reviews: "not_asked" })).toBe("skeleton");
  });

  it("keeps the skeleton while the reviews call is pending, even with the summary in", () => {
    expect(needsYouView({ summary: "loaded", reviews: "pending" })).toBe("skeleton");
    expect(needsYouView({ summary: "loading", reviews: "pending" })).toBe("skeleton");
  });

  it("renders once the reviews call has settled, whatever its answer", () => {
    expect(needsYouView({ summary: "loaded", reviews: "settled" })).toBe("card");
    expect(needsYouView({ summary: "loading", reviews: "settled" })).toBe("skeleton");
  });

  it("shows nothing when the summary failed, whatever the reviews call does", () => {
    expect(needsYouView({ summary: "failed", reviews: "not_asked" })).toBe("nothing");
    expect(needsYouView({ summary: "failed", reviews: "pending" })).toBe("nothing");
    expect(needsYouView({ summary: "failed", reviews: "settled" })).toBe("nothing");
  });

  it("gives the right title once settled reviews are counted (0, n, or failed as null)", () => {
    expect(needsYouRows(QUIET, 0, "owner").title).toBe("You're all caught up");
    expect(needsYouRows(QUIET, 4, "owner").title).toBe("Needs you");
    const failed = needsYouRows(QUIET, null, "owner");
    expect(failed.title).toBe("You're all caught up");
    expect(failed.rows.map((row) => row.kind)).toEqual(["add_many"]);
  });
});

// R36 client-journey L1: a reviews call started after mount keeps the loaded card.
describe("needsYouView: a reviews call started after mount", () => {
  it("keeps the card while checking once the summary is in", () => {
    expect(needsYouView({ summary: "loaded", reviews: "checking" })).toBe("checking");
    expect(needsYouView({ summary: "loading", reviews: "checking" })).toBe("skeleton");
    expect(needsYouView({ summary: "failed", reviews: "checking" })).toBe("nothing");
  });

  it("never says all caught up while checking; the checking line stands in", () => {
    expect(needsYouHeading(needsYouRows(QUIET, null, "owner"), "checking")).toBeNull();
    expect(needsYouHeading(needsYouRows({ ...QUIET, problemsLast7Days: 1 }, null, "owner"), "checking")).toBe("Needs you");
    expect(needsYouHeading(needsYouRows(QUIET, 0, "owner"), "card")).toBe("You're all caught up");
    expect(CHECKING_REVIEWS_TEXT).toBe("Checking Google reviews…");
  });
});

describe("shouldMountNeedsYou", () => {
  const settled = { connectionsLoading: false, postsLoading: false, gettingStartedShowing: false };

  it("mounts once both fetches finished and Get started is not showing", () => {
    expect(shouldMountNeedsYou(settled)).toBe(true);
  });

  it("does not mount while Get started shows", () => {
    expect(shouldMountNeedsYou({ ...settled, gettingStartedShowing: true })).toBe(false);
  });

  it("does not mount while either fetch is still loading", () => {
    expect(shouldMountNeedsYou({ ...settled, connectionsLoading: true })).toBe(false);
    expect(shouldMountNeedsYou({ ...settled, postsLoading: true })).toBe(false);
  });
});

describe("hasGoogleListing", () => {
  it("is true only for a connected Google Business Profile", () => {
    expect(hasGoogleListing([{ platform: "google_business_profile", connected: true }])).toBe(true);
    expect(hasGoogleListing([{ platform: "google_business_profile", connected: false }])).toBe(false);
    expect(hasGoogleListing([{ platform: "instagram", connected: true }])).toBe(false);
  });

  it("is false when the connections fetch failed (no Google call)", () => {
    expect(hasGoogleListing(null)).toBe(false);
  });
});

// F4 (R1 M4): posts to Google fail until the owner chooses the business location.
describe("needsYouRows - the Google business location", () => {
  it("asks the owner to choose it, first, linking to Settings, Connections", () => {
    const result = rows({ chooseGoogleLocation: "Surf Co", problemsLast7Days: 2 }, 1);
    expect(result.title).toBe("Needs you");
    expect(result.rows[0]).toEqual({
      kind: "google_location",
      text: "Choose the Google business location for Surf Co",
      href: "/settings#connections",
    });
    expect(result.rows.map((row) => row.kind)).toEqual(["google_location", "reviews", "problems", "add_many"]);
  });

  it("shows no row for a member, or when no location is missing", () => {
    expect(rows({ chooseGoogleLocation: "Surf Co" }, 0, "member").rows.map((row) => row.kind)).toEqual(["add_many"]);
    expect(rows({}, 0).rows.map((row) => row.kind)).toEqual(["add_many"]);
  });

  it("reads an older answer without the field as no row", () => {
    const { chooseGoogleLocation: _unused, ...older } = QUIET;
    void _unused;
    expect(needsYouRows(older as DashboardSummary, 0, "owner", formatTime).rows.map((row) => row.kind)).toEqual([
      "add_many",
    ]);
  });
});
