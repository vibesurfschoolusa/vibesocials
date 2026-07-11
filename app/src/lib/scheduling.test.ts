import { describe, expect, it } from "vitest";

import type { PostJobStatus } from "@prisma/client";

import {
  DELETABLE_POST_JOB_STATUSES,
  MUTABLE_POST_JOB_STATUSES,
  SCHEDULE_BUFFER_MS,
  isValidPerPlatformOverrides,
  localDateTimeToUtcIso,
  postJobStatusForIntent,
  toDateTimeLocalValue,
  validateScheduledFor,
} from "./scheduling";

describe("isValidPerPlatformOverrides (review Minor #3)", () => {
  it("accepts a plain object whose values are all strings (and the empty object)", () => {
    expect(isValidPerPlatformOverrides({})).toBe(true);
    expect(isValidPerPlatformOverrides({ youtube: "yt caption", tiktok: "tt caption" })).toBe(true);
  });

  it("rejects arrays, null, primitives, and objects with non-string values", () => {
    expect(isValidPerPlatformOverrides(["a", "b"])).toBe(false); // array
    expect(isValidPerPlatformOverrides(null)).toBe(false);
    expect(isValidPerPlatformOverrides("caption")).toBe(false);
    expect(isValidPerPlatformOverrides(42)).toBe(false);
    expect(isValidPerPlatformOverrides({ youtube: 5 })).toBe(false); // non-string value
    expect(isValidPerPlatformOverrides({ youtube: { nested: "x" } })).toBe(false);
    expect(isValidPerPlatformOverrides({ youtube: null })).toBe(false);
  });
});

describe("postJobStatusForIntent", () => {
  it("maps each intent to its initial PostJob status", () => {
    expect(postJobStatusForIntent("immediate")).toBe("in_progress");
    expect(postJobStatusForIntent("scheduled")).toBe("scheduled");
    expect(postJobStatusForIntent("draft")).toBe("draft");
  });
});

describe("status guard sets", () => {
  const has = (set: readonly PostJobStatus[], s: PostJobStatus) => set.includes(s);

  it("scheduled/draft are the mutable (edit/cancel/publish-now) set", () => {
    expect(MUTABLE_POST_JOB_STATUSES).toEqual(["scheduled", "draft"]);
    for (const s of ["scheduled", "draft"] as const) {
      expect(has(MUTABLE_POST_JOB_STATUSES, s)).toBe(true);
    }
    for (const s of ["pending", "in_progress", "completed", "failed", "cancelled"] as const) {
      expect(has(MUTABLE_POST_JOB_STATUSES, s)).toBe(false);
    }
  });

  it("draft/cancelled are the hard-deletable set (scheduled must be cancelled first)", () => {
    expect(DELETABLE_POST_JOB_STATUSES).toEqual(["draft", "cancelled"]);
    for (const s of ["pending", "in_progress", "completed", "failed", "scheduled"] as const) {
      expect(has(DELETABLE_POST_JOB_STATUSES, s)).toBe(false);
    }
  });
});

describe("validateScheduledFor", () => {
  const now = new Date("2026-07-10T12:00:00.000Z");

  it("rejects a missing / non-string value", () => {
    expect(validateScheduledFor(undefined, now).ok).toBe(false);
    expect(validateScheduledFor(null, now).ok).toBe(false);
    expect(validateScheduledFor("", now).ok).toBe(false);
    expect(validateScheduledFor(123 as unknown, now).ok).toBe(false);
  });

  it("rejects an unparseable date", () => {
    expect(validateScheduledFor("not-a-date", now).ok).toBe(false);
  });

  it("rejects a time in the past or within the buffer", () => {
    const past = new Date(now.getTime() - 60_000).toISOString();
    expect(validateScheduledFor(past, now).ok).toBe(false);

    // Exactly at the buffer edge is still rejected (must be strictly beyond).
    const edge = new Date(now.getTime() + SCHEDULE_BUFFER_MS - 1).toISOString();
    expect(validateScheduledFor(edge, now).ok).toBe(false);
  });

  it("accepts a time comfortably in the future and returns the Date", () => {
    const future = new Date(now.getTime() + 60 * 60 * 1000).toISOString();
    const result = validateScheduledFor(future, now);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.date.toISOString()).toBe(future);
    }
  });
});

describe("localDateTimeToUtcIso", () => {
  it("returns null for empty/invalid input", () => {
    expect(localDateTimeToUtcIso("")).toBeNull();
    expect(localDateTimeToUtcIso("   ")).toBeNull();
    expect(localDateTimeToUtcIso("nope")).toBeNull();
  });

  it("round-trips with toDateTimeLocalValue (timezone-independent)", () => {
    // Pick a wall-clock instant, format it as the picker would, then convert
    // back — the ISO must represent the same minute regardless of the runner's
    // timezone (both use the local zone).
    const wall = new Date(2026, 6, 10, 14, 30); // local 2026-07-10 14:30
    const local = toDateTimeLocalValue(wall);
    expect(local).toBe("2026-07-10T14:30");

    const iso = localDateTimeToUtcIso(local);
    expect(iso).not.toBeNull();
    expect(new Date(iso as string).getTime()).toBe(wall.getTime());
  });
});
