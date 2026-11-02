import { describe, expect, it } from "vitest";

import { deferralKindFromErrorCode, describeDeferral } from "./resultDeferral";

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
