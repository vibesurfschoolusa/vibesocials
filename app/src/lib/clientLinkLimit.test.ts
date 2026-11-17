import { describe, expect, it } from "vitest";

import { CONNECT_LINK_COOKIE_MAX_AGE_SECONDS, CONNECT_LINK_RATE_LIMIT_MESSAGE } from "./connectLink";
import { REVIEW_LINK_IP_LIMIT_MESSAGE } from "./reviewLink";
import { PENDING_CONNECTION_TTL_MS } from "@/server/connections/pendingConnection";

import { CLIENT_LINK_LIMIT_REASON, limitReachedSentence, limitWaitSeconds } from "./clientLinkLimit";

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

  it("the /c choice's life on the page is the server's", () => {
    expect(CONNECT_LINK_COOKIE_MAX_AGE_SECONDS * 1000).toBe(PENDING_CONNECTION_TTL_MS);
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
