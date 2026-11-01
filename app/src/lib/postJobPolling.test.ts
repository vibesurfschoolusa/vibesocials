import { describe, expect, it } from "vitest";

import { hasWorkInFlight, settleRetryWatch, shouldPollPostJobs } from "./postJobPolling";
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
