import { describe, expect, it, vi } from "vitest";

import { rateLimitedError } from "@/server/platforms/rateLimited";

import {
  MAX_RATE_LIMIT_RETRIES,
  MAX_RATE_LIMIT_WAIT_MS,
  MIN_RATE_LIMIT_WAIT_MS,
  RATE_LIMIT_BACKOFF_MS,
  resolveDeferral,
  runPlatformStepsWithDeferrals,
  type PlatformStepOutcome,
  type PlatformStepPlan,
} from "./platformSteps";

const T = Date.parse("2026-11-02T10:00:00.000Z");
const HOUR = 3_600_000;

describe("deferral bounds", () => {
  it("pins the documented values", () => {
    expect(MAX_RATE_LIMIT_RETRIES).toBe(3);
    // GBP's documented exponential backoff (plan V17).
    expect([...RATE_LIMIT_BACKOFF_MS]).toEqual([60_000, 900_000, 3_600_000]);
    expect(MIN_RATE_LIMIT_WAIT_MS).toBe(30_000);
    expect(MAX_RATE_LIMIT_WAIT_MS).toBe(86_400_000);
  });
});

// 2026-11-01 scale audit (platform limits): how long a rate-limited platform
// waits before its next attempt - the platform's own hint when it gave one, our
// backoff when it did not, and a bound on both.
describe("resolveDeferral", () => {
  const limited = (retryAt: number | null) => rateLimitedError("x", "rate_limited", retryAt);

  it("uses the platform's retryAt when it gave one", () => {
    expect(resolveDeferral(limited(T + 2 * HOUR), 0, T)).toEqual({ retryAt: T + 2 * HOUR });
  });

  it.each([
    [0, 60_000],
    [1, 900_000],
    [2, 3_600_000],
  ])("with no hint, attempt %i waits the backoff step of %i ms", (attempt, wait) => {
    expect(resolveDeferral(limited(null), attempt, T)).toEqual({ retryAt: T + wait });
  });

  it("gives up once the retries are spent (attempt 3 is the 4th consecutive limit)", () => {
    expect(resolveDeferral(limited(null), 3, T)).toEqual({ giveUp: true });
    expect(resolveDeferral(limited(T + HOUR), 3, T)).toEqual({ giveUp: true });
    expect(resolveDeferral(limited(T + HOUR), 7, T)).toEqual({ giveUp: true });
  });

  it("gives up when the platform asks for more than 24 h", () => {
    expect(resolveDeferral(limited(T + 25 * HOUR), 0, T)).toEqual({ giveUp: true });
    expect(resolveDeferral(limited(T + 24 * HOUR + 1), 0, T)).toEqual({ giveUp: true });
  });

  it("waits exactly 24 h when that is what the platform asks for", () => {
    expect(resolveDeferral(limited(T + 24 * HOUR), 0, T)).toEqual({ retryAt: T + 24 * HOUR });
  });

  it("never waits less than 30 s, even for a hint that is nearly (or already) due", () => {
    expect(resolveDeferral(limited(T + 5_000), 0, T)).toEqual({ retryAt: T + 30_000 });
    expect(resolveDeferral(limited(T - 10_000), 1, T)).toEqual({ retryAt: T + 30_000 });
    expect(resolveDeferral(limited(T + 30_000), 0, T)).toEqual({ retryAt: T + 30_000 });
  });

  it("treats an unusable hint (NaN) like no hint", () => {
    expect(resolveDeferral(limited(Number.NaN), 1, T)).toEqual({ retryAt: T + 900_000 });
  });
});

type FakeStep = {
  run: ReturnType<typeof vi.fn>;
  sleepUntil: ReturnType<typeof vi.fn>;
  /** `run:<id>` / `sleep:<id>` in call order. */
  order: string[];
};

/** Stand-in for Inngest's `step`: runs inline and JSON-round-trips outputs like memoization does. */
function fakeStep(): FakeStep {
  const order: string[] = [];
  return {
    order,
    run: vi.fn(async (id: string, cb: () => unknown) => {
      order.push(`run:${id}`);
      return JSON.parse(JSON.stringify(await cb()));
    }),
    sleepUntil: vi.fn(async (id: string) => {
      order.push(`sleep:${id}`);
    }),
  };
}

function asStep(step: FakeStep) {
  return step as unknown as Parameters<typeof runPlatformStepsWithDeferrals>[0];
}

const iso = (ms: number) => new Date(ms).toISOString();
const ok = (platform: PlatformStepOutcome["platform"]): PlatformStepOutcome => ({ platform, status: "success" });
const deferred = (platform: PlatformStepOutcome["platform"], at: number): PlatformStepOutcome => ({
  platform,
  status: "deferred",
  retryAt: iso(at),
});

/** A plan whose attempt n returns `script[n]` (and records the attempts it was run with). */
function plan(
  platform: PlatformStepPlan["platform"],
  script: PlatformStepOutcome[],
  stepId = `publish-to-${platform}`,
): PlatformStepPlan & { attempts: number[] } {
  const attempts: number[] = [];
  return {
    platform,
    stepId,
    attempts,
    run: vi.fn(async (attempt: number) => {
      attempts.push(attempt);
      return script[attempt] ?? ok(platform);
    }),
  };
}

describe("runPlatformStepsWithDeferrals", () => {
  it("runs every platform once, in plan order, when nothing is deferred", async () => {
    const step = fakeStep();
    const plans = [plan("x", [ok("x")]), plan("youtube", [ok("youtube")])];

    const out = await runPlatformStepsWithDeferrals(asStep(step), plans);

    expect(step.order).toEqual(["run:publish-to-x", "run:publish-to-youtube"]);
    expect(step.sleepUntil).not.toHaveBeenCalled();
    expect(out).toEqual([ok("x"), ok("youtube")]);
  });

  // The plan's Task 5 scenario: a sleeping YouTube must never delay LinkedIn.
  it("runs the first pass for every platform, then sleeps and retries the deferred one", async () => {
    const step = fakeStep();
    const youtube = plan("youtube", [deferred("youtube", T + 10 * HOUR), ok("youtube")]);
    const plans = [plan("x", [ok("x")]), youtube, plan("linkedin", [ok("linkedin")])];

    const out = await runPlatformStepsWithDeferrals(asStep(step), plans);

    expect(step.order).toEqual([
      "run:publish-to-x",
      "run:publish-to-youtube",
      "run:publish-to-linkedin",
      "sleep:publish-to-youtube-wait-rl1",
      "run:publish-to-youtube-rl1",
    ]);
    expect(step.sleepUntil).toHaveBeenCalledWith("publish-to-youtube-wait-rl1", new Date(T + 10 * HOUR));
    expect(youtube.attempts).toEqual([0, 1]);
    // The final outcome per platform, in plan order.
    expect(out).toEqual([ok("x"), ok("youtube"), ok("linkedin")]);
  });

  it("with two deferred platforms, sleeps for the earlier retryAt first", async () => {
    const step = fakeStep();
    const plans = [
      plan("youtube", [deferred("youtube", T + 10 * HOUR), ok("youtube")]),
      plan("tiktok", [deferred("tiktok", T + 2 * HOUR), ok("tiktok")]),
    ];

    const out = await runPlatformStepsWithDeferrals(asStep(step), plans);

    expect(step.order).toEqual([
      "run:publish-to-youtube",
      "run:publish-to-tiktok",
      "sleep:publish-to-tiktok-wait-rl1",
      "run:publish-to-tiktok-rl1",
      "sleep:publish-to-youtube-wait-rl1",
      "run:publish-to-youtube-rl1",
    ]);
    expect(out).toEqual([ok("youtube"), ok("tiktok")]);
  });

  it("numbers a platform's repeated deferrals -rl1, -rl2, ... and re-orders by the new retryAt", async () => {
    const step = fakeStep();
    const plans = [
      // Deferred again at T+3h, behind linkedin's T+2h.
      plan("x", [deferred("x", T + HOUR), deferred("x", T + 3 * HOUR), ok("x")]),
      plan("linkedin", [deferred("linkedin", T + 2 * HOUR), ok("linkedin")]),
    ];

    const out = await runPlatformStepsWithDeferrals(asStep(step), plans);

    expect(step.order).toEqual([
      "run:publish-to-x",
      "run:publish-to-linkedin",
      "sleep:publish-to-x-wait-rl1",
      "run:publish-to-x-rl1",
      "sleep:publish-to-linkedin-wait-rl1",
      "run:publish-to-linkedin-rl1",
      "sleep:publish-to-x-wait-rl2",
      "run:publish-to-x-rl2",
    ]);
    expect(out).toEqual([ok("x"), ok("linkedin")]);
  });

  it("breaks a retryAt tie in plan order", async () => {
    const step = fakeStep();
    const plans = [
      plan("x", [deferred("x", T + HOUR), ok("x")]),
      plan("linkedin", [deferred("linkedin", T + HOUR), ok("linkedin")]),
    ];

    await runPlatformStepsWithDeferrals(asStep(step), plans);

    expect(step.order.slice(2)).toEqual([
      "sleep:publish-to-x-wait-rl1",
      "run:publish-to-x-rl1",
      "sleep:publish-to-linkedin-wait-rl1",
      "run:publish-to-linkedin-rl1",
    ]);
  });

  it("builds the ids from each plan's stepId, so the retry function keeps retry-<platform>", async () => {
    const step = fakeStep();
    const plans = [plan("youtube", [deferred("youtube", T + HOUR), ok("youtube")], "retry-youtube")];

    await runPlatformStepsWithDeferrals(asStep(step), plans);

    expect(step.order).toEqual([
      "run:retry-youtube",
      "sleep:retry-youtube-wait-rl1",
      "run:retry-youtube-rl1",
    ]);
  });

  it("passes a failed or skipped final outcome through unchanged", async () => {
    const step = fakeStep();
    const failed: PlatformStepOutcome = { platform: "x", status: "failed", error: "nope" };
    const plans = [plan("x", [failed]), plan("youtube", [{ platform: "youtube", status: "skipped" }])];

    const out = await runPlatformStepsWithDeferrals(asStep(step), plans);

    expect(out).toEqual([failed, { platform: "youtube", status: "skipped" }]);
    expect(step.sleepUntil).not.toHaveBeenCalled();
  });

  it("does nothing for an empty plan list", async () => {
    const step = fakeStep();
    expect(await runPlatformStepsWithDeferrals(asStep(step), [])).toEqual([]);
    expect(step.run).not.toHaveBeenCalled();
  });

  // A plan reports `deferred` only while resolveDeferral still allows another
  // attempt, so this is a contract violation. It must stop the run (and let the
  // onFailure handler fail the pending result) rather than loop toward Inngest's
  // 1,000-step limit.
  it("throws instead of looping when a platform is still deferred after the last allowed attempt", async () => {
    const step = fakeStep();
    const stuck = deferred("x", T + HOUR);
    const plans = [plan("x", [stuck, stuck, stuck, stuck, stuck])];

    await expect(runPlatformStepsWithDeferrals(asStep(step), plans)).rejects.toThrow(/still deferred/);

    expect(step.order).toEqual([
      "run:publish-to-x",
      "sleep:publish-to-x-wait-rl1",
      "run:publish-to-x-rl1",
      "sleep:publish-to-x-wait-rl2",
      "run:publish-to-x-rl2",
      "sleep:publish-to-x-wait-rl3",
      "run:publish-to-x-rl3",
    ]);
  });
});
