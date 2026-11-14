import { describe, expect, it } from "vitest";

import { emailDate, emailDateTime, usableTimeZone } from "@/server/notifications/emailTime";

const AT = new Date("2026-11-14T02:30:00.000Z");

describe("emailDateTime", () => {
  it("shows the time in the recipient's zone with its abbreviation", () => {
    expect(emailDateTime(AT, "America/New_York")).toBe("Fri, Nov 13, 2026, 9:30 PM EST");
  });

  it("falls back to UTC, labelled, without a zone", () => {
    expect(emailDateTime(AT, null)).toBe("Sat, Nov 14, 2026, 2:30 AM UTC");
  });

  it("falls back to UTC for a zone name that is not real", () => {
    expect(emailDateTime(AT, "Mars/Olympus")).toBe("Sat, Nov 14, 2026, 2:30 AM UTC");
  });
});

describe("emailDate", () => {
  it("names the day in the recipient's zone", () => {
    expect(emailDate(AT, "America/Chicago")).toBe("Friday, November 13, 2026");
  });

  it("labels UTC when the zone is unknown", () => {
    expect(emailDate(AT, undefined)).toBe("Saturday, November 14, 2026 (UTC)");
  });
});

describe("usableTimeZone", () => {
  it.each([
    ["Europe/Berlin", "Europe/Berlin"],
    ["UTC", "UTC"],
    ["Mars/Olympus", null],
    ["", null],
    [null, null],
    [`${"A".repeat(70)}`, null],
  ])("%j -> %j", (zone, expected) => {
    expect(usableTimeZone(zone)).toBe(expected);
  });
});
