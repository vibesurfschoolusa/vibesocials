import { describe, expect, it } from "vitest";

import { SEND_AGAIN_MAX_AGE_DAYS, sendAgainTooOld, TOO_OLD_TO_SEND_MESSAGE } from "./sendAgain";

// Live check after F1: a post from months ago offered Send again, which would
// publish stale content today. Only a recent unsent post may be sent again.
describe("sendAgainTooOld", () => {
  const now = Date.parse("2026-11-14T12:00:00.000Z");
  const daysAgo = (days: number) => new Date(now - days * 86_400_000).toISOString();

  it("allows a post scheduled within the last week", () => {
    expect(sendAgainTooOld({ scheduledFor: daysAgo(6.9), createdAt: daysAgo(30) }, now)).toBe(false);
  });

  it("refuses a post scheduled more than a week ago", () => {
    expect(sendAgainTooOld({ scheduledFor: daysAgo(7.1), createdAt: daysAgo(1) }, now)).toBe(true);
  });

  it("uses the creation time when the post had no time", () => {
    expect(sendAgainTooOld({ scheduledFor: null, createdAt: daysAgo(2) }, now)).toBe(false);
    expect(sendAgainTooOld({ scheduledFor: null, createdAt: daysAgo(300) }, now)).toBe(true);
  });

  it("takes Date objects too (the server's rows)", () => {
    expect(sendAgainTooOld({ scheduledFor: new Date(now - 86_400_000), createdAt: null }, now)).toBe(false);
  });

  it("treats a post with no time at all as too old to judge, so it is not sent", () => {
    expect(sendAgainTooOld({ scheduledFor: null, createdAt: null }, now)).toBe(true);
  });

  it("says so plainly", () => {
    expect(SEND_AGAIN_MAX_AGE_DAYS).toBe(7);
    expect(TOO_OLD_TO_SEND_MESSAGE).toBe(
      "This post was not sent, and it is too old to send again. Create it again if you still want it.",
    );
  });
});
