import { describe, expect, it } from "vitest";

import {
  POLLING_STOPPED_HINT,
  decidePollAction,
  hasNewInFlightJob,
  hasWorkInFlight,
  inFlightJobIds,
  nextPollDelayMs,
  settleRetryWatch,
  shouldPollPostJobs,
} from "./postJobPolling";
import type { PostJobDTO, PostJobResultDTO } from "./postsDto";

// Same factory-with-overrides pattern as metricsSummary.test.ts — only the
// fields hasWorkInFlight actually reads (job.status, result.status) vary per
// test; everything else is a fixed, valid stand-in.
function result(partial: Partial<PostJobResultDTO> = {}): PostJobResultDTO {
  return {
    platform: "youtube",
    status: "success",
    externalPostId: "vid",
    errorMessage: null,
    deferral: null,
    metric: null,
    ...partial,
  };
}

function job(partial: Partial<PostJobDTO> = {}): PostJobDTO {
  return {
    id: "job",
    status: "completed",
    createdAt: "2026-07-10T00:00:00.000Z",
    updatedAt: "2026-07-10T00:00:00.000Z",
    scheduledFor: null,
    caption: "c",
    results: [],
    media: null,
    publish: null,
    // Team Workspaces (Task 4) — irrelevant to hasWorkInFlight; a fixed
    // stand-in like every other field here.
    createdBy: null,
    approvalState: "none" as const,
    platformCaptions: null,
    ...partial,
  };
}

describe("hasWorkInFlight", () => {
  it("returns true when a job's status is in_progress", () => {
    expect(hasWorkInFlight([job({ status: "in_progress" })])).toBe(true);
  });

  it("returns true when a job has a pending result even if the job status itself is terminal (a retry in flight)", () => {
    expect(
      hasWorkInFlight([
        job({ status: "failed", results: [result({ status: "pending" })] }),
      ]),
    ).toBe(true);
  });

  it("returns false when every job status and every result status is terminal", () => {
    expect(
      hasWorkInFlight([
        job({ status: "completed", results: [result({ status: "success" })] }),
        job({ status: "failed", results: [result({ status: "failed" })] }),
        job({ status: "cancelled", results: [] }),
      ]),
    ).toBe(false);
  });

  it("returns false for null (no data loaded yet)", () => {
    expect(hasWorkInFlight(null)).toBe(false);
  });

  it("returns false for an empty job list", () => {
    expect(hasWorkInFlight([])).toBe(false);
  });
});

describe("shouldPollPostJobs", () => {
  const none: ReadonlySet<string> = new Set();

  it("polls while the fetched data shows work in flight, with nothing watched", () => {
    expect(shouldPollPostJobs([job({ status: "in_progress" })], none)).toBe(true);
    expect(
      shouldPollPostJobs([job({ status: "failed", results: [result({ status: "pending" })] })], none),
    ).toBe(true);
  });

  it("does not poll an idle list with nothing watched", () => {
    expect(shouldPollPostJobs([job({ status: "completed" })], none)).toBe(false);
    expect(shouldPollPostJobs([], none)).toBe(false);
    expect(shouldPollPostJobs(null, none)).toBe(false);
  });

  it("keeps polling a watched job even though the list still shows everything settled (an accepted retry the server has not reflected yet)", () => {
    // The 2026-11-01 audit bug: after "Retry LinkedIn" succeeded the list still
    // showed the job as failed, so nothing was in flight and the poll never ran.
    const failed = job({ id: "j1", status: "failed", results: [result({ status: "failed" })] });
    expect(shouldPollPostJobs([failed], new Set(["j1"]))).toBe(true);
  });

  it("keeps polling a watched job when the list has not loaded", () => {
    expect(shouldPollPostJobs(null, new Set(["j1"]))).toBe(true);
  });
});

describe("settleRetryWatch", () => {
  const inFlight = job({ id: "j1", status: "in_progress", results: [result({ status: "pending" })] });
  const settled = job({ id: "j1", status: "completed", results: [result({ status: "success" })] });

  it("keeps a watched job while the fresh data still shows it in flight", () => {
    expect([...settleRetryWatch(new Set(["j1"]), [inFlight])]).toEqual(["j1"]);
  });

  it("drops a watched job once the fresh data shows it terminal (success or failed again)", () => {
    expect(settleRetryWatch(new Set(["j1"]), [settled]).size).toBe(0);
    const failedAgain = job({ id: "j1", status: "failed", results: [result({ status: "failed" })] });
    expect(settleRetryWatch(new Set(["j1"]), [failedAgain]).size).toBe(0);
  });

  it("drops a watched job that is not in the fresh page (it can't be observed; never poll forever)", () => {
    expect(settleRetryWatch(new Set(["gone"]), [inFlight]).size).toBe(0);
  });

  it("settles each watched job independently", () => {
    const other = job({ id: "j2", status: "in_progress" });
    expect([...settleRetryWatch(new Set(["j1", "j2"]), [settled, other])]).toEqual(["j2"]);
  });

  it("returns the very same set when nothing changed (no needless state update)", () => {
    const watch: ReadonlySet<string> = new Set(["j1"]);
    expect(settleRetryWatch(watch, [inFlight])).toBe(watch);
    const empty: ReadonlySet<string> = new Set();
    expect(settleRetryWatch(empty, [settled])).toBe(empty);
  });
});

// 2026-11-01 scale audit (W5): the feed poll used to be a flat 10 s with no
// backoff and no pause. nextPollDelayMs is the backoff table; decidePollAction
// is the fetch / skip / stop decision the hook's timer and visibilitychange
// listener defer to.
describe("nextPollDelayMs", () => {
  it.each([
    [0, 10_000],
    [119_999, 10_000],
    [120_000, 30_000],
    [599_999, 30_000],
    [600_000, 60_000],
    [1_799_999, 60_000],
    [1_800_000, null],
  ])("elapsed %i ms -> %s", (elapsedMs, expected) => {
    expect(nextPollDelayMs(elapsedMs)).toBe(expected);
  });

  it("stays stopped for any elapsed time past the 30 minute cap", () => {
    expect(nextPollDelayMs(3_600_000)).toBeNull();
    expect(nextPollDelayMs(Number.MAX_SAFE_INTEGER)).toBeNull();
  });
});

describe("decidePollAction", () => {
  it("fetches on a timer tick while visible and inside the schedule", () => {
    expect(decidePollAction("timer", 0, false)).toBe("fetch");
    expect(decidePollAction("timer", 1_799_999, false)).toBe("fetch");
  });

  it("stops on a timer tick once the schedule has run out", () => {
    expect(decidePollAction("timer", 1_800_000, false)).toBe("stop");
    expect(decidePollAction("timer", 5_000_000, false)).toBe("stop");
  });

  it("skips the fetch while the tab is hidden, and never advances to stopped", () => {
    expect(decidePollAction("timer", 0, true)).toBe("skip");
    expect(decidePollAction("timer", 119_999, true)).toBe("skip");
    // Elapsed time keeps counting while hidden: even far past the cap a hidden
    // tab only skips, so a returning user still gets a fresh fetch.
    expect(decidePollAction("timer", 1_800_000, true)).toBe("skip");
    expect(decidePollAction("timer", 10_000_000, true)).toBe("skip");
  });

  it("fetches immediately when the tab becomes visible, at any point in the schedule", () => {
    expect(decidePollAction("visibility", 0, false)).toBe("fetch");
    expect(decidePollAction("visibility", 599_999, false)).toBe("fetch");
    // Past the cap: the user is looking at a feed whose jobs may have finished
    // while they were away - show fresh state; the re-arm after this fetch
    // then stops the schedule.
    expect(decidePollAction("visibility", 1_800_000, false)).toBe("fetch");
    expect(decidePollAction("visibility", 10_000_000, false)).toBe("fetch");
  });

  it("does nothing on a visibilitychange that turns the tab hidden", () => {
    expect(decidePollAction("visibility", 0, true)).toBe("skip");
    expect(decidePollAction("visibility", 10_000_000, true)).toBe("skip");
  });
});

describe("inFlightJobIds", () => {
  const none: ReadonlySet<string> = new Set();

  it("collects jobs with a running status or a pending result", () => {
    const ids = inFlightJobIds(
      [
        job({ id: "running", status: "in_progress" }),
        job({ id: "retrying", status: "failed", results: [result({ status: "pending" })] }),
        job({ id: "done", status: "completed", results: [result({ status: "success" })] }),
      ],
      none,
    );
    expect([...ids].sort()).toEqual(["retrying", "running"]);
  });

  it("includes watched retry ids even though the list shows them settled", () => {
    const ids = inFlightJobIds(
      [job({ id: "j1", status: "failed", results: [result({ status: "failed" })] })],
      new Set(["j1"]),
    );
    expect([...ids]).toEqual(["j1"]);
  });

  it("counts a job once when it is both in flight and watched", () => {
    const ids = inFlightJobIds([job({ id: "j1", status: "in_progress" })], new Set(["j1"]));
    expect(ids.size).toBe(1);
  });

  it("is empty for null and for an idle list", () => {
    expect(inFlightJobIds(null, none).size).toBe(0);
    expect(inFlightJobIds([job({ status: "completed" })], none).size).toBe(0);
  });

  it("agrees with shouldPollPostJobs about whether anything is in flight", () => {
    const jobs = [job({ id: "j1", status: "in_progress" })];
    expect(inFlightJobIds(jobs, none).size > 0).toBe(shouldPollPostJobs(jobs, none));
    expect(inFlightJobIds(null, new Set(["j1"])).size > 0).toBe(
      shouldPollPostJobs(null, new Set(["j1"])),
    );
  });
});

describe("hasNewInFlightJob", () => {
  it("is true when polling starts (nothing in flight before, something now)", () => {
    expect(hasNewInFlightJob(new Set(), new Set(["a"]))).toBe(true);
  });

  it("is true when another job joins the set (a new publish or a retry)", () => {
    expect(hasNewInFlightJob(new Set(["a"]), new Set(["a", "b"]))).toBe(true);
  });

  it("is false when the same jobs are still in flight (the schedule keeps its place)", () => {
    expect(hasNewInFlightJob(new Set(["a", "b"]), new Set(["b", "a"]))).toBe(false);
  });

  it("is false when jobs only leave the set", () => {
    expect(hasNewInFlightJob(new Set(["a", "b"]), new Set(["a"]))).toBe(false);
    expect(hasNewInFlightJob(new Set(["a"]), new Set())).toBe(false);
  });

  it("is true again when a job that had left re-enters (a second retry)", () => {
    expect(hasNewInFlightJob(new Set(), new Set(["a"]))).toBe(true);
  });
});

describe("POLLING_STOPPED_HINT", () => {
  it("is the exact copy the feed shows once polling gives up", () => {
    expect(POLLING_STOPPED_HINT).toBe("Still processing — refresh to check for updates.");
  });
});
