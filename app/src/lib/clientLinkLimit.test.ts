import { describe, expect, it } from "vitest";

import { CONNECT_LINK_COOKIE_MAX_AGE_SECONDS, CONNECT_LINK_RATE_LIMIT_MESSAGE } from "./connectLink";
import { REVIEW_LINK_DAILY_LIMIT_MESSAGE, REVIEW_LINK_DAILY_LIMIT_REASON, REVIEW_LINK_IP_LIMIT_MESSAGE } from "./reviewLink";
import { LIMIT_UNCHECKED_MESSAGE } from "./limitUncheckedMessage";
import { PENDING_CONNECTION_TTL_MS } from "@/server/connections/pendingConnection";

import {
  CLIENT_LINK_LIMIT_REASON,
  LIMIT_UNCHECKED_REASON,
  connectAgainSentence,
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

// R45 pages-a L7 / R46 client-journey L1: a Connect press the start route
// refused comes back to /c with the wait's end time in the address, so the
// sentence is built from a typed value and the page's own clock: it is true
// whenever the page is read, not only just after the press.
describe("connectAgainSentence", () => {
  // Refused at 10:15 with 45 minutes left: the limit lifts at 11:00.
  const REFUSED_AT = Date.parse("2026-11-19T10:15:00Z");
  const LIFTS_AT = String(Date.parse("2026-11-19T11:00:00Z") / 1000);

  it("read at the refusal: the wait left, rounded up, and the button beside the platform", () => {
    expect(connectAgainSentence("rate_limited", LIFTS_AT, "Connect", "Instagram", REFUSED_AT)).toBe(
      `${CLIENT_LINK_LIMIT_REASON} Wait 45 minutes, then press Connect beside Instagram again.`,
    );
    expect(connectAgainSentence("rate_limited", LIFTS_AT, "Reconnect", "TikTok", Date.parse("2026-11-19T10:59:40Z"))).toBe(
      `${CLIENT_LINK_LIMIT_REASON} Wait 1 minute, then press Reconnect beside TikTok again.`,
    );
  });

  it("read again at 11:00 or later: only the step, no wait and no stale reason", () => {
    for (const at of ["2026-11-19T11:00:00Z", "2026-11-19T11:00:01Z", "2026-11-20T09:00:00Z"]) {
      expect(connectAgainSentence("rate_limited", LIFTS_AT, "Connect", "Instagram", Date.parse(at)), at).toBe(
        "Press Connect beside Instagram again.",
      );
    }
    expect(connectAgainSentence("used_too_often", LIFTS_AT, "Connect", null, Date.parse("2026-11-19T12:00:00Z"))).toBe(
      "Press Connect again.",
    );
  });

  it("the link's own limit has its own reason", () => {
    const until = String(REFUSED_AT / 1000 + 120);
    expect(connectAgainSentence("used_too_often", until, "Connect", "X", REFUSED_AT)).toBe(
      "This link was used too many times in the last hour. Wait 2 minutes, then press Connect beside X again.",
    );
  });

  // R46 pages-a L1: a limit that couldn't be checked comes back the same way, with a minute's wait.
  it("a limit that couldn't be checked: its own reason and the minute, then only the step", () => {
    const until = String(REFUSED_AT / 1000 + 60);
    expect(LIMIT_UNCHECKED_MESSAGE.startsWith(LIMIT_UNCHECKED_REASON)).toBe(true);
    expect(connectAgainSentence("limit_unchecked", until, "Connect", "Instagram", REFUSED_AT)).toBe(
      `${LIMIT_UNCHECKED_REASON} Wait 1 minute, then press Connect beside Instagram again.`,
    );
    expect(connectAgainSentence("limit_unchecked", until, "Connect", "Instagram", REFUSED_AT + 60_000)).toBe(
      "Press Connect beside Instagram again.",
    );
    expect(connectAgainSentence("limit_unchecked", "soon", "Connect", null, REFUSED_AT)).toBe(
      `${LIMIT_UNCHECKED_REASON} Wait a minute, then press Connect again.`,
    );
  });

  it("no platform: the button alone", () => {
    expect(connectAgainSentence("rate_limited", String(REFUSED_AT / 1000 + 60), "Connect", null, REFUSED_AT)).toBe(
      `${CLIENT_LINK_LIMIT_REASON} Wait 1 minute, then press Connect again.`,
    );
  });

  // The 1-hour cap: an end further off than the hour the limits count is typed, not ours.
  it.each([
    null,
    "",
    "soon",
    "-5",
    "12.5e9",
    "Infinity",
    "1".repeat(40),
    String(REFUSED_AT / 1000 + 3601),
  ])("an end of %j: at most the hour the limit counts", (until) => {
    expect(connectAgainSentence("rate_limited", until, "Connect", "X", REFUSED_AT)).toBe(
      `${CLIENT_LINK_LIMIT_REASON} Wait up to an hour, then press Connect beside X again.`,
    );
  });

  it("an end exactly an hour off is still the hour", () => {
    expect(connectAgainSentence("rate_limited", String(REFUSED_AT / 1000 + 3600), "Connect", "X", REFUSED_AT)).toBe(
      `${CLIENT_LINK_LIMIT_REASON} Wait 60 minutes, then press Connect beside X again.`,
    );
  });

  it("any other code: no sentence", () => {
    expect(connectAgainSentence("tiktok_cancelled", LIFTS_AT, "Connect", "TikTok", REFUSED_AT)).toBeNull();
    expect(connectAgainSentence(null, LIFTS_AT, "Connect", "TikTok", REFUSED_AT)).toBeNull();
  });
});
