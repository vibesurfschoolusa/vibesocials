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

  // 2026-11-09 first-run check: Settings read "Connected as
  // google_business_profile" (a placeholder account id).
  it("names a Business Profile by its chosen location, never by its placeholder id", () => {
    const base = { ...ROW, platform: "google_business_profile" as const, accountIdentifier: "google_business_profile" };

    expect(
      toConnectionSummary({ ...base, metadata: { locationName: "accounts/1/locations/2", locationTitle: "Vibe Surf School" } }),
    ).toMatchObject({ username: "Vibe Surf School", accountIdentifier: "" });
    expect(toConnectionSummary({ ...base, metadata: { locationName: null } })).toMatchObject({
      username: null,
      accountIdentifier: "",
    });
  });

  it("shows the Business Profile location", () => {
    const summary = toConnectionSummary({
      ...ROW,
      platform: "google_business_profile",
      metadata: { locationName: "locations/123" },
    });

    expect(summary).toMatchObject({ username: null, locationName: "locations/123" });
  });

  // 2026-11-10: a Pinterest connection posts to one board, chosen at connect.
  it("names a Pinterest connection by its username and the board it posts to", () => {
    const base = { ...ROW, platform: "pinterest" as const, accountIdentifier: "vibesurfschool" };

    expect(
      toConnectionSummary({
        ...base,
        metadata: { username: "vibesurfschool", boardId: "555", boardName: "Surf lessons" },
      }).username,
    ).toBe("vibesurfschool, board \u201cSurf lessons\u201d");
    expect(toConnectionSummary({ ...base, metadata: { username: "vibesurfschool" } }).username).toBe(
      "vibesurfschool",
    );
  });

  it("copes with missing or empty metadata", () => {
    expect(toConnectionSummary({ ...ROW, metadata: null })).toMatchObject({ username: null, locationName: null });
    expect(toConnectionSummary({ ...ROW, metadata: { pageName: "" } })).toMatchObject({ username: null });
  });
});
