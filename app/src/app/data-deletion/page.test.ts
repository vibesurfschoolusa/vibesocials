import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import DataDeletionPage from "./page";

/**
 * G4 (R2-pages L8): the data-deletion page says what the privacy page says:
 * disconnecting deletes the numbers read from that platform, and deleting a
 * workspace removes the Google listing's numbers and what clients sent.
 */

function text(): string {
  return renderToStaticMarkup(DataDeletionPage() as ReactElement)
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");
}

describe("Data deletion: disconnecting one platform", () => {
  it("says the numbers read from it are deleted, and the listing's numbers for Google Business Profile", () => {
    const page = text();
    expect(page).toContain(
      "It also deletes the post numbers read from that platform; disconnecting Google Business Profile also deletes the listing's numbers. They cannot be brought back.",
    );
  });

  it("still says past posts stay in Activity", () => {
    expect(text()).toContain("Your past posts and their per-platform results stay in your Activity history");
  });
});

describe("Data deletion: deleting a workspace or account", () => {
  it("lists the post numbers, the Google listing's numbers and what clients sent through links", () => {
    const page = text();
    expect(page).toContain("The post numbers read from the platforms for those posts.");
    expect(page).toContain("The Google listing numbers read for their Google Business Profile location.");
    expect(page).toContain(
      "What clients sent through their links: the photos and videos, the names and notes added, and the change requests.",
    );
  });
});

// R5 pages L13.
describe("Data deletion: landmarks", () => {
  it("has a main landmark", () => {
    expect(renderToStaticMarkup(DataDeletionPage() as ReactElement)).toMatch(/<main[ >]/);
  });
});

// R6-pages L9: the standard public footer, as on the other public pages.
describe("Data deletion: footer", () => {
  it("ends with the site links every public page has", () => {
    const html = renderToStaticMarkup(DataDeletionPage() as ReactElement);
    expect(html).toContain('<nav aria-label="Site"');
    for (const href of ["/about", "/help", "/about#contact", "/privacy", "/terms", "/data-deletion"]) {
      expect(html).toContain(`href="${href}"`);
    }
  });
});

// R7-pages L2: deleting the account waits while an email change can be undone
// (api/auth/account refuses until then), so the page says so.
describe("Data deletion: after an email change", () => {
  it("says deleting the account waits while an email change can still be undone", () => {
    const page = text();
    expect(page).toContain(
      "Deleting your account waits while a change of your sign-in email can still be undone: up to 72 hours after you changed it from a confirmed address.",
    );
    expect(page).not.toContain("If you changed your sign-in email in the last 72 hours");
  });

  it("no longer promises deletion at any time", () => {
    expect(text()).not.toContain("at any time");
  });
});

// R9-pages L3: the usage records the limits read outlive a deletion for 62 days.
describe("Data deletion: usage counts for the limits", () => {
  it("says what is kept, why and for how long, also after a deletion", () => {
    expect(text()).toContain("A count of posts per person and per X account, used for the daily and monthly limits, is kept for 62 days, also after a workspace or account is deleted.");
  });
});
