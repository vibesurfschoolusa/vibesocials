import { describe, expect, it } from "vitest";

import { initialLocation } from "./initial-location";
import type { Location } from "./types";

const loc = (name: string): Location => ({ name, locationName: name, title: name });
const SAVED = "accounts/1/locations/2";

// Go-live check 2026-11-11: /reviews made the owner pick the location on every
// visit although Settings holds the one posts go to.
describe("initialLocation", () => {
  it("opens with the saved location when it is one of the listed ones", () => {
    expect(initialLocation([loc("accounts/1/locations/9"), loc(SAVED)], SAVED)).toBe(SAVED);
  });

  it("asks as today when the saved location is not listed", () => {
    expect(initialLocation([loc("accounts/1/locations/8"), loc("accounts/1/locations/9")], SAVED)).toBeNull();
    // ... and still takes the only one there is, as today.
    expect(initialLocation([loc("accounts/1/locations/9")], SAVED)).toBe("accounts/1/locations/9");
  });

  it("asks as today with no saved location", () => {
    expect(initialLocation([loc("a"), loc("b")], null)).toBeNull();
    expect(initialLocation([loc("a")], null)).toBe("a");
  });

  it("chooses nothing when the list did not load", () => {
    expect(initialLocation([], SAVED)).toBeNull();
  });
});
