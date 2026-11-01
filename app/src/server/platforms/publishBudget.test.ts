import { describe, expect, it } from "vitest";

import {
  budgetedTimeout,
  MIN_REQUEST_WINDOW_MS,
  PUBLISH_BUDGET_EXCEEDED_CODE,
  PUBLISH_STEP_BUDGET_MS,
  publishDeadline,
  remainingMs,
} from "./publishBudget";

// 2026-11-01 audit (Task 4 items 7 + 10): one deadline per publish step,
// comfortably inside Vercel's 300s per-invocation cap, so that everything a
// platform does — in-step retries included — ends in time to record its result.
describe("publish step budget", () => {
  it("leaves headroom under the ~240s step target (and Vercel's 300s cap)", () => {
    expect(PUBLISH_STEP_BUDGET_MS).toBe(225_000);
    expect(PUBLISH_STEP_BUDGET_MS).toBeLessThan(240_000);
  });

  it("publishDeadline is the step start plus the budget", () => {
    expect(publishDeadline(1_000)).toBe(1_000 + PUBLISH_STEP_BUDGET_MS);
  });

  it("remainingMs counts down to (and past) the deadline; no deadline means unbounded", () => {
    expect(remainingMs(10_000, 4_000)).toBe(6_000);
    expect(remainingMs(10_000, 12_000)).toBe(-2_000);
    expect(remainingMs(undefined, 12_000)).toBe(Number.POSITIVE_INFINITY);
  });
});

describe("budgetedTimeout", () => {
  it("keeps a request's own timeout when the budget allows it", () => {
    expect(budgetedTimeout(30_000, 100_000, 0)).toBe(30_000);
  });

  it("clamps the timeout to the time left before the deadline", () => {
    expect(budgetedTimeout(120_000, 100_000, 60_000)).toBe(40_000);
  });

  it("does not clamp without a deadline", () => {
    expect(budgetedTimeout(120_000, undefined, 0)).toBe(120_000);
  });

  it.each([MIN_REQUEST_WINDOW_MS - 1, 0, -5_000])(
    "refuses to start a request with only %ims left (nothing sent, so nothing posted)",
    (left) => {
      let error: (Error & { code?: string }) | null = null;
      try {
        budgetedTimeout(30_000, 100_000 + left, 100_000);
      } catch (e) {
        error = e as Error & { code?: string };
      }
      expect(error?.code).toBe(PUBLISH_BUDGET_EXCEEDED_CODE);
      expect(error?.message).toMatch(/ran out of time/i);
    },
  );

  it("still starts a request with exactly the minimum window left", () => {
    expect(budgetedTimeout(30_000, 100_000 + MIN_REQUEST_WINDOW_MS, 100_000)).toBe(
      MIN_REQUEST_WINDOW_MS,
    );
  });
});
