import { describe, expect, it } from "vitest";

import { formatNextPostTime, needsYouRows, reviewsNeedingReply, type DashboardSummary } from "./needsYou";

const QUIET: DashboardSummary = {
  problemsLast7Days: 0,
  awaitingYourApproval: 0,
  clientChangesRequested: 0,
  nextScheduled: null,
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
