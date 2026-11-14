import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { privacyLastUpdated } from "@/lib/legalLastUpdated";
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
      "and recent captions from this workspace's posts, so the AI does not repeat them",
    );
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
