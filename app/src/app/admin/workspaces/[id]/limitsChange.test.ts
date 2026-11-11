import { describe, expect, it } from "vitest";

import { limitsChangeBody, type LimitInput } from "./limitsChange";

const FIELDS: LimitInput[] = [
  { field: "limitPostsPerDay", label: "Posts per day", initial: 20, max: 100_000 },
  { field: "limitXPostsPerMonth", label: "X posts per month", initial: null, max: 100_000 },
  { field: "limitYoutubeUploadsPerDay", label: "YouTube uploads per day", initial: 5, max: 100_000 },
  { field: "limitStorageMb", label: "Storage (MB)", initial: null, max: 1_000_000 },
];

function values(overrides: Record<string, string> = {}) {
  return { limitPostsPerDay: "20", limitXPostsPerMonth: "", limitYoutubeUploadsPerDay: "5", limitStorageMb: "", ...overrides };
}

describe("limitsChangeBody", () => {
  it("sends only the field the operator edited", () => {
    expect(limitsChangeBody(FIELDS, values({ limitStorageMb: "2048" }))).toEqual({
      ok: true,
      body: { limitStorageMb: 2048 },
    });
  });

  it("sends null for a field emptied to use the default", () => {
    expect(limitsChangeBody(FIELDS, values({ limitPostsPerDay: " " }))).toEqual({
      ok: true,
      body: { limitPostsPerDay: null },
    });
  });

  it("treats the same number typed again as no edit", () => {
    expect(limitsChangeBody(FIELDS, values({ limitPostsPerDay: " 20 " }))).toEqual({
      ok: false,
      error: "Nothing changed.",
    });
  });

  it("refuses an empty change", () => {
    expect(limitsChangeBody(FIELDS, values())).toEqual({ ok: false, error: "Nothing changed." });
  });

  it("refuses an edited value out of bounds or not whole", () => {
    expect(limitsChangeBody(FIELDS, values({ limitPostsPerDay: "-1" })).ok).toBe(false);
    expect(limitsChangeBody(FIELDS, values({ limitStorageMb: "1000001" })).ok).toBe(false);
    expect(limitsChangeBody(FIELDS, values({ limitXPostsPerMonth: "1.5" })).ok).toBe(false);
  });
});
