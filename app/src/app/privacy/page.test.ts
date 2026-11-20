import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { legalDateValue, privacyLastUpdated } from "@/lib/legalLastUpdated";
import { OPERATOR_LOCATION, OPERATOR_NAME } from "@/lib/siteInfo";

import PrivacyPage from "./page";

/**
 * F7 (R1 H1, M2, L8): the policy under-stated what the app reads. It now names
 * every number read back from the platforms and the Google listing, where they
 * show, how long they are kept, what clients send through links, and what goes
 * to the AI provider.
 */

function text(): string {
  return renderToStaticMarkup(PrivacyPage() as ReactElement)
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");
}

beforeEach(() => {
  vi.stubEnv("BILLING_ENABLED", undefined);
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("Privacy: post numbers read back from the platforms", () => {
  it.each([
    "views, likes and comments on YouTube",
    "likes and comments on Instagram",
    "reactions, comments and shares on Facebook",
    "views, clicks, likes, comments and shares on LinkedIn",
    "views, saves and clicks on Pinterest",
  ])("names %s", (phrase) => {
    expect(text()).toContain(phrase);
  });

  it("says what it does not read", () => {
    expect(text()).toContain("We read no numbers from X, TikTok or Google Business Profile posts.");
  });

  it("drops the sentences the reads made untrue", () => {
    const page = text();
    expect(page).not.toContain("your messages or your analytics");
    expect(page).not.toContain("comments and reactions on your posts.");
    expect(page).not.toContain("and (for YouTube) view and engagement counts");
  });
});

describe("Privacy: the Google listing's numbers", () => {
  it("names the daily numbers read", () => {
    expect(text()).toContain(
      "its daily search and Maps views, calls, direction requests and website clicks",
    );
  });
});

describe("Privacy: where the numbers show and how long they are kept", () => {
  it("says where they show", () => {
    expect(text()).toContain("in the app, in monthly reports, in emails and on the client review link");
  });

  it("says how often they are read and how long they are kept", () => {
    const page = text();
    expect(page).toContain("once a day for posts published in the last 60 days");
    expect(page).toContain(
      "Disconnecting a platform in Settings deletes the post numbers read from it; disconnecting Google Business Profile also deletes the listing's numbers.",
    );
    expect(page).toContain("Deleting a workspace deletes everything in it");
  });

  it("keeps the YouTube 30-day rule", () => {
    expect(text()).toContain("YouTube numbers not refreshed for 30 days are deleted");
  });
});

describe("Privacy: what clients send through links", () => {
  it("names the upload link's name, note and files, and the review link's change requests", () => {
    const page = text();
    expect(page).toContain("the photos and videos they send, and the name and note they add");
    expect(page).toContain("what they ask to have changed");
  });
});

describe("Privacy: what goes to the AI provider", () => {
  it("names the media, captions and review text, and how to stop it in Add many", () => {
    const page = text();
    expect(page).toContain("photos and still frames of videos");
    expect(page).toContain("captions");
    expect(page).toContain("the review's text, star rating and the reviewer's display name");
    expect(page).toContain("Turn off Write captions with AI in Add many");
  });

  // G4 (R2-pages M2): auto-caption and Improve also send recent captions.
  it("says recent captions from the workspace's posts go with auto-caption and Improve", () => {
    expect(text()).toContain(
      "whenever it writes or improves a caption (on Create and in Add many), recent captions from this workspace's posts",
    );
    expect(text()).toContain("so the AI does not repeat them");
  });

  it("no longer says the AI can only be turned off on Create", () => {
    expect(text()).not.toContain("(you can turn this off on the Create page)");
  });
});

describe("Privacy: unchanged parts", () => {
  it("keeps the operator", () => {
    expect(text()).toContain(`is operated by ${OPERATOR_NAME}, ${OPERATOR_LOCATION}.`);
  });

  it("shows its own date, once", () => {
    const page = text();
    expect(page).toContain(`Last updated: ${privacyLastUpdated(false)}`);
    expect(page.match(/Last updated:/g)).toHaveLength(1);
  });
});

// R6-pages L6, R7-pages L1: how long the address an email change replaced is
// kept. The daily sweep deletes it, so "within a day after" is what is true.
describe("Privacy: a previous sign-in email", () => {
  it("says it is kept 72 hours for the undo link, then deleted within a day", () => {
    expect(text()).toContain(
      "When you change your sign-in email, we keep your previous address for 72 hours, so that a link sent to it can undo the change; it is deleted within a day after the 72 hours.",
    );
  });
});

// R9-pages L3: the usage records the limits read outlive a deletion for 62 days.
describe("Privacy: usage counts for the limits", () => {
  it("says what is kept, why and for how long, also after a deletion", () => {
    expect(text()).toContain("A count of posts per person and per X account, and of workspaces each person created, used for the daily and monthly limits, is kept for 62 days, also after a workspace or account is deleted.");
  });
});

// FF2 review: the Location field and its place search were removed (YouTube's
// location fields are deprecated, no other platform used one), so the notice no
// longer names place search or Google Maps Platform as a processor.
describe("Privacy: no place search", () => {
  it("names no place search and no Google Maps Platform", () => {
    const page = text();
    expect(page).not.toContain("suggest places");
    expect(page).not.toContain("Google Maps");
    expect(page).not.toContain("add a location to a post");
  });
});

// R36 pages note: the LinkedIn name refresh reads at most 25 connections a
// run, so past 25 it is not every day; the eight-week deletion still holds.
describe("Privacy: a LinkedIn page's name", () => {
  it("says it is read again regularly, not every day, and keeps the eight-week promise", () => {
    const page = text();
    expect(page).toContain("is read again from LinkedIn regularly while the connection works.");
    expect(page).not.toContain("read again from LinkedIn every day");
    expect(page).toContain("A name not refreshed for eight weeks is deleted; disconnecting LinkedIn deletes it at once.");
  });

  it("carries the date of this change or a later one", () => {
    expect(legalDateValue(privacyLastUpdated(false))).toBeGreaterThanOrEqual(legalDateValue("November 16, 2026"));
  });
});

// R46 pages-a L3 (second half): the TikTok section names exactly the scopes
// the connect route asks TikTok for, read from the route's own code so the
// two can't drift.
describe("Privacy: the TikTok permissions are the ones the app asks for", () => {
  it("names each scope the start route requests, and no other", async () => {
    const { readFileSync } = await import("node:fs");
    const route = readFileSync(new URL("../api/auth/tiktok/start/route.ts", import.meta.url), "utf8");
    const scopeLine = /searchParams\.set\("scope", "([^"]+)"\)/.exec(route);
    expect(scopeLine).not.toBeNull();
    const requested = scopeLine![1].split(",").sort();
    expect(requested.length).toBeGreaterThan(0);

    const page = text();
    const section = page.slice(page.indexOf("3. TikTok"), page.indexOf("We do not read your TikTok videos"));
    const named = [...new Set(section.match(/\b[a-z]+(?:\.[a-z]+)+(?=[\s/:])/g) ?? [])].sort();
    expect(named).toEqual(requested);
    for (const scope of requested) expect(section).toContain(`${scope}:`);
  });

  it("carries the date of this change", () => {
    expect(privacyLastUpdated(false)).toBe("November 20, 2026");
    expect(text()).toContain("Last updated: November 20, 2026");
  });
});
