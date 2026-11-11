import { describe, expect, it } from "vitest";
import type { Platform } from "@prisma/client";

import {
  NEEDS_MEDIA_REASON,
  PostTargetingError,
  assertPostTargetsValid,
  assertTextPostTargetsValid,
  needsMediaMessage,
  narrowConnectionsForTextPost,
  deriveComposerPlatforms,
  incompatibleMediaMessage,
  isTikTokPrivacyMissing,
  narrowConnectionsForPost,
  splitPlatformsByMedia,
} from "./postTargets";

const conn = (platform: Platform) => ({ id: `c-${platform}`, platform });

function targetingError(fn: () => unknown): PostTargetingError {
  try {
    fn();
  } catch (error) {
    if (error instanceof PostTargetingError) return error;
    throw error;
  }
  throw new Error("expected a PostTargetingError");
}

describe("splitPlatformsByMedia", () => {
  it("splits platforms by whether their client accepts the media, preserving order", () => {
    expect(splitPlatformsByMedia(["youtube", "x", "facebook_page", "tiktok"], "image/png")).toEqual({
      compatible: ["x", "facebook_page"],
      incompatible: ["youtube", "tiktok"],
    });
    expect(splitPlatformsByMedia(["youtube", "x", "facebook_page", "tiktok"], "video/mp4")).toEqual({
      compatible: ["youtube", "x", "facebook_page", "tiktok"],
      incompatible: [],
    });
  });

  it("treats every platform as compatible while no media is known", () => {
    expect(splitPlatformsByMedia(["youtube", "facebook_page"], null).incompatible).toEqual([]);
  });
});

describe("incompatibleMediaMessage", () => {
  it("names each platform with what it accepts", () => {
    const message = incompatibleMediaMessage(["youtube", "tiktok"], "image/png");
    expect(message).toContain("YouTube (video only)");
    expect(message).toContain("TikTok (video only)");
  });

  it("uses the platform's display label", () => {
    expect(incompatibleMediaMessage(["youtube"], "image/png")).toContain("YouTube (video only)");
  });
});

describe("isTikTokPrivacyMissing (ruling R5 - required for every intent)", () => {
  it("is false when TikTok is not a target, whatever the metadata", () => {
    expect(isTikTokPrivacyMissing(["youtube", "x"], undefined)).toBe(false);
    expect(isTikTokPrivacyMissing([], null)).toBe(false);
  });

  it("is true when TikTok is targeted with no metadata or no / empty / non-string privacy level", () => {
    expect(isTikTokPrivacyMissing(["tiktok"], undefined)).toBe(true);
    expect(isTikTokPrivacyMissing(["tiktok"], null)).toBe(true);
    expect(isTikTokPrivacyMissing(["tiktok"], {})).toBe(true);
    expect(isTikTokPrivacyMissing(["tiktok"], { privacyLevel: "" })).toBe(true);
    expect(isTikTokPrivacyMissing(["tiktok"], { privacyLevel: "   " })).toBe(true);
    expect(isTikTokPrivacyMissing(["tiktok"], { privacyLevel: 3 })).toBe(true);
  });

  it("is false when TikTok is targeted with an explicit privacy level", () => {
    expect(isTikTokPrivacyMissing(["x", "tiktok"], { privacyLevel: "SELF_ONLY" })).toBe(false);
    expect(isTikTokPrivacyMissing(["tiktok"], { privacyLevel: "PUBLIC_TO_EVERYONE" })).toBe(false);
  });
});

describe("assertPostTargetsValid (explicit platform list)", () => {
  it("does nothing without an explicit list", () => {
    expect(() => assertPostTargetsValid(undefined, "image/png", undefined)).not.toThrow();
  });

  it("accepts a compatible list", () => {
    expect(() =>
      assertPostTargetsValid(["youtube", "tiktok"], "video/mp4", { privacyLevel: "SELF_ONLY" }),
    ).not.toThrow();
  });

  it("throws PLATFORM_MEDIA_MISMATCH naming every incompatible platform", () => {
    const error = targetingError(() =>
      assertPostTargetsValid(["youtube", "x", "tiktok"], "image/png", undefined),
    );
    expect(error.code).toBe("PLATFORM_MEDIA_MISMATCH");
    expect(error.platforms).toEqual(["youtube", "tiktok"]);
    expect(error.message).toContain("YouTube");
    expect(error.message).toContain("TikTok");
    expect(error.message).not.toContain("X (");
  });

  it("throws TIKTOK_PRIVACY_REQUIRED when TikTok is listed without a privacy level", () => {
    const error = targetingError(() =>
      assertPostTargetsValid(["tiktok"], "video/mp4", { privacyLevel: "" }),
    );
    expect(error.code).toBe("TIKTOK_PRIVACY_REQUIRED");
    expect(error.platforms).toEqual(["tiktok"]);
  });

  it("reports the media mismatch before a missing TikTok privacy level", () => {
    const error = targetingError(() => assertPostTargetsValid(["tiktok"], "image/png", undefined));
    expect(error.code).toBe("PLATFORM_MEDIA_MISMATCH");
  });
});

describe("narrowConnectionsForPost (immediate fan-out)", () => {
  const all = [conn("youtube"), conn("x"), conn("facebook_page"), conn("tiktok")];

  it("skips incompatible connected platforms when no explicit list was sent", () => {
    const result = narrowConnectionsForPost({
      connections: all,
      targetPlatforms: undefined,
      mimeType: "image/png",
      tiktokMetadata: undefined,
    });
    expect(result.map((c) => c.platform)).toEqual(["x", "facebook_page"]);
  });

  it("narrows to the explicit list when one was sent", () => {
    const result = narrowConnectionsForPost({
      connections: all,
      targetPlatforms: ["x", "youtube"],
      mimeType: "video/mp4",
      tiktokMetadata: undefined,
    });
    expect(result.map((c) => c.platform)).toEqual(["youtube", "x"]);
  });

  it("rejects an explicit list holding an incompatible platform", () => {
    const error = targetingError(() =>
      narrowConnectionsForPost({
        connections: all,
        targetPlatforms: ["youtube", "x"],
        mimeType: "image/png",
        tiktokMetadata: undefined,
      }),
    );
    expect(error.code).toBe("PLATFORM_MEDIA_MISMATCH");
    expect(error.platforms).toEqual(["youtube"]);
  });

  it("throws NO_COMPATIBLE_PLATFORMS when connections exist but none can publish the media", () => {
    const error = targetingError(() =>
      narrowConnectionsForPost({
        connections: [conn("youtube"), conn("tiktok")],
        targetPlatforms: undefined,
        mimeType: "image/png",
        tiktokMetadata: undefined,
      }),
    );
    expect(error.code).toBe("NO_COMPATIBLE_PLATFORMS");
  });

  it("returns [] (so the caller's NO_CONNECTIONS applies) when there are no connections at all", () => {
    expect(
      narrowConnectionsForPost({
        connections: [],
        targetPlatforms: undefined,
        mimeType: "image/png",
        tiktokMetadata: undefined,
      }),
    ).toEqual([]);
  });

  it("requires a TikTok privacy level when a connected, compatible TikTok is implicitly targeted", () => {
    const error = targetingError(() =>
      narrowConnectionsForPost({
        connections: [conn("tiktok"), conn("x")],
        targetPlatforms: undefined,
        mimeType: "video/mp4",
        tiktokMetadata: undefined,
      }),
    );
    expect(error.code).toBe("TIKTOK_PRIVACY_REQUIRED");
  });

  it("does not require a TikTok privacy level when TikTok was skipped as incompatible", () => {
    const result = narrowConnectionsForPost({
      connections: [conn("tiktok"), conn("x")],
      targetPlatforms: undefined,
      mimeType: "image/png",
      tiktokMetadata: undefined,
    });
    expect(result.map((c) => c.platform)).toEqual(["x"]);
  });

  it("accepts an implicit TikTok target that carries a privacy level", () => {
    const result = narrowConnectionsForPost({
      connections: [conn("tiktok")],
      targetPlatforms: undefined,
      mimeType: "video/mp4",
      tiktokMetadata: { privacyLevel: "SELF_ONLY" },
    });
    expect(result.map((c) => c.platform)).toEqual(["tiktok"]);
  });
});

describe("deriveComposerPlatforms", () => {
  const connected: Platform[] = ["tiktok", "youtube", "x", "facebook_page"];
  const none = new Set<Platform>();

  it("selects every connected platform while no media is chosen", () => {
    const { choices, selected } = deriveComposerPlatforms(connected, none, null);
    expect(selected).toEqual(connected);
    expect(choices.every((c) => c.checked && c.disabledReason === null)).toBe(true);
  });

  it("disables and deselects platforms the chosen media is incompatible with, with a reason", () => {
    const { choices, selected } = deriveComposerPlatforms(connected, none, "image/jpeg");
    expect(selected).toEqual(["x", "facebook_page"]);
    expect(choices.find((c) => c.platform === "tiktok")).toEqual({
      platform: "tiktok",
      checked: false,
      disabledReason: "Video only",
    });
    expect(choices.find((c) => c.platform === "x")).toEqual({
      platform: "x",
      checked: true,
      disabledReason: null,
    });
  });

  it("restores a platform when media it accepts is chosen again (derived, not destructive)", () => {
    // An image deselects the video-only platforms; a video brings them back
    // (every connected platform here takes video, Facebook Page since 2026-11-08).
    expect(deriveComposerPlatforms(connected, none, "image/jpeg").selected).toEqual(["x", "facebook_page"]);
    expect(deriveComposerPlatforms(connected, none, "video/mp4").selected).toEqual([
      "tiktok",
      "youtube",
      "x",
      "facebook_page",
    ]);
  });

  it("keeps the user's own opt-outs for compatible platforms", () => {
    const { choices, selected } = deriveComposerPlatforms(
      connected,
      new Set<Platform>(["x"]),
      "video/mp4",
    );
    expect(selected).toEqual(["tiktok", "youtube", "facebook_page"]);
    expect(choices.find((c) => c.platform === "x")).toEqual({
      platform: "x",
      checked: false,
      disabledReason: null,
    });
  });

  it("never selects anything for an unsupported file type", () => {
    const { selected, choices } = deriveComposerPlatforms(connected, none, "application/pdf");
    expect(selected).toEqual([]);
    expect(choices.every((c) => c.disabledReason === "Unsupported file type")).toBe(true);
  });
});

describe("posts without a photo", () => {
  const all: Platform[] = ["facebook_page", "instagram", "x", "tiktok", "linkedin", "google_business_profile"];

  it("deriveComposerPlatforms with no file disables the platforms that need one, with their reason", () => {
    const { choices, selected } = deriveComposerPlatforms(all, new Set(), null, { noFile: true });
    expect(selected).toEqual(["facebook_page", "x", "linkedin", "google_business_profile"]);
    expect(choices.find((c) => c.platform === "instagram")).toEqual({
      platform: "instagram",
      checked: false,
      disabledReason: NEEDS_MEDIA_REASON,
    });
    expect(NEEDS_MEDIA_REASON).toBe("Needs a photo or video");
    expect(choices.find((c) => c.platform === "tiktok")?.disabledReason).toBe("Needs a photo or video");
  });

  it("deriveComposerPlatforms with no file still honours the person's own opt-outs", () => {
    const { selected } = deriveComposerPlatforms(all, new Set<Platform>(["x"]), null, { noFile: true });
    expect(selected).toEqual(["facebook_page", "linkedin", "google_business_profile"]);
  });

  it("deriveComposerPlatforms without the option is unchanged (no media chosen accepts everything)", () => {
    const { selected } = deriveComposerPlatforms(all, new Set(), null);
    expect(selected).toEqual(all);
  });

  it("needsMediaMessage names one platform, or several", () => {
    expect(needsMediaMessage(["instagram"])).toBe("Instagram needs a photo or video.");
    expect(needsMediaMessage(["instagram", "tiktok"])).toBe("Instagram and TikTok need a photo or video.");
    expect(needsMediaMessage(["instagram", "tiktok", "youtube"])).toBe(
      "Instagram, TikTok and YouTube need a photo or video.",
    );
  });

  it("assertTextPostTargetsValid accepts the four text platforms and no list at all", () => {
    expect(() => assertTextPostTargetsValid(["facebook_page", "x", "linkedin", "google_business_profile"])).not.toThrow();
    expect(() => assertTextPostTargetsValid(undefined)).not.toThrow();
  });

  it("assertTextPostTargetsValid refuses a platform that needs a file, naming it", () => {
    try {
      assertTextPostTargetsValid(["x", "pinterest"]);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(PostTargetingError);
      expect((error as PostTargetingError).code).toBe("PLATFORM_NEEDS_MEDIA");
      expect((error as PostTargetingError).message).toBe("Pinterest needs a photo or video.");
      expect((error as PostTargetingError).platforms).toEqual(["pinterest"]);
    }
  });

  it("narrowConnectionsForTextPost narrows an explicit list, and skips file-only platforms without one", () => {
    const connections = all.map((platform) => ({ platform }));
    expect(narrowConnectionsForTextPost({ connections, targetPlatforms: ["x"] })).toEqual([{ platform: "x" }]);
    expect(narrowConnectionsForTextPost({ connections, targetPlatforms: undefined }).map((c) => c.platform)).toEqual([
      "facebook_page",
      "x",
      "linkedin",
      "google_business_profile",
    ]);
    expect(() =>
      narrowConnectionsForTextPost({ connections, targetPlatforms: ["tiktok"] }),
    ).toThrow("TikTok needs a photo or video.");
  });

  it("narrowConnectionsForTextPost refuses when connections exist but none takes text alone", () => {
    try {
      narrowConnectionsForTextPost({ connections: [{ platform: "instagram" as Platform }], targetPlatforms: undefined });
      expect.unreachable();
    } catch (error) {
      expect((error as PostTargetingError).code).toBe("NO_COMPATIBLE_PLATFORMS");
    }
  });
});
