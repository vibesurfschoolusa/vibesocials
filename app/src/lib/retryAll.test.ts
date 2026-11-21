import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { connectionStep, failedRowStep, leftOutSentence, needsReconnecting, retryAllPlan } from "./retryAll";

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

  // R10-client-journey L1: only an owner can reconnect.
  it("a member's sentence names the owner, not Settings", () => {
    const leftOut = [
      { platform: "instagram", reason: "unconfirmed" },
      { platform: "x", reason: "reconnect" },
    ] as const;
    expect(leftOutSentence(leftOut, "member")).toBe(
      "Instagram left out: check whether it posted first. X left out: the workspace owner can reconnect it.",
    );
    expect(leftOutSentence(leftOut, "owner")).toBe(
      "Instagram left out: check whether it posted first. X left out: reconnect it in Settings.",
    );
  });

  it("only unconfirmed or needs-reconnect platforms: nothing covered, both reasons said", () => {
    const plan = retryAllPlan([failed("instagram", true), failed("x")] as never, (p) => p === "x");
    expect(plan.included).toEqual([]);
    expect(leftOutSentence(plan.leftOut)).toBe(
      "Instagram left out: check whether it posted first. X left out: reconnect it in Settings.",
    );
  });

  // R58 pages-a-4 L1: no connection is its own reason; Settings offers only Connect for it.
  it("one platform left out for each reason: unconfirmed, reconnect and connect, each with its own step", () => {
    const plan = retryAllPlan(
      [failed("instagram", true), failed("x"), failed("youtube"), failed("linkedin")] as never,
      (p) => (p === "x" ? "reconnect" : p === "youtube" ? "connect" : null),
    );
    expect(plan).toEqual({
      included: ["linkedin"],
      leftOut: [
        { platform: "instagram", reason: "unconfirmed" },
        { platform: "x", reason: "reconnect" },
        { platform: "youtube", reason: "connect" },
      ],
    });
    expect(leftOutSentence(plan.leftOut, "owner")).toBe(
      "Instagram left out: check whether it posted first. X left out: reconnect it in Settings. YouTube left out: connect it in Settings.",
    );
    expect(leftOutSentence(plan.leftOut, "member")).toBe(
      "Instagram left out: check whether it posted first. X left out: the workspace owner can reconnect it. YouTube left out: the workspace owner can connect it.",
    );
  });

  it("nothing left out: no sentence", () => {
    expect(leftOutSentence([])).toBeNull();
  });
});

// R27 MM4 review: the one rule for the step a failed row gets, shared by the
// Activity card's Retry all failed and the outcome email.
describe("failedRowStep and needsReconnecting", () => {
  it("unconfirmed: check the platform first; a connection that needs reconnecting: reconnect; else retry", () => {
    expect(failedRowStep({ unconfirmed: true }, false)).toBe("check_platform");
    expect(failedRowStep({ unconfirmed: true }, true)).toBe("check_platform");
    expect(failedRowStep({ unconfirmed: false }, true)).toBe("reconnect");
    expect(failedRowStep({ unconfirmed: false }, false)).toBe("retry");
  });

  it("no connection, or one flagged needsReconnect, needs reconnecting", () => {
    expect(needsReconnecting(null)).toBe(true);
    expect(needsReconnecting({ needsReconnect: true })).toBe(true);
    expect(needsReconnecting({ needsReconnect: false })).toBe(false);
  });

  it("connectionStep: no connection is connect, a flagged one is reconnect, a working one needs neither", () => {
    expect(connectionStep(null)).toBe("connect");
    expect(connectionStep(undefined)).toBe("connect");
    expect(connectionStep({ needsReconnect: true })).toBe("reconnect");
    expect(connectionStep({ needsReconnect: false })).toBeNull();
  });

  it("retryAllPlan reads the same rule", () => {
    const source = readFileSync(new URL("./retryAll.ts", import.meta.url), "utf8");
    expect(source).toMatch(/const step = failedRowStep\(result, gap !== null\);/);
  });
});
