import type { PostJobResultStatus } from "@prisma/client";
import { describe, expect, it } from "vitest";

import { recomputePostJobStatus } from "./postStatus";

/** Small helper: build a result list from bare status strings. */
function results(...statuses: PostJobResultStatus[]): { status: PostJobResultStatus }[] {
  return statuses.map((status) => ({ status }));
}

describe("recomputePostJobStatus (pure, over ALL results)", () => {
  it("all success -> completed", () => {
    expect(recomputePostJobStatus(results("success", "success", "success"))).toBe(
      "completed",
    );
  });

  it("mixed success + failed (none pending) -> completed (partial success still counts)", () => {
    expect(recomputePostJobStatus(results("success", "failed"))).toBe("completed");
    expect(recomputePostJobStatus(results("failed", "success", "failed"))).toBe(
      "completed",
    );
  });

  it("all failed -> failed", () => {
    expect(recomputePostJobStatus(results("failed", "failed"))).toBe("failed");
    expect(recomputePostJobStatus(results("failed"))).toBe("failed");
  });

  it("any pending -> in_progress, regardless of other terminal outcomes", () => {
    // Pending dominates: even alongside a success (a retry re-queued one
    // platform while another already went live) the job is still in flight.
    expect(recomputePostJobStatus(results("pending"))).toBe("in_progress");
    expect(recomputePostJobStatus(results("pending", "success"))).toBe("in_progress");
    expect(recomputePostJobStatus(results("pending", "failed"))).toBe("in_progress");
    expect(
      recomputePostJobStatus(results("success", "failed", "pending")),
    ).toBe("in_progress");
  });

  it("empty result set -> failed (vacuously: all terminal, none success)", () => {
    expect(recomputePostJobStatus(results())).toBe("failed");
  });

  it("behavior-preserving: matches the original some(success)?completed:failed once nothing is pending", () => {
    // When every platform has run (no pending), the new rule must reduce to the
    // original inline finalize for every terminal combination.
    const terminalCombos: PostJobResultStatus[][] = [
      ["success"],
      ["failed"],
      ["success", "success"],
      ["success", "failed"],
      ["failed", "failed"],
      ["failed", "success", "failed"],
    ];
    for (const combo of terminalCombos) {
      const legacy = combo.some((s) => s === "success") ? "completed" : "failed";
      expect(recomputePostJobStatus(results(...combo))).toBe(legacy);
    }
  });
});
