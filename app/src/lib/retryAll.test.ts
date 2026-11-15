import { describe, expect, it } from "vitest";

import { leftOutSentence, retryAllPlan } from "./retryAll";

// R7 review, points 1 and 2: the one rule for what Retry all failed covers.
describe("retryAllPlan", () => {
  const failed = (platform: string, unconfirmed = false) => ({ platform, status: "failed", unconfirmed }) as const;

  it("X, Facebook and LinkedIn failed, Instagram unconfirmed: the three, Instagram left out", () => {
    const plan = retryAllPlan(
      [failed("x"), failed("facebook_page"), failed("instagram", true), failed("linkedin"), { platform: "youtube", status: "success", unconfirmed: false }] as never,
      () => false,
    );
    expect(plan).toEqual({
      included: ["x", "facebook_page", "linkedin"],
      leftOut: [{ platform: "instagram", reason: "unconfirmed" }],
    });
    expect(leftOutSentence(plan.leftOut)).toBe("Instagram left out: check whether it posted first.");
  });

  it("one platform needs reconnecting: the others, and the sentence names it", () => {
    const plan = retryAllPlan([failed("x"), failed("facebook_page"), failed("linkedin")] as never, (p) => p === "x");
    expect(plan.included).toEqual(["facebook_page", "linkedin"]);
    expect(leftOutSentence(plan.leftOut)).toBe("X left out: reconnect it in Settings.");
  });

  it("only unconfirmed or needs-reconnect platforms: nothing covered, both reasons said", () => {
    const plan = retryAllPlan([failed("instagram", true), failed("x")] as never, (p) => p === "x");
    expect(plan.included).toEqual([]);
    expect(leftOutSentence(plan.leftOut)).toBe(
      "Instagram left out: check whether it posted first. X left out: reconnect it in Settings.",
    );
  });

  it("nothing left out: no sentence", () => {
    expect(leftOutSentence([])).toBeNull();
  });
});
