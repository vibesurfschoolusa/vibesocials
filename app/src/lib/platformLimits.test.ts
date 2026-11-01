import { describe, expect, it } from "vitest";

import type { Platform } from "@prisma/client";

import {
  PLATFORM_CAPTION_LIMITS,
  mediaKindOf,
  platformAcceptsMedia,
  unsupportedMediaReason,
} from "./platformLimits";

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

  it("sets Instagram's client-enforced limit to 2200 graphemes with no ellipsis (2026-11-01 audit)", () => {
    // Instagram rejects a longer caption outright, which used to surface as a
    // failed publish; instagramClient.ts now truncates to this same number.
    expect(PLATFORM_CAPTION_LIMITS.instagram).toEqual({ charLimit: 2200 });
    expect(PLATFORM_CAPTION_LIMITS.instagram.ellipsis).toBeUndefined();
  });

  it("has no client-side caption limit for youtube, linkedin, facebook_page, google_business_profile", () => {
    expect(PLATFORM_CAPTION_LIMITS.youtube.charLimit).toBeNull();
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

describe("mediaKindOf", () => {
  it.each([
    ["video/mp4", "video"],
    ["video/quicktime", "video"],
    ["image/jpeg", "image"],
    ["image/png", "image"],
    // The clients use plain, case-sensitive prefix checks; so does this.
    ["VIDEO/MP4", null],
    ["application/pdf", null],
    ["", null],
  ])("%j -> %j", (mimeType, expected) => {
    expect(mediaKindOf(mimeType)).toBe(expected);
  });
});

describe("platformAcceptsMedia (rules read from each platform client — see PLATFORM_ACCEPTED_MEDIA)", () => {
  // [platform, accepts video/mp4, accepts image/jpeg]
  const table: Array<[Platform, boolean, boolean]> = [
    ["youtube", true, false], // youtubeClient.ts:65-75 — video only
    ["tiktok", true, false], // tiktokClient.ts:654-658 — video only
    ["facebook_page", false, true], // facebookPageClient.ts:67-73 — images only
    ["instagram", true, true], // instagramClient.ts:126-161 — REELS (video) or IMAGE
    ["x", true, true], // xClient.ts:528-537 — image or video
    ["linkedin", true, true], // linkedinClient.ts:619-643 — video or image
    ["google_business_profile", true, true], // googleBusinessProfileClient.ts:41-59 — warns, never rejects
  ];

  it.each(table)("%s: video=%s image=%s", (platform, video, image) => {
    expect(platformAcceptsMedia(platform, "video/mp4")).toBe(video);
    expect(platformAcceptsMedia(platform, "image/jpeg")).toBe(image);
  });

  it("covers every Platform enum member", () => {
    expect(table.map(([platform]) => platform).sort()).toEqual(
      Object.keys(PLATFORM_CAPTION_LIMITS).sort(),
    );
  });

  it("accepts every platform while no media has been chosen yet (null / undefined)", () => {
    for (const [platform] of table) {
      expect(platformAcceptsMedia(platform, null)).toBe(true);
      expect(platformAcceptsMedia(platform, undefined)).toBe(true);
    }
  });

  it("accepts nothing for a file that is neither an image nor a video", () => {
    for (const [platform] of table) {
      expect(platformAcceptsMedia(platform, "application/pdf")).toBe(false);
      expect(platformAcceptsMedia(platform, "")).toBe(false);
    }
  });
});

describe("unsupportedMediaReason", () => {
  it("explains a video-only platform given an image", () => {
    expect(unsupportedMediaReason("youtube", "image/png")).toBe("Video only");
    expect(unsupportedMediaReason("tiktok", "image/png")).toBe("Video only");
  });

  it("explains an images-only platform given a video", () => {
    expect(unsupportedMediaReason("facebook_page", "video/mp4")).toBe("Images only");
  });

  it("is null when the platform accepts the media (or none is chosen)", () => {
    expect(unsupportedMediaReason("youtube", "video/mp4")).toBeNull();
    expect(unsupportedMediaReason("x", "image/png")).toBeNull();
    expect(unsupportedMediaReason("youtube", null)).toBeNull();
  });

  it("names an unrecognised file type for any platform", () => {
    expect(unsupportedMediaReason("x", "application/pdf")).toBe("Unsupported file type");
  });
});
