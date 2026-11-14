import { describe, expect, it } from "vitest";

import {
  GEOCODE_DAILY_LIMIT_CODE,
  GEOCODE_DAILY_LIMIT_MESSAGE,
  GEOCODE_UNAVAILABLE_CODE,
  GEOCODE_USER_LIMIT_CODE,
  geocodeLimitNote,
} from "./limit";

describe("geocodeLimitNote", () => {
  it("is the route's sentence for the app's daily limit, the person's limit and an unreachable count", () => {
    expect(
      geocodeLimitNote(429, { error: GEOCODE_DAILY_LIMIT_MESSAGE, code: GEOCODE_DAILY_LIMIT_CODE }),
    ).toBe("Place suggestions are off for the rest of today. Type the place in full; it is saved as you type it.");
    expect(geocodeLimitNote(429, { error: "Too many place lookups.", code: GEOCODE_USER_LIMIT_CODE })).toBe(
      "Too many place lookups.",
    );
    expect(geocodeLimitNote(503, { error: "Not now.", code: GEOCODE_UNAVAILABLE_CODE })).toBe("Not now.");
  });

  it("is null for anything else: an answer, a refusal without our code, a body that is not ours", () => {
    expect(geocodeLimitNote(200, { suggestions: [] })).toBeNull();
    expect(geocodeLimitNote(429, { error: "Too many place lookups." })).toBeNull();
    expect(geocodeLimitNote(429, null)).toBeNull();
    expect(geocodeLimitNote(429, { code: GEOCODE_DAILY_LIMIT_CODE, error: 5 })).toBeNull();
    expect(geocodeLimitNote(500, { code: GEOCODE_DAILY_LIMIT_CODE, error: "x" })).toBeNull();
  });
});
