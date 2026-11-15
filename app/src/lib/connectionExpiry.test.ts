import { describe, expect, it } from "vitest";

import { EXPIRY_WARNING_LEAD_MS } from "@/server/jobs/connectionHealthSweep";

import { CONNECTION_EXPIRY_SELECT, inExpiryWarningWindow } from "./connectionExpiry";

/**
 * R6-pages M1 / R6-client-journey M1: a connection that cannot be renewed and
 * ends within the warning lead may be reconnected in place, from Settings and
 * from a client connect link. One rule decides it everywhere.
 */

const NOW = new Date("2026-11-14T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

function linkedIn(fields: Partial<Parameters<typeof inExpiryWarningWindow>[0]> = {}) {
  return {
    platform: "linkedin" as const,
    expiresAt: new Date(NOW.getTime() + 3 * DAY),
    refreshToken: null,
    needsReconnect: false,
    ...fields,
  };
}

describe("inExpiryWarningWindow", () => {
  it("is false for a healthy connection far from its expiry", () => {
    expect(inExpiryWarningWindow(linkedIn({ expiresAt: new Date(NOW.getTime() + 40 * DAY) }), NOW)).toBe(false);
  });

  it("is true inside the warning lead, up to and including its first moment", () => {
    expect(inExpiryWarningWindow(linkedIn(), NOW)).toBe(true);
    expect(inExpiryWarningWindow(linkedIn({ expiresAt: new Date(NOW.getTime() + EXPIRY_WARNING_LEAD_MS) }), NOW)).toBe(true);
    expect(
      inExpiryWarningWindow(linkedIn({ expiresAt: new Date(NOW.getTime() + EXPIRY_WARNING_LEAD_MS + 1) }), NOW),
    ).toBe(false);
  });

  it("is true for an expiry that has passed but is not flagged yet (the sweep flags it later)", () => {
    expect(inExpiryWarningWindow(linkedIn({ expiresAt: new Date(NOW.getTime() - DAY) }), NOW)).toBe(true);
  });

  it("is false once flagged: that is the Reconnect the app already shows", () => {
    expect(inExpiryWarningWindow(linkedIn({ needsReconnect: true }), NOW)).toBe(false);
  });

  it("is false for a renewable connection (it has a refresh token) or one with no expiry", () => {
    expect(inExpiryWarningWindow(linkedIn({ refreshToken: "sealed" }), NOW)).toBe(false);
    expect(inExpiryWarningWindow(linkedIn({ expiresAt: null }), NOW)).toBe(false);
  });

  it("is false for Facebook and Instagram, whose Page token does not end on that date", () => {
    expect(inExpiryWarningWindow(linkedIn({ platform: "facebook_page" }), NOW)).toBe(false);
    expect(inExpiryWarningWindow(linkedIn({ platform: "instagram" }), NOW)).toBe(false);
  });

  it("reads a date string as well as a Date", () => {
    expect(inExpiryWarningWindow(linkedIn({ expiresAt: new Date(NOW.getTime() + DAY).toISOString() }), NOW)).toBe(true);
  });

  it("names the columns it needs, so every caller selects the same ones", () => {
    expect(CONNECTION_EXPIRY_SELECT).toEqual({ platform: true, expiresAt: true, refreshToken: true, needsReconnect: true });
  });
});
