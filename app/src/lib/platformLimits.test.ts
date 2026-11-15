import { describe, expect, it } from "vitest";

import type { Platform } from "@prisma/client";

import {
  PLATFORM_CAPTION_LIMITS,
  TEXT_ONLY_PLATFORMS,
  mediaKindOf,
  platformAcceptsTextOnly,
  textPostsEnabled,
  platformAcceptsMedia,
  unsupportedMediaReason,
  filesSentTo,
  platformFilesReason,
} from "./platformLimits";
import { UPLOAD_ALLOWED_CONTENT_TYPES } from "./mediaInput";

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

  it("caps a Google Business Profile post at 1,500 characters", () => {
    expect(PLATFORM_CAPTION_LIMITS.google_business_profile).toEqual({ charLimit: 1500, ellipsis: "..." });
  });

  it("linkedin: 3000 with '...' ellipsis (fix round 1, M6)", () => {
    expect(PLATFORM_CAPTION_LIMITS.linkedin).toEqual({ charLimit: 3000, ellipsis: "..." });
  });

  it("has no client-side caption limit for youtube, facebook_page", () => {
    expect(PLATFORM_CAPTION_LIMITS.youtube.charLimit).toBeNull();
    expect(PLATFORM_CAPTION_LIMITS.facebook_page.charLimit).toBeNull();
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
        "pinterest",
      ].sort(),
    );
  });

  // Pinterest refuses a Pin whose description is over 800 characters
  // (PinCreate.description maxLength), so the client cuts it there.
  it("Pinterest: the description limit, 800, with an ellipsis", () => {
    expect(PLATFORM_CAPTION_LIMITS.pinterest).toEqual({ charLimit: 800, ellipsis: "..." });
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
    ["facebook_page", true, true], // facebookPageClient.ts — photo to /photos, video to /videos
    ["instagram", true, true], // instagramClient.ts:126-161 — REELS (video) or IMAGE
    ["x", true, true], // xClient.ts:528-537 — image or video
    ["linkedin", true, true], // linkedinClient.ts:619-643 — video or image
    ["google_business_profile", true, true], // googleBusinessProfileClient.ts — photo post, video to gallery
    ["pinterest", true, true], // pinterestClient.ts — image Pin by URL, video Pin by upload
  ];

  it("Pinterest takes MP4 and MOV videos but not WebM, and says why", () => {
    expect(platformAcceptsMedia("pinterest", "video/quicktime")).toBe(true);
    expect(platformAcceptsMedia("pinterest", "video/webm")).toBe(false);
    expect(unsupportedMediaReason("pinterest", "video/webm")).toBe("MP4 or MOV only");
  });

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

  it("has no reason for Facebook Page given a video (it takes images and videos since 2026-11-08)", () => {
    expect(unsupportedMediaReason("facebook_page", "video/mp4")).toBeNull();
    expect(unsupportedMediaReason("facebook_page", "image/png")).toBeNull();
  });

  it("is null when the platform accepts the media (or none is chosen)", () => {
    expect(unsupportedMediaReason("youtube", "video/mp4")).toBeNull();
    expect(unsupportedMediaReason("x", "image/png")).toBeNull();
    expect(unsupportedMediaReason("youtube", null)).toBeNull();
  });

  it("names an unrecognised file type for any platform", () => {
    expect(unsupportedMediaReason("x", "application/pdf")).toBe("Unsupported file type");
  });

  // LinkedIn's Images API takes JPG, GIF and PNG; its Videos API, MP4 (docs,
  // checked 2026-11-09). MOV, the iPhone's format, stays allowed.
  it("LinkedIn: refuses WebP images and WebM videos, with the formats it takes", () => {
    expect(platformAcceptsMedia("linkedin", "image/webp")).toBe(false);
    expect(unsupportedMediaReason("linkedin", "image/webp")).toBe("JPG, PNG or GIF only");
    expect(platformAcceptsMedia("linkedin", "video/webm")).toBe(false);
    expect(unsupportedMediaReason("linkedin", "video/webm")).toBe("MP4 or MOV only");
    for (const ok of ["image/jpeg", "image/png", "image/gif", "video/mp4", "video/quicktime"]) {
      expect(platformAcceptsMedia("linkedin", ok)).toBe(true);
    }
    // Other platforms are unchanged.
    expect(platformAcceptsMedia("x", "image/webp")).toBe(true);
    expect(platformAcceptsMedia("facebook_page", "video/webm")).toBe(true);
  });
});

// R17 CC2: formats the platforms' docs refuse, checked by the lead 2026-11-15.
// Instagram Reels and video Stories: "Container: MOV or MP4". Google Business
// Profile photos: "Format: JPG or PNG". Every answer for every platform and
// every type the upload token allows is pinned, so nothing else moved.
describe("media answers over every platform and every uploadable type (R17)", () => {
  const OK = null;
  const expected: Record<Platform, Record<string, string | null>> = {
    youtube: {
      "image/jpeg": "Video only", "image/png": "Video only", "image/gif": "Video only", "image/webp": "Video only",
      "video/mp4": OK, "video/quicktime": OK, "video/webm": OK,
    },
    tiktok: {
      "image/jpeg": "Video only", "image/png": "Video only", "image/gif": "Video only", "image/webp": "Video only",
      "video/mp4": OK, "video/quicktime": OK, "video/webm": OK,
    },
    facebook_page: {
      "image/jpeg": OK, "image/png": OK, "image/gif": OK, "image/webp": "JPG, PNG or GIF only",
      "video/mp4": OK, "video/quicktime": OK, "video/webm": OK,
    },
    instagram: {
      "image/jpeg": OK, "image/png": OK, "image/gif": OK, "image/webp": OK,
      "video/mp4": OK, "video/quicktime": OK, "video/webm": "MP4 or MOV only",
    },
    x: {
      "image/jpeg": OK, "image/png": OK, "image/gif": OK, "image/webp": OK,
      "video/mp4": OK, "video/quicktime": OK, "video/webm": OK,
    },
    linkedin: {
      "image/jpeg": OK, "image/png": OK, "image/gif": OK, "image/webp": "JPG, PNG or GIF only",
      "video/mp4": OK, "video/quicktime": OK, "video/webm": "MP4 or MOV only",
    },
    google_business_profile: {
      "image/jpeg": OK, "image/png": OK, "image/gif": "JPG or PNG only", "image/webp": "JPG or PNG only",
      "video/mp4": OK, "video/quicktime": OK, "video/webm": OK,
    },
    pinterest: {
      "image/jpeg": OK, "image/png": OK, "image/gif": OK, "image/webp": OK,
      "video/mp4": OK, "video/quicktime": OK, "video/webm": "MP4 or MOV only",
    },
  };

  it("covers every platform and every type the upload allows", () => {
    expect(Object.keys(expected).sort()).toEqual(Object.keys(PLATFORM_CAPTION_LIMITS).sort());
    for (const answers of Object.values(expected)) {
      expect(Object.keys(answers).sort()).toEqual([...UPLOAD_ALLOWED_CONTENT_TYPES].sort());
    }
  });

  for (const [platform, answers] of Object.entries(expected) as Array<[Platform, Record<string, string | null>]>) {
    for (const [mimeType, reason] of Object.entries(answers)) {
      it(`${platform} + ${mimeType}: ${reason ?? "accepted"}`, () => {
        expect(unsupportedMediaReason(platform, mimeType)).toBe(reason);
        expect(platformAcceptsMedia(platform, mimeType)).toBe(reason === null);
      });
    }
  }
});

describe("TEXT_ONLY_PLATFORMS (posts without a photo)", () => {
  it("lists exactly Facebook, X, LinkedIn and Google Business Profile", () => {
    expect([...TEXT_ONLY_PLATFORMS].sort()).toEqual(
      ["facebook_page", "google_business_profile", "linkedin", "x"],
    );
  });

  it("platformAcceptsTextOnly is true for those four and false for the platforms that need a file", () => {
    for (const platform of ["facebook_page", "x", "linkedin", "google_business_profile"] as Platform[]) {
      expect(platformAcceptsTextOnly(platform)).toBe(true);
    }
    for (const platform of ["instagram", "tiktok", "youtube", "pinterest"] as Platform[]) {
      expect(platformAcceptsTextOnly(platform)).toBe(false);
    }
  });
});

describe("textPostsEnabled (release switch)", () => {
  it("is on: posts without a photo can be created", () => {
    expect(textPostsEnabled()).toBe(true);
  });
});

// R21 platform-clients M1: a post with several photos is judged, for each
// platform, on every file that platform receives, not on the first alone.
describe("platformFilesReason: every file a platform receives", () => {
  const jpg = "image/jpeg";
  const webp = "image/webp";
  const all = ["linkedin", "facebook_page", "instagram", "x", "google_business_profile", "pinterest"] as const;

  it("how many files each platform receives", () => {
    expect(filesSentTo("linkedin", 7)).toBe(7);
    expect(filesSentTo("facebook_page", 7)).toBe(7);
    expect(filesSentTo("instagram", 7)).toBe(7);
    expect(filesSentTo("x", 7)).toBe(4);
    expect(filesSentTo("x", 3)).toBe(3);
    expect(filesSentTo("google_business_profile", 7)).toBe(1);
    expect(filesSentTo("pinterest", 7)).toBe(1);
    expect(filesSentTo("youtube", 7)).toBe(1);
    expect(filesSentTo("tiktok", 7)).toBe(1);
  });

  it("all JPEG: unchanged for every platform", () => {
    for (const platform of all) {
      expect(platformFilesReason(platform, [jpg, jpg, jpg])).toBe(unsupportedMediaReason(platform, jpg));
    }
    expect(platformFilesReason("youtube", [jpg, jpg])).toBe("Video only");
  });

  it("one file or none: the single-file answer", () => {
    for (const platform of all) {
      expect(platformFilesReason(platform, [webp])).toBe(unsupportedMediaReason(platform, webp));
      expect(platformFilesReason(platform, webp)).toBe(unsupportedMediaReason(platform, webp));
      expect(platformFilesReason(platform, null)).toBeNull();
      expect(platformFilesReason(platform, [])).toBeNull();
    }
  });

  it.each([
    ["first", [webp, jpg, jpg], 1],
    ["middle", [jpg, webp, jpg], 2],
    ["last", [jpg, jpg, webp], 3],
  ])("a WebP %s: LinkedIn and Facebook refuse it and name the photo", (_where, types, n) => {
    expect(platformFilesReason("linkedin", types)).toBe(`photo ${n} is WebP; JPG, PNG or GIF only`);
    expect(platformFilesReason("facebook_page", types)).toBe(`photo ${n} is WebP; JPG, PNG or GIF only`);
    expect(platformFilesReason("instagram", types)).toBeNull();
    expect(platformFilesReason("x", types)).toBeNull();
    expect(platformFilesReason("pinterest", types)).toBeNull();
    // Google takes the first photo only, so only a WebP first is refused.
    expect(platformFilesReason("google_business_profile", types)).toBe(n === 1 ? "photo 1 is WebP; JPG or PNG only" : null);
  });

  it("Google and Pinterest are judged on the first file only", () => {
    expect(platformFilesReason("google_business_profile", [jpg, webp, webp])).toBeNull();
    expect(platformFilesReason("pinterest", ["video/mp4", "video/webm"])).toBeNull();
    expect(platformFilesReason("pinterest", ["video/webm", "video/mp4"])).toBe("file 1 is WebM; MP4 or MOV only");
  });

  it("X is judged on its first 4 of a 5-photo post", () => {
    const fifthBad = [jpg, jpg, jpg, jpg, "video/webm"];
    expect(platformFilesReason("x", fifthBad)).toBeNull();
    expect(platformFilesReason("linkedin", fifthBad)).toBe("file 5 is WebM; MP4 or MOV only");
    expect(platformFilesReason("x", [jpg, jpg, jpg, "application/pdf", jpg])).toBe("Unsupported file type");
    expect(platformFilesReason("x", [jpg, jpg, jpg, jpg, "application/pdf"])).toBeNull();
  });

  it("order no longer changes the answer for LinkedIn", () => {
    expect(platformFilesReason("linkedin", [jpg, webp, jpg])).not.toBeNull();
    expect(platformFilesReason("linkedin", [webp, jpg, jpg])).not.toBeNull();
  });
});
