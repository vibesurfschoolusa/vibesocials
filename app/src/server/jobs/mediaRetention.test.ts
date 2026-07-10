import { describe, expect, it } from "vitest";

import {
  RETENTION_DAYS,
  TERMINAL_POST_JOB_STATUSES,
  isMediaSweepEligible,
  type MediaSweepEligibilityInput,
} from "./mediaRetention";

const NOW = new Date("2026-07-10T03:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (n: number): Date => new Date(NOW.getTime() - n * DAY);

// A fully-eligible baseline: posted, no active job, not soft-deleted, and stale.
// Individual tests flip one field to assert that field's effect in isolation.
function input(
  overrides: Partial<MediaSweepEligibilityInput> = {},
): MediaSweepEligibilityInput {
  return {
    deletedAt: null,
    hasNonTerminalJob: false,
    hasAnyJob: true,
    lastUsedAt: daysAgo(45),
    createdAt: daysAgo(60),
    now: NOW,
    retentionDays: RETENTION_DAYS,
    ...overrides,
  };
}

describe("isMediaSweepEligible", () => {
  it("sweeps a posted item that is old and has no active job", () => {
    expect(isMediaSweepEligible(input())).toBe(true);
  });

  it("exempts a never-posted library upload even when old (hasAnyJob = false)", () => {
    // lastUsedAt = null and no PostJob: this is a user library upload, exempt
    // from age-based sweeping regardless of how old it is.
    expect(
      isMediaSweepEligible(
        input({ hasAnyJob: false, lastUsedAt: null, createdAt: daysAgo(365) }),
      ),
    ).toBe(false);
  });

  it("does NOT sweep an item referenced by a non-terminal job (e.g. scheduled/pending)", () => {
    expect(isMediaSweepEligible(input({ hasNonTerminalJob: true }))).toBe(false);
  });

  it("does NOT sweep an already soft-deleted item (blob already removed)", () => {
    expect(isMediaSweepEligible(input({ deletedAt: daysAgo(1) }))).toBe(false);
  });

  it("does NOT sweep a posted item used recently (within the window)", () => {
    expect(isMediaSweepEligible(input({ lastUsedAt: daysAgo(5) }))).toBe(false);
  });

  it("falls back to createdAt for the age gate when lastUsedAt is null but the item was posted", () => {
    // Posted (hasAnyJob) yet never stamped (older code path / edge): a stale
    // createdAt still makes it eligible.
    expect(
      isMediaSweepEligible(
        input({ lastUsedAt: null, createdAt: daysAgo(31) }),
      ),
    ).toBe(true);
  });

  it("is NOT eligible when lastUsedAt is null and createdAt is recent (posted, but young)", () => {
    expect(
      isMediaSweepEligible(input({ lastUsedAt: null, createdAt: daysAgo(2) })),
    ).toBe(false);
  });

  it("lets a recent lastUsedAt keep an item alive even if createdAt is ancient", () => {
    // lastUsedAt wins over createdAt: a reused-but-old upload stays retained.
    expect(
      isMediaSweepEligible(
        input({ lastUsedAt: daysAgo(1), createdAt: daysAgo(400) }),
      ),
    ).toBe(false);
  });

  it("treats the exact retention boundary as NOT stale (strict <, age basis == cutoff)", () => {
    // ageBasis exactly RETENTION_DAYS old => now - basis == window => not < cutoff.
    const lastUsedAt = new Date(NOW.getTime() - RETENTION_DAYS * DAY);
    expect(isMediaSweepEligible(input({ lastUsedAt }))).toBe(false);
  });

  it("sweeps one millisecond past the retention boundary", () => {
    const lastUsedAt = new Date(NOW.getTime() - RETENTION_DAYS * DAY - 1);
    expect(isMediaSweepEligible(input({ lastUsedAt }))).toBe(true);
  });

  it("honours a custom retentionDays window", () => {
    const lastUsedAt = daysAgo(10);
    expect(isMediaSweepEligible(input({ lastUsedAt, retentionDays: 7 }))).toBe(true);
    expect(isMediaSweepEligible(input({ lastUsedAt, retentionDays: 30 }))).toBe(false);
  });
});

describe("retention constants", () => {
  it("defaults the retention window to 30 days", () => {
    expect(RETENTION_DAYS).toBe(30);
  });

  it("treats only completed/failed as terminal (everything else is non-terminal)", () => {
    expect([...TERMINAL_POST_JOB_STATUSES].sort()).toEqual(["completed", "failed"]);
  });
});
