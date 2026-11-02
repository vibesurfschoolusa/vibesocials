import { NonRetriableError } from "inngest";
import { describe, expect, it, vi } from "vitest";

import { rateLimitedError } from "@/server/platforms/rateLimited";

import {
  MAX_CONTINUATIONS_PER_RESULT,
  MAX_CONTINUATION_WAIT_MS,
  MAX_RATE_LIMIT_RETRIES,
  MAX_RATE_LIMIT_WAIT_MS,
  MIN_CONTINUATION_SLEEP_MS,
  MIN_RATE_LIMIT_WAIT_MS,
  RATE_LIMIT_BACKOFF_MS,
  resolveContinuation,
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
    // X at 0.25 MB/s needs about 20 steps and LinkedIn's 128 parts plus processing
    // about 23 (plan Task 7); 7 platforms x (40 + 40 sleeps + 6 rate-limit steps)
    // stays under Inngest's 1,000 steps per run.
    expect(MAX_CONTINUATIONS_PER_RESULT).toBe(40);
    // GBP's documented exponential backoff (plan V17).
    expect([...RATE_LIMIT_BACKOFF_MS]).toEqual([60_000, 900_000, 3_600_000]);
    expect(MIN_RATE_LIMIT_WAIT_MS).toBe(30_000);
    // 26 h (ruling R23): YouTube's reset is up to 25 h 5 min away on the fall-back
    // day (the next Pacific midnight plus the 5 min grace), so a day is too short.
    expect(MAX_RATE_LIMIT_WAIT_MS).toBe(93_600_000);
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

  it("gives up when the platform asks for more than 26 h", () => {
    expect(resolveDeferral(limited(T + 27 * HOUR), 0, T)).toEqual({ giveUp: true });
    expect(resolveDeferral(limited(T + 26 * HOUR + 1), 0, T)).toEqual({ giveUp: true });
  });

  // Ruling R23: YouTube's reset can be 25 h 5 min away (fall-back day, plus grace).
  it("waits for a platform that asks for 25 h, and for exactly 26 h", () => {
    expect(resolveDeferral(limited(T + 25 * HOUR), 0, T)).toEqual({ retryAt: T + 25 * HOUR });
    expect(resolveDeferral(limited(T + 25 * HOUR + 5 * 60_000), 0, T)).toEqual({
      retryAt: T + 25 * HOUR + 5 * 60_000,
    });
    expect(resolveDeferral(limited(T + 26 * HOUR), 0, T)).toEqual({ retryAt: T + 26 * HOUR });
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

// 2026-11-02 scale audit (jobs, chunked uploads): when a continuing platform is
// due. The instant is read ONCE, inside the step that reports it, and memoized.
describe("resolveContinuation", () => {
  it("pins the documented values", () => {
    expect(MIN_CONTINUATION_SLEEP_MS).toBe(1_000);
    expect(MAX_CONTINUATION_WAIT_MS).toBe(900_000);
  });

  it("null means now: due at the step's end, no sleep", () => {
    expect(resolveContinuation(null, T)).toEqual({ resumeAt: iso(T), sleep: false });
  });

  it("sleeps until the instant the client asked for when it is at least a second away", () => {
    expect(resolveContinuation(T + 60_000, T)).toEqual({ resumeAt: iso(T + 60_000), sleep: true });
    expect(resolveContinuation(T + 1_000, T)).toEqual({ resumeAt: iso(T + 1_000), sleep: true });
  });

  it("does not sleep for a shorter wait, but still reports when it is due", () => {
    expect(resolveContinuation(T + 999, T)).toEqual({ resumeAt: iso(T + 999), sleep: false });
  });

  it("never reports an instant in the past", () => {
    expect(resolveContinuation(T - 60_000, T)).toEqual({ resumeAt: iso(T), sleep: false });
  });

  it("caps the wait at 15 minutes", () => {
    expect(resolveContinuation(T + 5 * HOUR, T)).toEqual({ resumeAt: iso(T + 900_000), sleep: true });
    expect(resolveContinuation(T + 900_000, T)).toEqual({ resumeAt: iso(T + 900_000), sleep: true });
  });

  it("treats an unusable instant (NaN) like null", () => {
    expect(resolveContinuation(Number.NaN, T)).toEqual({ resumeAt: iso(T), sleep: false });
    expect(resolveContinuation(Number.POSITIVE_INFINITY, T)).toEqual({ resumeAt: iso(T), sleep: false });
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

const cont = (
  platform: PlatformStepOutcome["platform"],
  at: number,
  sleep: boolean,
): PlatformStepOutcome => ({ platform, status: "continue", resumeAt: iso(at), sleep });

/**
 * A plan whose n-th CALL (0-based, whatever its attempt and continuation) returns
 * `script[n]`; `calls` records the `(attempt, continuation)` pairs it was run with.
 */
function scripted(
  platform: PlatformStepPlan["platform"],
  script: PlatformStepOutcome[],
  stepId = `publish-to-${platform}`,
): PlatformStepPlan & { calls: Array<[number, number]> } {
  const calls: Array<[number, number]> = [];
  return {
    platform,
    stepId,
    calls,
    run: vi.fn(async (attempt: number, continuation: number) => {
      calls.push([attempt, continuation]);
      return script[calls.length - 1] ?? ok(platform);
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

// 2026-11-02 scale audit (jobs, chunked uploads): a platform step that made
// progress but has more to do reports `continue` (inngest-functions.ts
// publishToPlatform) and the run calls it again in `<stepId>-c<n>`, after
// `<stepId>-wait-c<n>` when it asked to wait. Continuations and rate-limit
// deferrals share one queue, ordered by the instant each platform is next due.
describe("runPlatformStepsWithDeferrals - continuation steps", () => {
  it("runs a continuing platform again as -c1, sleeping first only when it asked to", async () => {
    const step = fakeStep();
    const x = scripted("x", [cont("x", T + 1_000, false), ok("x")]);
    const youtube = scripted("youtube", [cont("youtube", T + 60_000, true), ok("youtube")]);

    const out = await runPlatformStepsWithDeferrals(asStep(step), [x, youtube]);

    expect(step.order).toEqual([
      "run:publish-to-x",
      "run:publish-to-youtube",
      "run:publish-to-x-c1",
      "sleep:publish-to-youtube-wait-c1",
      "run:publish-to-youtube-c1",
    ]);
    expect(step.sleepUntil).toHaveBeenCalledTimes(1);
    expect(step.sleepUntil).toHaveBeenCalledWith("publish-to-youtube-wait-c1", new Date(T + 60_000));
    expect(out).toEqual([ok("x"), ok("youtube")]);
  });

  it("runs the continuation step with (attempt, continuation) = (0, 1)", async () => {
    const step = fakeStep();
    const x = scripted("x", [cont("x", T, false), ok("x")]);

    await runPlatformStepsWithDeferrals(asStep(step), [x]);

    expect(x.calls).toEqual([
      [0, 0],
      [0, 1],
    ]);
    expect(x.run).toHaveBeenLastCalledWith(0, 1);
  });

  it("numbers repeated continuations -c1, -c2, ... and keeps the sleeps in their own -wait-c<n> ids", async () => {
    const step = fakeStep();
    const x = scripted("x", [
      cont("x", T, false),
      cont("x", T + 30_000, true),
      cont("x", T + 31_000, false),
      ok("x"),
    ]);

    await runPlatformStepsWithDeferrals(asStep(step), [x]);

    expect(step.order).toEqual([
      "run:publish-to-x",
      "run:publish-to-x-c1",
      "sleep:publish-to-x-wait-c2",
      "run:publish-to-x-c2",
      "run:publish-to-x-c3",
    ]);
  });

  it("builds the ids from each plan's stepId, so the retry function keeps retry-<platform>", async () => {
    const step = fakeStep();
    const x = scripted("x", [cont("x", T + 5_000, true), ok("x")], "retry-x");

    await runPlatformStepsWithDeferrals(asStep(step), [x]);

    expect(step.order).toEqual(["run:retry-x", "sleep:retry-x-wait-c1", "run:retry-x-c1"]);
  });

  // The two counters are independent and only ever grow, so an id is never reused.
  it("counts -c<n> and -rl<n> independently: continue, deferred, continue, success", async () => {
    const step = fakeStep();
    const x = scripted("x", [
      cont("x", T, false),
      deferred("x", T + HOUR),
      cont("x", T + HOUR, false),
      ok("x"),
    ]);

    const out = await runPlatformStepsWithDeferrals(asStep(step), [x]);

    expect(step.order).toEqual([
      "run:publish-to-x",
      "run:publish-to-x-c1",
      "sleep:publish-to-x-wait-rl1",
      "run:publish-to-x-rl1",
      "run:publish-to-x-c2",
    ]);
    // The -rl1 attempt is the 1st wait and the 1st continuation behind it: (1, 1).
    expect(x.calls).toEqual([
      [0, 0],
      [0, 1],
      [1, 1],
      [1, 2],
    ]);
    expect(out).toEqual([ok("x")]);
  });

  it("orders continuing and deferred platforms together by the instant each is due, plan order breaking a tie", async () => {
    const step = fakeStep();
    const plans = [
      scripted("x", [cont("x", T + 50_000, true), ok("x")]),
      scripted("linkedin", [deferred("linkedin", T + 20_000), ok("linkedin")]),
      scripted("youtube", [cont("youtube", T + 20_000, true), ok("youtube")]),
    ];

    await runPlatformStepsWithDeferrals(asStep(step), plans);

    expect(step.order.slice(3)).toEqual([
      // linkedin and youtube are due together: plan order puts linkedin first.
      "sleep:publish-to-linkedin-wait-rl1",
      "run:publish-to-linkedin-rl1",
      "sleep:publish-to-youtube-wait-c1",
      "run:publish-to-youtube-c1",
      "sleep:publish-to-x-wait-c1",
      "run:publish-to-x-c1",
    ]);
  });

  it("interleaves two platforms that keep continuing at once", async () => {
    const step = fakeStep();
    const plans = [
      scripted("x", [cont("x", T + 1, false), cont("x", T + 3, false), ok("x")]),
      scripted("youtube", [cont("youtube", T + 2, false), cont("youtube", T + 4, false), ok("youtube")]),
    ];

    await runPlatformStepsWithDeferrals(asStep(step), plans);

    expect(step.order).toEqual([
      "run:publish-to-x",
      "run:publish-to-youtube",
      "run:publish-to-x-c1",
      "run:publish-to-youtube-c1",
      "run:publish-to-x-c2",
      "run:publish-to-youtube-c2",
    ]);
    expect(step.sleepUntil).not.toHaveBeenCalled();
  });

  it("allows exactly MAX_CONTINUATIONS_PER_RESULT continuation steps", async () => {
    const step = fakeStep();
    const script = Array.from({ length: MAX_CONTINUATIONS_PER_RESULT }, () => cont("x", T, false));
    const x = scripted("x", [...script, ok("x")]);

    const out = await runPlatformStepsWithDeferrals(asStep(step), [x]);

    expect(step.order.at(-1)).toBe(`run:publish-to-x-c${MAX_CONTINUATIONS_PER_RESULT}`);
    expect(x.calls).toHaveLength(MAX_CONTINUATIONS_PER_RESULT + 1);
    expect(out).toEqual([ok("x")]);
  });

  // A plan reports `continue` only while publishToPlatform still allows another
  // step, so a 41st is a contract violation. Stop (and let onFailure fail the
  // pending result) instead of looping toward Inngest's 1,000-step limit.
  it("throws a NonRetriableError before a 41st continuation step", async () => {
    const step = fakeStep();
    const x = scripted(
      "x",
      Array.from({ length: MAX_CONTINUATIONS_PER_RESULT + 1 }, () => cont("x", T, false)),
    );

    const failure = await runPlatformStepsWithDeferrals(asStep(step), [x]).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(NonRetriableError);
    expect((failure as Error).message).toMatch(/continu/i);
    expect(step.order).not.toContain(`run:publish-to-x-c${MAX_CONTINUATIONS_PER_RESULT + 1}`);
    expect(step.order.at(-1)).toBe(`run:publish-to-x-c${MAX_CONTINUATIONS_PER_RESULT}`);
    expect(x.calls).toHaveLength(MAX_CONTINUATIONS_PER_RESULT + 1);
  });

  it("counts the cap per platform, not per run", async () => {
    const step = fakeStep();
    const long = (platform: "x" | "youtube") =>
      scripted(platform, [
        ...Array.from({ length: MAX_CONTINUATIONS_PER_RESULT }, () => cont(platform, T, false)),
        ok(platform),
      ]);

    const out = await runPlatformStepsWithDeferrals(asStep(step), [long("x"), long("youtube")]);

    expect(out).toEqual([ok("x"), ok("youtube")]);
  });
});

// 2026-11-02 scale audit (jobs): Inngest does not resume a function, it RE-ENTERS
// it from the top for every step and hands each already-finished step its recorded
// output. So the orchestrator must be a pure function of the recorded outputs: the
// same step ids in the same order, and `sleepUntil` targets taken from the
// recorded outcomes (never from the clock), or a run that slept would diverge on
// re-entry. This pins that, ahead of the chunked-upload steps that extend the id
// space (`<id>-c<n>`, `<id>-wait-c<n>`).
describe("runPlatformStepsWithDeferrals replay (memoization)", () => {
  type Call = { kind: "run" | "sleep"; id: string; until?: string };

  /**
   * A replaying `step`: outputs are memoized by id and survive across passes (the
   * `memo`), a memoized id returns its record WITHOUT invoking the callback (or
   * sleeping again), and `calls` is the id sequence of the current pass.
   */
  function replayingStep(memo: Map<string, unknown>) {
    const calls: Call[] = [];
    const fresh = { runs: 0, sleeps: 0 };
    return {
      calls,
      fresh,
      run: vi.fn(async (id: string, cb: () => unknown) => {
        calls.push({ kind: "run", id });
        if (memo.has(id)) return JSON.parse(JSON.stringify(memo.get(id)));
        fresh.runs += 1;
        const out = JSON.parse(JSON.stringify(await cb()));
        memo.set(id, out);
        return out;
      }),
      sleepUntil: vi.fn(async (id: string, until: Date) => {
        calls.push({ kind: "sleep", id, until: until.toISOString() });
        if (memo.has(id)) return;
        fresh.sleeps += 1;
        memo.set(id, null);
      }),
    };
  }

  const asReplaying = (step: ReturnType<typeof replayingStep>) =>
    step as unknown as Parameters<typeof runPlatformStepsWithDeferrals>[0];

  it("a second pass over the same memo runs no plan, sleeps no more, issues the identical ids and sleepUntil targets, and returns equal outcomes", async () => {
    const memo = new Map<string, unknown>();
    const x = plan("x", [ok("x")]);
    const youtube = plan("youtube", [deferred("youtube", T + 10 * HOUR), ok("youtube")]);
    const plans = [x, youtube];

    const first = replayingStep(memo);
    const firstOutcomes = await runPlatformStepsWithDeferrals(asReplaying(first), plans);

    expect(first.calls).toEqual([
      { kind: "run", id: "publish-to-x" },
      { kind: "run", id: "publish-to-youtube" },
      { kind: "sleep", id: "publish-to-youtube-wait-rl1", until: iso(T + 10 * HOUR) },
      { kind: "run", id: "publish-to-youtube-rl1" },
    ]);
    expect(firstOutcomes).toEqual([ok("x"), ok("youtube")]);
    expect(first.fresh).toEqual({ runs: 3, sleeps: 1 });
    expect(x.run).toHaveBeenCalledTimes(1);
    expect(youtube.run).toHaveBeenCalledTimes(2);

    // Re-entry: the orchestrator starts from scratch against the same memo.
    const second = replayingStep(memo);
    const secondOutcomes = await runPlatformStepsWithDeferrals(asReplaying(second), plans);

    expect(second.calls).toEqual(first.calls);
    expect(second.fresh).toEqual({ runs: 0, sleeps: 0 });
    expect(x.run).toHaveBeenCalledTimes(1);
    expect(youtube.run).toHaveBeenCalledTimes(2);
    expect(secondOutcomes).toEqual(firstOutcomes);
  });

  it("replays a platform deferred more than once with the same -rl<n> ids and targets", async () => {
    const memo = new Map<string, unknown>();
    const plans = [
      plan("x", [deferred("x", T + HOUR), deferred("x", T + 3 * HOUR), ok("x")]),
      plan("linkedin", [deferred("linkedin", T + 2 * HOUR), ok("linkedin")]),
    ];

    const first = replayingStep(memo);
    const firstOutcomes = await runPlatformStepsWithDeferrals(asReplaying(first), plans);
    const second = replayingStep(memo);
    const secondOutcomes = await runPlatformStepsWithDeferrals(asReplaying(second), plans);

    expect(second.calls).toEqual(first.calls);
    expect(first.calls.filter((call) => call.kind === "sleep")).toEqual([
      { kind: "sleep", id: "publish-to-x-wait-rl1", until: iso(T + HOUR) },
      { kind: "sleep", id: "publish-to-linkedin-wait-rl1", until: iso(T + 2 * HOUR) },
      { kind: "sleep", id: "publish-to-x-wait-rl2", until: iso(T + 3 * HOUR) },
    ]);
    expect(second.fresh).toEqual({ runs: 0, sleeps: 0 });
    expect(secondOutcomes).toEqual(firstOutcomes);
  });

  it("re-entering after a sleep (memo holds only the earlier steps) re-issues the same ids and runs only what is new", async () => {
    const memo = new Map<string, unknown>();
    const x = plan("x", [ok("x")]);
    const youtube = plan("youtube", [deferred("youtube", T + 10 * HOUR), ok("youtube")]);
    const plans = [x, youtube];

    // The run got as far as the sleep: pass one is recorded, the retry is not.
    memo.set("publish-to-x", ok("x"));
    memo.set("publish-to-youtube", deferred("youtube", T + 10 * HOUR));
    memo.set("publish-to-youtube-wait-rl1", null);

    const reentry = replayingStep(memo);
    const outcomes = await runPlatformStepsWithDeferrals(asReplaying(reentry), plans);

    expect(reentry.calls.map((call) => `${call.kind}:${call.id}`)).toEqual([
      "run:publish-to-x",
      "run:publish-to-youtube",
      "sleep:publish-to-youtube-wait-rl1",
      "run:publish-to-youtube-rl1",
    ]);
    expect(reentry.calls[2].until).toBe(iso(T + 10 * HOUR));
    expect(reentry.fresh).toEqual({ runs: 1, sleeps: 0 });
    expect(x.run).not.toHaveBeenCalled();
    expect(youtube.run).toHaveBeenCalledTimes(1);
    expect(youtube.run).toHaveBeenCalledWith(1, 0);
    expect(outcomes).toEqual([ok("x"), ok("youtube")]);
  });

  it("replays a continuation sequence (-c<n>, -wait-c<n>, mixed with a deferral) with no new run or sleep, the same ids and the same targets", async () => {
    const memo = new Map<string, unknown>();
    const x = scripted("x", [
      cont("x", T + 1_000, false),
      cont("x", T + 90_000, true),
      deferred("x", T + 3 * HOUR),
      ok("x"),
    ]);
    const youtube = scripted("youtube", [cont("youtube", T + 2_000, true), ok("youtube")]);
    const plans = [x, youtube];

    const first = replayingStep(memo);
    const firstOutcomes = await runPlatformStepsWithDeferrals(asReplaying(first), plans);

    expect(first.calls.map((call) => `${call.kind}:${call.id}`)).toEqual([
      "run:publish-to-x",
      "run:publish-to-youtube",
      "run:publish-to-x-c1",
      "sleep:publish-to-youtube-wait-c1",
      "run:publish-to-youtube-c1",
      "sleep:publish-to-x-wait-c2",
      "run:publish-to-x-c2",
      "sleep:publish-to-x-wait-rl1",
      "run:publish-to-x-rl1",
    ]);
    expect(firstOutcomes).toEqual([ok("x"), ok("youtube")]);
    expect(first.fresh).toEqual({ runs: 6, sleeps: 3 });
    expect(x.calls).toHaveLength(4);
    expect(youtube.calls).toHaveLength(2);

    // Re-entry: the orchestrator starts from scratch against the same memo.
    const second = replayingStep(memo);
    const secondOutcomes = await runPlatformStepsWithDeferrals(asReplaying(second), plans);

    expect(second.calls).toEqual(first.calls);
    expect(second.fresh).toEqual({ runs: 0, sleeps: 0 });
    // No plan ran again: the memoized outcomes decided everything.
    expect(x.calls).toHaveLength(4);
    expect(youtube.calls).toHaveLength(2);
    expect(secondOutcomes).toEqual(firstOutcomes);
  });

  it("re-entering mid-continuation (the memo ends after a sleep) re-issues the same ids and runs only the new -c<n> step", async () => {
    const memo = new Map<string, unknown>();
    // Only the -c1 step is live: the plan's first call is the one after the sleep.
    const x = scripted("x", [ok("x")]);

    memo.set("publish-to-x", cont("x", T + 90_000, true));
    memo.set("publish-to-x-wait-c1", null);

    const reentry = replayingStep(memo);
    const outcomes = await runPlatformStepsWithDeferrals(asReplaying(reentry), [x]);

    expect(reentry.calls.map((call) => `${call.kind}:${call.id}`)).toEqual([
      "run:publish-to-x",
      "sleep:publish-to-x-wait-c1",
      "run:publish-to-x-c1",
    ]);
    expect(reentry.calls[1].until).toBe(iso(T + 90_000));
    expect(reentry.fresh).toEqual({ runs: 1, sleeps: 0 });
    expect(x.run).toHaveBeenCalledTimes(1);
    expect(x.run).toHaveBeenCalledWith(0, 1);
    expect(outcomes).toEqual([ok("x")]);
  });
});
