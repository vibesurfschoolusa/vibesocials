import { describe, expect, it } from "vitest";

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { limitInputValues, limitsChangeBody, storedLimitsKey, type LimitInput } from "./limitsChange";

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

// Fix round 2: the form stays mounted across the refresh after a save, so its
// "Limits saved." message stays visible; it resets its inputs itself when the
// stored values change, instead of being remounted by a `key`.
describe("keeping the form mounted across a refresh", () => {
  it("gives the inputs for the stored values", () => {
    expect(limitInputValues(FIELDS)).toEqual(values());
  });

  it("keys the stored values, so the form can tell a refresh changed them", () => {
    const after = FIELDS.map((f) => (f.field === "limitStorageMb" ? { ...f, initial: 2048 } : f));
    expect(storedLimitsKey(FIELDS)).toBe(storedLimitsKey([...FIELDS]));
    expect(storedLimitsKey(after)).not.toBe(storedLimitsKey(FIELDS));
  });

  it("the page does not remount the form with a key", () => {
    const page = readFileSync(fileURLToPath(new URL("./page.tsx", import.meta.url)), "utf-8");
    expect(page).toMatch(/<AdminLimitsForm\s/);
    expect(page).not.toMatch(/<AdminLimitsForm[^>]*\skey=/);
  });

  it("the form resets its inputs when the stored values change, keeping its message", () => {
    const form = readFileSync(fileURLToPath(new URL("./admin-controls.tsx", import.meta.url)), "utf-8");
    expect(form).toContain("storedLimitsKey(");
    expect(form).toContain("limitInputValues(");
  });
});
