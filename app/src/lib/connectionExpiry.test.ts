import { describe, expect, it } from "vitest";

import { EXPIRY_WARNING_LEAD_MS } from "@/server/jobs/connectionHealthSweep";

import {
  CONNECTION_EXPIRY_SELECT,
  connectionEndNextStep,
  connectionExpiryState,
  expiryEnded,
  inExpiryWarningWindow,
  connectedSuccessQuery,
  sameEndDateMessage,
  signInEndsSoon,
} from "./connectionExpiry";

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

// R6 review low 3: an end date that has passed before the sweep flagged it.
describe("expiryEnded", () => {
  it("5 days ahead: not ended (Ends soon)", () => {
    expect(expiryEnded(linkedIn({ expiresAt: new Date(NOW.getTime() + 5 * DAY) }), NOW)).toBe(false);
  });

  it("passed and not flagged: ended", () => {
    expect(expiryEnded(linkedIn({ expiresAt: new Date(NOW.getTime() - DAY) }), NOW)).toBe(true);
    expect(expiryEnded(linkedIn({ expiresAt: NOW }), NOW)).toBe(true);
  });

  it("flagged, renewable or far: not this state", () => {
    expect(expiryEnded(linkedIn({ expiresAt: new Date(NOW.getTime() - DAY), needsReconnect: true }), NOW)).toBe(false);
    expect(expiryEnded(linkedIn({ expiresAt: new Date(NOW.getTime() - DAY), refreshToken: "sealed" }), NOW)).toBe(false);
  });
});

// R7-pages L4 / client-journey L3: one state for every page that shows a connection.
describe("connectionExpiryState", () => {
  it("ends in 2 days: ends_soon", () => {
    expect(connectionExpiryState(linkedIn({ expiresAt: new Date(NOW.getTime() + 2 * DAY) }), NOW)).toBe("ends_soon");
  });

  it("ended, not flagged yet: ended", () => {
    expect(connectionExpiryState(linkedIn({ expiresAt: new Date(NOW.getTime() - DAY) }), NOW)).toBe("ended");
  });

  it("healthy, renewable or already flagged: null", () => {
    expect(connectionExpiryState(linkedIn({ expiresAt: new Date(NOW.getTime() + 40 * DAY) }), NOW)).toBeNull();
    expect(connectionExpiryState(linkedIn({ refreshToken: "sealed" }), NOW)).toBeNull();
    expect(connectionExpiryState(linkedIn({ needsReconnect: true }), NOW)).toBeNull();
  });
});

// Unconfirmed (client-journey): a reconnect that LinkedIn answered with the same end date.
describe("sameEndDateMessage", () => {
  // R8-pages L5: says what to do, since pressing Reconnect again changes nothing.
  it("names the date and the two ways forward", () => {
    expect(sameEndDateMessage("linkedin", "2026-11-16T12:00:00.000Z")).toBe(
      "LinkedIn kept the end date November 16, 2026. Reconnect again after that date, or sign out of LinkedIn and reconnect to get a new 60-day sign-in.",
    );
  });
});

// R8-client-journey L4 / pages L4: the Workspaces page's Ended / Ends soon lines.
describe("connectionEndNextStep", () => {
  it("an owner: reconnect it, or them for several", () => {
    expect(connectionEndNextStep("owner", 1)).toBe("Reconnect it in Settings, Connections.");
    expect(connectionEndNextStep("owner", 2)).toBe("Reconnect them in Settings, Connections.");
  });

  it("a member can't reconnect: the workspace owner can", () => {
    expect(connectionEndNextStep("member", 1)).toBe("The workspace owner can reconnect it.");
    expect(connectionEndNextStep("member", 3)).toBe("The workspace owner can reconnect them.");
  });
});

// R7 review 4: a new sign-in (callback or a choice from a list) that already ends within the warning window.
describe("signInEndsSoon", () => {
  it("LinkedIn, no refresh token, ends in 3 days: true; in 60 days: false", () => {
    expect(signInEndsSoon("linkedin", new Date(NOW.getTime() + 3 * DAY), null, NOW)).toBe(true);
    expect(signInEndsSoon("linkedin", new Date(NOW.getTime() + 60 * DAY).toISOString(), null, NOW)).toBe(false);
  });

  it("with a refresh token it renews: false", () => {
    expect(signInEndsSoon("linkedin", new Date(NOW.getTime() + 3 * DAY), "refresh", NOW)).toBe(false);
  });
});

describe("connectedSuccessQuery", () => {
  it("the success code, with the same-end flag only when asked", () => {
    expect(connectedSuccessQuery("linkedin", false)).toBe("success=linkedin_connected");
    expect(connectedSuccessQuery("linkedin", true)).toBe("success=linkedin_connected&same_end=1");
  });
});
