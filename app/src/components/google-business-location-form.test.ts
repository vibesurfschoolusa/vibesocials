import { describe, expect, it } from "vitest";

import { LOCATION_MESSAGES } from "./google-business-location-form";

// R5 new-customer L8 and pages L8: each message says what happened and what to do.
describe("Google location form messages", () => {
  it("an empty list says to switch to the Google account that manages the listing", () => {
    expect(LOCATION_MESSAGES.noLocations).toContain("no business listing");
    expect(LOCATION_MESSAGES.noLocations).toContain("Switch account");
    expect(LOCATION_MESSAGES.noLocations).toContain("the Google account that manages your listing");
  });

  it("failures say nothing was saved or loaded and what to do next", () => {
    expect(LOCATION_MESSAGES.saveFailed).toBe("The location wasn't saved. Please try again in a minute.");
    expect(LOCATION_MESSAGES.saveOffline).toContain("Check your internet connection");
    expect(LOCATION_MESSAGES.loadFailed).toBe(
      "Google didn't send the list of locations. Please press Fetch locations from Google again in a minute.",
    );
    expect(LOCATION_MESSAGES.loadOffline).toContain("Check your internet connection");
    for (const message of Object.values(LOCATION_MESSAGES)) {
      expect(message).not.toMatch(/^(Failed|Unexpected)/);
    }
  });
});
