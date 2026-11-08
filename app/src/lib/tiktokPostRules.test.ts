import { describe, expect, it } from "vitest";

import {
  TIKTOK_BRANDED_PRIVATE_TEXT,
  TIKTOK_DISCLOSURE_INCOMPLETE_TEXT,
  formatDuration,
  tiktokDisclosureLabel,
  tiktokPrivacyLabel,
  tiktokPublishBlock,
  tiktokVideoTooLong,
} from "./tiktokPostRules";

// TikTok's Content Sharing Guidelines, as the posting screen applies them.
describe("tiktokPostRules", () => {
  it("uses TikTok's exact texts", () => {
    expect(TIKTOK_BRANDED_PRIVATE_TEXT).toBe("Branded content visibility cannot be set to private.");
    expect(TIKTOK_DISCLOSURE_INCOMPLETE_TEXT).toBe(
      "You need to indicate if your content promotes yourself, a third party, or both.",
    );
  });

  it("3a: one label for the selection — Paid partnership wins when both are ticked", () => {
    expect(tiktokDisclosureLabel({})).toBeNull();
    expect(tiktokDisclosureLabel({ brandOrganic: true })).toBe("Promotional content");
    expect(tiktokDisclosureLabel({ brandedContent: true })).toBe("Paid partnership");
    expect(tiktokDisclosureLabel({ brandedContent: true, brandOrganic: true })).toBe("Paid partnership");
  });

  it("labels privacy options, showing an unknown future option as sent", () => {
    expect(tiktokPrivacyLabel("SELF_ONLY")).toBe("Private (only me)");
    expect(tiktokPrivacyLabel("PUBLIC_TO_EVERYONE")).toBe("Public (everyone)");
    expect(tiktokPrivacyLabel("SOME_NEW_LEVEL")).toBe("SOME_NEW_LEVEL");
  });

  it("1c: compares the video's length with the account's maximum", () => {
    expect(tiktokVideoTooLong(61, 60)).toBe(true);
    expect(tiktokVideoTooLong(60.02, 60)).toBe(false); // browser rounding
    expect(tiktokVideoTooLong(30, 60)).toBe(false);
    expect(tiktokVideoTooLong(null, 60)).toBe(false); // not read yet
    expect(tiktokVideoTooLong(Number.NaN, 60)).toBe(false);
    expect(tiktokVideoTooLong(Number.POSITIVE_INFINITY, 60)).toBe(false); // live streams report Infinity
  });

  it("formats durations as m:ss or h:mm:ss", () => {
    expect(formatDuration(75)).toBe("1:15");
    expect(formatDuration(600)).toBe("10:00");
    expect(formatDuration(3600)).toBe("1:00:00");
    expect(formatDuration(3725.4)).toBe("1:02:05");
  });

  describe("tiktokPublishBlock", () => {
    const base = { tiktokSelected: true, blockingReason: null, commercialContentEnabled: false, metadata: {} };

    it("never blocks when TikTok isn't a target", () => {
      expect(
        tiktokPublishBlock({ ...base, tiktokSelected: false, blockingReason: "x", commercialContentEnabled: true }),
      ).toBeNull();
    });

    it("blocks with the panel's reason (can't post, settings not loaded, too long)", () => {
      expect(tiktokPublishBlock({ ...base, blockingReason: "TikTok says this account can't post right now." })).toBe(
        "TikTok says this account can't post right now.",
      );
    });

    it("3a: blocks when disclosure is on with nothing ticked, with TikTok's hover text", () => {
      expect(tiktokPublishBlock({ ...base, commercialContentEnabled: true })).toBe(TIKTOK_DISCLOSURE_INCOMPLETE_TEXT);
      expect(tiktokPublishBlock({ ...base, commercialContentEnabled: true, metadata: { brandOrganic: true } })).toBeNull();
      expect(tiktokPublishBlock({ ...base, commercialContentEnabled: true, metadata: { brandedContent: true } })).toBeNull();
    });

    it("lets a complete TikTok post through", () => {
      expect(tiktokPublishBlock(base)).toBeNull();
    });
  });
});
