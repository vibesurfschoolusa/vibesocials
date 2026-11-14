import { describe, expect, it } from "vitest";

import { disconnectDescription, switchDescription } from "./connection-actions";

/**
 * G4 (R2-security L2): Disconnect deletes the post numbers read from that
 * platform, and the listing's numbers for Google Business Profile
 * (api/connections/[platform] DELETE). The dialogs say so.
 */

const GONE = "The post numbers read from this platform are deleted and cannot be brought back.";
const GBP_GONE =
  "The post numbers and the Google listing numbers read from it are deleted and cannot be brought back.";

describe("Disconnect dialog", () => {
  it.each(["youtube", "instagram", "facebook_page", "linkedin", "pinterest"])(
    "%s: says its numbers are deleted for good",
    (platform) => {
      const text = disconnectDescription(platform);
      expect(text).toContain(GONE);
      expect(text).toContain("Future posts, including scheduled ones, will skip this platform.");
      expect(text).toContain("Your past posts stay in Activity");
    },
  );

  it("Google Business Profile: names the listing numbers too", () => {
    expect(disconnectDescription("google_business_profile")).toContain(GBP_GONE);
  });

  it.each(["x", "tiktok"])("%s: says nothing about numbers (none are read)", (platform) => {
    expect(disconnectDescription(platform)).not.toContain("numbers");
  });
});

describe("Switch account dialog", () => {
  it("says the current account's numbers are deleted for good", () => {
    const text = switchDescription("youtube");
    expect(text).toContain("This disconnects your current account and sends you to reconnect a different one.");
    expect(text).toContain(GONE);
  });

  it("Google Business Profile: names the listing numbers too", () => {
    expect(switchDescription("google_business_profile")).toContain(GBP_GONE);
  });
});
