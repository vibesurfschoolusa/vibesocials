import { describe, expect, it } from "vitest";

import { CONNECT_LINK_COOKIE_MAX_AGE_SECONDS, CONNECT_LINK_RATE_LIMIT_MESSAGE } from "./connectLink";
import { REVIEW_LINK_DAILY_LIMIT_MESSAGE, REVIEW_LINK_DAILY_LIMIT_REASON, REVIEW_LINK_IP_LIMIT_MESSAGE } from "./reviewLink";
import { PENDING_CONNECTION_TTL_MS } from "@/server/connections/pendingConnection";

import {
  CLIENT_LINK_LIMIT_REASON,
  dailyLimitSentence,
  limitReachedSentence,
  limitWaitSeconds,
  sendAgainSentence,
} from "./clientLinkLimit";

/**
 * R40 client-journey L2/L3: one "limit reached" view for every client link.
 * A 429 shows no button and one instruction built from its wait; when the
 * wait outlasts what is waited for, it names the step that works after it.
 */
describe("limitReachedSentence", () => {
  it("is the routes' own reason, so the pages and the routes can't drift apart", () => {
    expect(CONNECT_LINK_RATE_LIMIT_MESSAGE.startsWith(CLIENT_LINK_LIMIT_REASON)).toBe(true);
    expect(REVIEW_LINK_IP_LIMIT_MESSAGE.startsWith(CLIENT_LINK_LIMIT_REASON)).toBe(true);
  });

  it("says to reload in N minutes, rounded up", () => {
    expect(limitReachedSentence(300)).toBe(`${CLIENT_LINK_LIMIT_REASON} Reload this page in 5 minutes.`);
    expect(limitReachedSentence(61)).toBe(`${CLIENT_LINK_LIMIT_REASON} Reload this page in 2 minutes.`);
    expect(limitReachedSentence(20)).toBe(`${CLIENT_LINK_LIMIT_REASON} Reload this page in 1 minute.`);
  });

  it("with no wait known: reload later", () => {
    expect(limitReachedSentence(undefined)).toBe(`${CLIENT_LINK_LIMIT_REASON} Reload this page later.`);
    expect(limitReachedSentence(0)).toBe(`${CLIENT_LINK_LIMIT_REASON} Reload this page later.`);
  });

  it("a wait that outlasts what is waited for names the step after it", () => {
    const outlasts = { lifeSeconds: 900, then: "press Connect beside Facebook Page again." };
    expect(limitReachedSentence(1500, outlasts)).toBe(
      `${CLIENT_LINK_LIMIT_REASON} Wait 25 minutes, then press Connect beside Facebook Page again.`,
    );
    expect(limitReachedSentence(900, outlasts)).toBe(
      `${CLIENT_LINK_LIMIT_REASON} Wait 15 minutes, then press Connect beside Facebook Page again.`,
    );
    expect(limitReachedSentence(300, outlasts)).toBe(`${CLIENT_LINK_LIMIT_REASON} Reload this page in 5 minutes.`);
  });

  // R41 client-journey L3: the sentence rounds the wait up, so the rounded wait is compared.
  it("compares the wait as printed, rounded up, plus a minute to reload and press", () => {
    const outlasts = { lifeSeconds: 830, then: "press Connect beside Facebook Page again." };
    expect(limitReachedSentence(790, outlasts)).toBe(
      `${CLIENT_LINK_LIMIT_REASON} Wait 14 minutes, then press Connect beside Facebook Page again.`,
    );
    // 13 minutes printed, plus the minute: 840 s, past the 830 s left.
    expect(limitReachedSentence(721, outlasts)).toBe(
      `${CLIENT_LINK_LIMIT_REASON} Wait 13 minutes, then press Connect beside Facebook Page again.`,
    );
    // 12 minutes printed, plus the minute: 780 s, inside the 830 s left.
    expect(limitReachedSentence(720, outlasts)).toBe(`${CLIENT_LINK_LIMIT_REASON} Reload this page in 12 minutes.`);
    expect(limitReachedSentence(600, outlasts)).toBe(`${CLIENT_LINK_LIMIT_REASON} Reload this page in 10 minutes.`);
  });

  // R41 review: a claim that the thing ends by itself needs the rounded wait itself to reach its end.
  it("with no margin, says to wait only when the rounded wait reaches the life left", () => {
    const outlasts = { lifeSeconds: 830, then: "reload this page.", marginSeconds: 0 };
    expect(limitReachedSentence(721, outlasts)).toBe(`${CLIENT_LINK_LIMIT_REASON} Reload this page in 13 minutes.`);
    expect(limitReachedSentence(781, outlasts)).toBe(`${CLIENT_LINK_LIMIT_REASON} Wait 14 minutes, then reload this page.`);
  });

  it("the /c choice's life on the page is the server's", () => {
    expect(CONNECT_LINK_COOKIE_MAX_AGE_SECONDS * 1000).toBe(PENDING_CONNECTION_TTL_MS);
  });
});

// R41 review: on /v the decisions come back by themselves when the wait ends, so no reload step.
describe("sendAgainSentence", () => {
  it("names the wait, rounded up, with no reload step; an hour when none is known", () => {
    expect(sendAgainSentence(1500)).toBe(`${CLIENT_LINK_LIMIT_REASON} You can send again in 25 minutes.`);
    expect(sendAgainSentence(1)).toBe(`${CLIENT_LINK_LIMIT_REASON} You can send again in 1 minute.`);
    expect(sendAgainSentence(undefined)).toBe(`${CLIENT_LINK_LIMIT_REASON} You can send again in 60 minutes.`);
  });
});

// R41 lead: the per-link daily 429 gets the same view, worded from its wait when it names one.
describe("dailyLimitSentence", () => {
  it("is the route's own sentence when no wait is known", () => {
    expect(dailyLimitSentence(undefined)).toBe(REVIEW_LINK_DAILY_LIMIT_MESSAGE);
    expect(dailyLimitSentence(0)).toBe(REVIEW_LINK_DAILY_LIMIT_MESSAGE);
    expect(REVIEW_LINK_DAILY_LIMIT_MESSAGE.startsWith(REVIEW_LINK_DAILY_LIMIT_REASON)).toBe(true);
  });

  it("names the wait in hours from an hour on, else in minutes, rounded up", () => {
    expect(dailyLimitSentence(5 * 3600)).toBe("This link has reached today's limit. Reload this page in 5 hours.");
    expect(dailyLimitSentence(3601)).toBe("This link has reached today's limit. Reload this page in 2 hours.");
    expect(dailyLimitSentence(3600)).toBe("This link has reached today's limit. Reload this page in 1 hour.");
    expect(dailyLimitSentence(1500)).toBe("This link has reached today's limit. Reload this page in 25 minutes.");
  });
});

describe("limitWaitSeconds", () => {
  it("reads the body's retryAfterSeconds first, then the Retry-After header", () => {
    const headed = new Response(null, { status: 429, headers: { "Retry-After": "60" } });
    expect(limitWaitSeconds(headed, { retryAfterSeconds: 1500 })).toBe(1500);
    expect(limitWaitSeconds(headed, null)).toBe(60);
    expect(limitWaitSeconds(new Response(null, { status: 429 }), {})).toBeUndefined();
    expect(limitWaitSeconds(new Response(null, { status: 429, headers: { "Retry-After": "soon" } }), {})).toBeUndefined();
  });
});
