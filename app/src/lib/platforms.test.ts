import { Platform } from "@prisma/client";
import { describe, expect, it } from "vitest";

import { PLATFORM_CAPTIONS_HEADING, PLATFORM_ORDER, platformCaptionEntries, metricsMaturityNote } from "./platforms";

// Final review (T7): platformCaptionEntries() lists captions in PLATFORM_ORDER
// and drops anything not in it, so a platform added to the Prisma enum but not to
// PLATFORM_ORDER would publish its caption override without the approving owner
// ever seeing it. This fails the build at that moment instead.
describe("PLATFORM_ORDER", () => {
  it("contains every value of the Prisma Platform enum", () => {
    const missing = Object.values(Platform).filter(
      (platform) => !PLATFORM_ORDER.includes(platform),
    );
    expect(missing).toEqual([]);
  });
});

// 2026-11-01 audit (M1): the Queue card and the approval email both list the
// per-platform captions an owner is approving; this is their shared "which
// captions, in what order, under what label" rule (the view has no component
// tests, so the logic lives here).
describe("platformCaptionEntries", () => {
  it("uses the heading the Queue card and the email render", () => {
    expect(PLATFORM_CAPTIONS_HEADING).toBe("Platform-specific captions");
  });

  it("labels each platform with its display name", () => {
    expect(platformCaptionEntries({ linkedin: "Hidden text" })).toEqual([
      { platform: "linkedin", label: "LinkedIn", text: "Hidden text" },
    ]);
  });

  it("returns nothing for null, undefined or an empty map", () => {
    expect(platformCaptionEntries(null)).toEqual([]);
    expect(platformCaptionEntries(undefined)).toEqual([]);
    expect(platformCaptionEntries({})).toEqual([]);
  });

  it("skips empty texts (the publisher falls back to the base caption for them)", () => {
    expect(platformCaptionEntries({ linkedin: "", x: "Kept" })).toEqual([
      { platform: "x", label: "X", text: "Kept" },
    ]);
  });

  it("lists platforms in the app's stable display order, not insertion order", () => {
    const entries = platformCaptionEntries({
      google_business_profile: "g",
      linkedin: "l",
      tiktok: "t",
      x: "x",
    });
    expect(entries.map((entry) => entry.platform)).toEqual([
      "tiktok",
      "x",
      "linkedin",
      "google_business_profile",
    ]);
  });
});

// 2026-11-10: the dashboard's YouTube card shows this. Since the daily post
// numbers sync it must say what is synced and how often, not "not synced yet".
// Go-live check 2026-11-11: it names only the daily platforms this site offers.
describe("metricsMaturityNote", () => {
  it("names Pinterest where the site offers it", () => {
    expect(metricsMaturityNote(PLATFORM_ORDER)).toBe(
      "YouTube numbers update every hour. Instagram, Facebook, LinkedIn and Pinterest numbers update once a day and show on each post in Activity.",
    );
    expect(metricsMaturityNote(PLATFORM_ORDER)).not.toMatch(/not synced/i);
  });

  it("leaves Pinterest out where it is not configured", () => {
    const withoutPinterest = PLATFORM_ORDER.filter((platform) => platform !== "pinterest");
    expect(metricsMaturityNote(withoutPinterest)).toBe(
      "YouTube numbers update every hour. Instagram, Facebook and LinkedIn numbers update once a day and show on each post in Activity.",
    );
  });
});
