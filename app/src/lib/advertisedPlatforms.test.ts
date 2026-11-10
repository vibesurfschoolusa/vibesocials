import { describe, expect, it } from "vitest";

import { advertisedPlatforms } from "./advertisedPlatforms";

const PINTEREST_ENV = {
  PINTEREST_APP_ID: "1234567",
  PINTEREST_APP_SECRET: "shh",
  PINTEREST_REDIRECT_URI: "https://app.example.com/api/auth/pinterest/callback",
};

// 2026-11-10: Pinterest's code ships before Pinterest approves the app. The
// landing and About pages must not name a platform nobody can connect yet.
describe("advertisedPlatforms", () => {
  it("leaves Pinterest out while this deployment has no Pinterest app", () => {
    const platforms = advertisedPlatforms({});

    expect(platforms).not.toContain("pinterest");
    expect(platforms).toEqual([
      "tiktok",
      "youtube",
      "instagram",
      "x",
      "linkedin",
      "facebook_page",
      "google_business_profile",
    ]);
  });

  it("names Pinterest once its app credentials are set", () => {
    expect(advertisedPlatforms(PINTEREST_ENV)).toContain("pinterest");
  });
});
