import { describe, expect, it } from "vitest";

import { GEOCODE_DAILY_LIMIT_CODE, GEOCODE_DAILY_LIMIT_MESSAGE, geocodeLimitNote } from "./limit";

describe("geocodeLimitNote", () => {
  it("is the route's sentence for the app's daily limit", () => {
    expect(
      geocodeLimitNote(429, { error: GEOCODE_DAILY_LIMIT_MESSAGE, code: GEOCODE_DAILY_LIMIT_CODE }),
    ).toBe("Place suggestions are off for the rest of today. Type the place in full; it is saved as you type it.");
  });

  it("is null for anything else: an answer, another refusal, a body that is not ours", () => {
    expect(geocodeLimitNote(200, { suggestions: [] })).toBeNull();
    expect(geocodeLimitNote(429, { error: "Too many place lookups." })).toBeNull();
    expect(geocodeLimitNote(429, null)).toBeNull();
    expect(geocodeLimitNote(429, { code: GEOCODE_DAILY_LIMIT_CODE, error: 5 })).toBeNull();
    expect(geocodeLimitNote(500, { code: GEOCODE_DAILY_LIMIT_CODE, error: "x" })).toBeNull();
  });
});
