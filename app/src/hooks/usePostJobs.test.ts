import { describe, expect, it } from "vitest";

import { hasWorkInFlight } from "./usePostJobs";
import type { PostJobDTO, PostJobResultDTO } from "@/lib/postsDto";

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
    scheduledFor: null,
    caption: "c",
    results: [],
    media: null,
    publish: null,
    // Team Workspaces (Task 4) — irrelevant to hasWorkInFlight; a fixed
    // stand-in like every other field here.
    createdBy: null,
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
