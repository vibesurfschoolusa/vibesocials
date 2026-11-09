import { describe, expect, it } from "vitest";

import { toConnectionSummary } from "./connectionSummary";

const ROW = {
  platform: "instagram" as const,
  accountIdentifier: "17841400000000000",
  needsReconnect: false,
};

describe("toConnectionSummary", () => {
  it("shows the stored username", () => {
    expect(toConnectionSummary({ ...ROW, metadata: { username: "vibesurfschool.usa" } })).toEqual({
      ...ROW,
      username: "vibesurfschool.usa",
      locationName: null,
    });
  });

  // 2026-11-09: Settings read "Connected as 199481116575228" for a Facebook
  // Page, because Facebook saves the Page's name as metadata.pageName.
  it("shows a Facebook Page's name, not its id", () => {
    const summary = toConnectionSummary({
      ...ROW,
      platform: "facebook_page",
      accountIdentifier: "199481116575228",
      metadata: { pageName: "Vibe Surf School USA", pageAccessToken: "secret" },
    });

    expect(summary.username).toBe("Vibe Surf School USA");
  });

  it("passes on only display fields, never tokens from the metadata", () => {
    const summary = toConnectionSummary({
      ...ROW,
      platform: "facebook_page",
      metadata: { pageName: "Vibe Surf School USA", pageAccessToken: "secret", accessToken: "secret" },
    });

    expect(Object.keys(summary).sort()).toEqual(
      ["accountIdentifier", "locationName", "needsReconnect", "platform", "username"].sort(),
    );
    expect(JSON.stringify(summary)).not.toContain("secret");
  });

  it("shows the Business Profile location", () => {
    const summary = toConnectionSummary({
      ...ROW,
      platform: "google_business_profile",
      metadata: { locationName: "locations/123" },
    });

    expect(summary).toMatchObject({ username: null, locationName: "locations/123" });
  });

  it("copes with missing or empty metadata", () => {
    expect(toConnectionSummary({ ...ROW, metadata: null })).toMatchObject({ username: null, locationName: null });
    expect(toConnectionSummary({ ...ROW, metadata: { pageName: "" } })).toMatchObject({ username: null });
  });
});
