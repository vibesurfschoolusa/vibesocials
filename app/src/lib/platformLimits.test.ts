import { describe, expect, it } from "vitest";

import { PLATFORM_CAPTION_LIMITS } from "./platformLimits";

describe("PLATFORM_CAPTION_LIMITS", () => {
  // Locks the exact values so a future accidental edit (e.g. someone "fixing"
  // a null, or fat-fingering a limit) fails CI instead of silently changing
  // what the composer preview predicts. Client behavior itself is separately
  // locked by xClient.test.ts / tiktokClient.test.ts.
  it("sets X's client-enforced limit to 280 graphemes with a '...' ellipsis", () => {
    expect(PLATFORM_CAPTION_LIMITS.x).toEqual({ charLimit: 280, ellipsis: "..." });
  });

  it("sets TikTok's client-enforced limit to 2200 graphemes with no ellipsis", () => {
    expect(PLATFORM_CAPTION_LIMITS.tiktok).toEqual({ charLimit: 2200 });
    expect(PLATFORM_CAPTION_LIMITS.tiktok.ellipsis).toBeUndefined();
  });

  it("has no client-side caption limit for youtube, instagram, linkedin, facebook_page, google_business_profile", () => {
    expect(PLATFORM_CAPTION_LIMITS.youtube.charLimit).toBeNull();
    expect(PLATFORM_CAPTION_LIMITS.instagram.charLimit).toBeNull();
    expect(PLATFORM_CAPTION_LIMITS.linkedin.charLimit).toBeNull();
    expect(PLATFORM_CAPTION_LIMITS.facebook_page.charLimit).toBeNull();
    expect(PLATFORM_CAPTION_LIMITS.google_business_profile.charLimit).toBeNull();
  });

  it("covers every Platform enum member exactly once (no silent gaps)", () => {
    expect(Object.keys(PLATFORM_CAPTION_LIMITS).sort()).toEqual(
      [
        "x",
        "tiktok",
        "youtube",
        "instagram",
        "linkedin",
        "facebook_page",
        "google_business_profile",
      ].sort(),
    );
  });
});
