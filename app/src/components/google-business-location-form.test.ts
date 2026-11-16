import { describe, expect, it } from "vitest";

import {
  GBP_RECONNECT_CODE,
  GBP_RECONNECT_MESSAGE,
} from "@/app/api/connections/google_business_profile/gbpLocations";

import { LOCATION_MESSAGES, LOCATION_RECONNECT_CODE, locationFailure } from "./google-business-location-form";

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

// R24 platform-clients L1: a revoked grant says to reconnect, and the card
// refreshes so it shows its Reconnect state without a manual reload.
describe("Google location form: a failed answer", () => {
  it("the routes' reconnect code asks the card to refresh, with the route's text", () => {
    expect(LOCATION_RECONNECT_CODE).toBe(GBP_RECONNECT_CODE);
    expect(
      locationFailure({ error: GBP_RECONNECT_MESSAGE, code: GBP_RECONNECT_CODE }, LOCATION_MESSAGES.loadFailed),
    ).toEqual({ message: GBP_RECONNECT_MESSAGE, reconnect: true });
  });

  it("any other error keeps its text and does not refresh", () => {
    expect(locationFailure({ error: "Google didn't answer. Try again in a minute." }, LOCATION_MESSAGES.loadFailed)).toEqual({
      message: "Google didn't answer. Try again in a minute.",
      reconnect: false,
    });
  });

  it("no JSON body gives the form's own sentence", () => {
    expect(locationFailure(null, LOCATION_MESSAGES.saveFailed)).toEqual({
      message: LOCATION_MESSAGES.saveFailed,
      reconnect: false,
    });
  });
});
