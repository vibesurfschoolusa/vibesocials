import { describe, expect, it } from "vitest";

import { deferralKindFromErrorCode, describeDeferral, selectDeferrals } from "./resultDeferral";

// 2026-11-01 scale audit (platform limits): a result that waits out a platform
// limit stays `pending`; the Activity card tells the user why and until when.
describe("deferralKindFromErrorCode", () => {
  it("maps DAILY_LIMIT to daily_limit", () => {
    expect(deferralKindFromErrorCode("DAILY_LIMIT")).toBe("daily_limit");
  });

  it.each(["RATE_LIMITED", "SOMETHING_ELSE", "", null])("maps %j to rate_limited", (code) => {
    expect(deferralKindFromErrorCode(code)).toBe("rate_limited");
  });
});

describe("describeDeferral", () => {
  const until = new Date("2026-11-02T08:05:00.000Z");

  it("says a daily limit will publish after the reset", () => {
    expect(describeDeferral("YouTube", "daily_limit", until, () => "Nov 2, 12:05 AM")).toBe(
      "YouTube daily limit reached — will publish after Nov 2, 12:05 AM",
    );
  });

  it("says a rate limit will be retried", () => {
    expect(describeDeferral("X", "rate_limited", until, () => "<t>")).toBe(
      "X rate limit reached — will retry after <t>",
    );
  });

  it("formats the instant with the formatter it is given", () => {
    const seen: Date[] = [];
    describeDeferral("TikTok", "rate_limited", until, (d) => {
      seen.push(d);
      return "later";
    });
    expect(seen).toEqual([until]);
  });
});

// Final review F3 (I1): the Activity card reads `result.deferral.kind` for every
// result this selects. A response without the field (an older server during a
// rolling deploy, a cached payload) gives `undefined`, which a `!== null` check
// let through and then crashed the whole card on `.kind`.
describe("selectDeferrals", () => {
  const deferral = { kind: "rate_limited" as const, until: "2026-11-02T08:05:00.000Z" };
  const none = new Set<"x" | "youtube">();

  it("keeps the results that carry a deferral", () => {
    const results = [
      { platform: "x" as const, deferral },
      { platform: "youtube" as const, deferral: null },
    ];

    expect(selectDeferrals(results, none)).toEqual([results[0]]);
  });

  it("does not select a result whose deferral is null", () => {
    expect(selectDeferrals([{ platform: "x" as const, deferral: null }], none)).toEqual([]);
  });

  it("does not select a result whose deferral is missing (undefined), so the card cannot crash on .kind", () => {
    const legacy = { platform: "x" as const } as { platform: "x"; deferral?: typeof deferral | null };

    expect(() => selectDeferrals([legacy], none)).not.toThrow();
    expect(selectDeferrals([legacy], none)).toEqual([]);
    expect(selectDeferrals([{ platform: "x" as const, deferral: undefined }], none)).toEqual([]);
  });

  it("skips platforms that are mid-retry (their optimistic pending state hides the wait)", () => {
    const results = [
      { platform: "x" as const, deferral },
      { platform: "youtube" as const, deferral },
    ];

    expect(selectDeferrals(results, new Set(["x" as const]))).toEqual([results[1]]);
  });
});
