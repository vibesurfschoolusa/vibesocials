import { describe, expect, it } from "vitest";

import { locationLookupAction } from "./locationLookup";

describe("locationLookupAction", () => {
  it.each([
    // [value, suppressedValue, expected]
    ["", null, "clear"],
    ["a", null, "clear"],
    [" a ", null, "clear"],
    ["mi", null, "search"],
    ["Miami Beach", null, "search"],
    // The value a selection wrote must not trigger a lookup (it reopened the
    // dropdown ~300ms after picking a suggestion).
    ["Miami Beach, FL (25.79,-80.13)", "Miami Beach, FL (25.79,-80.13)", "skip"],
    // Any other value - the user kept typing - looks up again.
    ["Miami Beach, FL (25.79,-80.13)x", "Miami Beach, FL (25.79,-80.13)", "search"],
    ["Mia", "Miami Beach, FL (25.79,-80.13)", "search"],
    // Too short to search is "clear" even if it equals the suppressed value.
    ["a", "a", "clear"],
  ] as const)("value %j with suppressed %j -> %s", (value, suppressed, expected) => {
    expect(locationLookupAction(value, suppressed)).toBe(expected);
  });
});
