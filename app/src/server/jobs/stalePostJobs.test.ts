import { describe, expect, it } from "vitest";

import {
  isStalePostJob,
  staleCutoff,
  STALE_AFTER_MS,
  STALE_ELIGIBLE_STATUSES,
} from "./stalePostJobs";
import { TERMINAL_POST_JOB_STATUSES } from "./mediaRetention";

const NOW = new Date("2026-07-25T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms);

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

describe("staleCutoff", () => {
  it("is STALE_AFTER_MS before now", () => {
    expect(staleCutoff(NOW).toISOString()).toBe("2026-07-25T06:00:00.000Z");
    expect(NOW.getTime() - staleCutoff(NOW).getTime()).toBe(STALE_AFTER_MS);
  });
});

describe("isStalePostJob", () => {
  it("sweeps a dispatched job that has not moved past the cutoff", () => {
    // The prod orphans: created pending, never touched again.
    expect(isStalePostJob({ status: "pending", updatedAt: ago(7 * HOUR) }, NOW)).toBe(true);
    expect(isStalePostJob({ status: "in_progress", updatedAt: ago(30 * HOUR) }, NOW)).toBe(true);
  });

  // Failing a job that is still working would report a failure for a post that
  // then publishes anyway — the expensive direction to be wrong in.
  it("leaves a recently-updated in-flight job alone", () => {
    expect(isStalePostJob({ status: "pending", updatedAt: ago(5 * MINUTE) }, NOW)).toBe(false);
    expect(isStalePostJob({ status: "in_progress", updatedAt: ago(3 * HOUR) }, NOW)).toBe(false);
  });

  it("is exclusive at the boundary", () => {
    expect(isStalePostJob({ status: "pending", updatedAt: staleCutoff(NOW) }, NOW)).toBe(false);
    expect(
      isStalePostJob({ status: "pending", updatedAt: ago(STALE_AFTER_MS + 1) }, NOW),
    ).toBe(true);
  });

  // draft/scheduled are non-terminal BY DESIGN and may sit for weeks until the
  // user or the due-scanner promotes them. Sweeping those would silently
  // destroy queued work.
  it("never sweeps draft or scheduled, however old", () => {
    expect(isStalePostJob({ status: "draft", updatedAt: ago(400 * HOUR) }, NOW)).toBe(false);
    expect(isStalePostJob({ status: "scheduled", updatedAt: ago(400 * HOUR) }, NOW)).toBe(false);
  });

  it("never re-sweeps a job that already reached a terminal state", () => {
    for (const status of TERMINAL_POST_JOB_STATUSES) {
      expect(isStalePostJob({ status, updatedAt: ago(400 * HOUR) }, NOW)).toBe(false);
    }
  });

  // The two sets must stay disjoint: anything both "sweepable" and "terminal"
  // would be rewritten to `failed` on every run, forever.
  it("keeps the eligible and terminal status sets disjoint", () => {
    for (const status of STALE_ELIGIBLE_STATUSES) {
      expect(TERMINAL_POST_JOB_STATUSES).not.toContain(status);
    }
  });
});
