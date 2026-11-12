import { describe, expect, it } from "vitest";

import { PLATFORM_LABELS } from "@/lib/platforms";
import { SUPPORT_EMAIL } from "@/lib/siteInfo";
import type { Platform } from "@prisma/client";

import { PLATFORM_GUIDES, platformHelpHref, readyToConnectSentence } from "./platformGuides";

// PLATFORM_LABELS is typed Record<Platform, string>, so its keys are every
// value of the Platform enum.
const ALL_PLATFORMS = Object.keys(PLATFORM_LABELS) as Platform[];

describe("PLATFORM_GUIDES", () => {
  it("has a guide for every platform, with at least one need and one step", () => {
    for (const platform of ALL_PLATFORMS) {
      const guide = PLATFORM_GUIDES[platform];
      expect(guide, platform).toBeDefined();
      expect(guide.anchor, platform).toMatch(/^[a-z0-9-]+$/);
      expect(guide.needs.length, platform).toBeGreaterThan(0);
      expect(guide.steps.length, platform).toBeGreaterThan(0);
    }
  });

  it("gives every platform its own anchor", () => {
    const anchors = ALL_PLATFORMS.map((platform) => PLATFORM_GUIDES[platform].anchor);
    expect(new Set(anchors).size).toBe(ALL_PLATFORMS.length);
  });

  it("names no email address except SUPPORT_EMAIL", () => {
    for (const platform of ALL_PLATFORMS) {
      const guide = PLATFORM_GUIDES[platform];
      const text = [...guide.needs, ...guide.steps, ...guide.tips, guide.status ?? ""]
        .join("\n")
        .split(SUPPORT_EMAIL)
        .join("");
      expect(text, platform).not.toMatch(/[^\s@]+@[^\s@]+\.[^\s@]+/);
    }
  });

  it("puts the support address in the notes that ask the user to write", () => {
    for (const platform of ["facebook_page", "instagram", "linkedin"] as const) {
      expect(PLATFORM_GUIDES[platform].status).toContain(SUPPORT_EMAIL);
    }
  });

  it("does not promise on a public page to add Meta accounts as testers", () => {
    for (const platform of ["facebook_page", "instagram"] as const) {
      expect(PLATFORM_GUIDES[platform].status).toBe(
        `Meta is reviewing Vibe Socials. Until the review finishes, connecting Facebook and Instagram is not open to every account yet. Write to ${SUPPORT_EMAIL} and we will help you get set up.`,
      );
      expect(PLATFORM_GUIDES[platform].status).not.toMatch(/tester/i);
    }
  });

  it("has no review note for X, Pinterest, YouTube and Google Business Profile", () => {
    expect(PLATFORM_GUIDES.x.status).toBeUndefined();
    expect(PLATFORM_GUIDES.pinterest.status).toBeUndefined();
    // Google approved the YouTube scopes on 2026-11-11. On 2026-11-12 its
    // Verification Center showed branding and data access verified, and the
    // Business Profile connect asks only for business.manage, a non-sensitive
    // scope: Google's "has not verified this app" screen is gone for both.
    expect(PLATFORM_GUIDES.youtube.status).toBeUndefined();
    expect(PLATFORM_GUIDES.google_business_profile.status).toBeUndefined();
  });

  it("no longer tells anyone to get past Google's unverified-app screen", () => {
    for (const platform of ALL_PLATFORMS) {
      const guide = PLATFORM_GUIDES[platform];
      const text = [...guide.needs, ...guide.steps, ...guide.tips, guide.status ?? ""].join("\n");
      expect(text, platform).not.toMatch(/has not verified|Go to vibesocials\.wtf/);
    }
  });
});

describe("platformHelpHref", () => {
  it("links each platform to its section of /help", () => {
    expect(platformHelpHref("facebook_page")).toBe("/help#facebook-page");
    expect(platformHelpHref("instagram")).toBe("/help#instagram");
    expect(platformHelpHref("youtube")).toBe("/help#youtube");
    expect(platformHelpHref("google_business_profile")).toBe("/help#google-business-profile");
    expect(platformHelpHref("linkedin")).toBe("/help#linkedin");
    expect(platformHelpHref("x")).toBe("/help#x");
    expect(platformHelpHref("tiktok")).toBe("/help#tiktok");
    expect(platformHelpHref("pinterest")).toBe("/help#pinterest");
  });

  it("matches the guide's anchor for every platform", () => {
    for (const platform of ALL_PLATFORMS) {
      expect(platformHelpHref(platform)).toBe(`/help#${PLATFORM_GUIDES[platform].anchor}`);
    }
  });
});

describe("readyToConnectSentence", () => {
  it("names the offered platforms with no review open, then points to the guide", () => {
    expect(readyToConnectSentence(["tiktok", "youtube", "instagram", "x", "linkedin", "facebook_page", "google_business_profile"])).toBe(
      "YouTube, X and Google Business Profile connect right away today; the others are explained in the",
    );
    // S1 fix round 1: Pinterest's access is still on trial and untested, so it is not promised.
    expect(readyToConnectSentence(["tiktok", "youtube", "x", "pinterest"])).toBe(
      "YouTube and X connect right away today; the others are explained in the",
    );
    expect(readyToConnectSentence(["pinterest", "tiktok"])).toBeNull();
  });

  it("is null when every offered platform has a review open", () => {
    expect(readyToConnectSentence(["tiktok", "instagram"])).toBeNull();
  });
});
