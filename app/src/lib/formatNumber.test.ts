import { describe, expect, it } from "vitest";

import { formatNumber } from "./formatNumber";

// Go-live check 2026-11-11: the report printed 1388 where the dashboard printed 1,238.
describe("formatNumber", () => {
  it("puts a thousands separator in, as the dashboard's Google listing card does", () => {
    expect(formatNumber(999)).toBe("999");
    expect(formatNumber(1000)).toBe("1,000");
    expect(formatNumber(1388)).toBe("1,388");
    expect(formatNumber(1234567)).toBe("1,234,567");
  });
});
