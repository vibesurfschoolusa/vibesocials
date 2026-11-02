import { describe, expect, it } from "vitest";

import { PLATFORM_CAPTIONS_HEADING, platformCaptionEntries } from "./platforms";

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
