import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { GOOGLE_BUTTON_LABELS, GOOGLE_BUTTON_TYPES } from "@/lib/googlePostOptions";
import type { GoogleBusinessPostMetadata } from "@/server/platforms/types";

import { GooglePostSettings } from "../google-post-settings";
import {
  GooglePostBox,
  allFieldsValid,
  googleBoxHold,
  googleBoxOpenAfterChange,
  googleBoxOpensOnSubmit,
  googleBoxShowsOpen,
  googlePostSummary,
} from "./google-post-box";

const render = (metadata: GoogleBusinessPostMetadata, open = false) =>
  renderToStaticMarkup(createElement(GooglePostBox, { metadata, onChange: () => {}, open, onOpenChange: () => {} }));

const event: GoogleBusinessPostMetadata = {
  postType: "event",
  event: { title: "Full moon paddle", startDate: "2026-11-20", endDate: "2026-11-20" },
  button: { type: "BOOK", url: "https://e.com/book" },
};
const offer: GoogleBusinessPostMetadata = {
  postType: "offer",
  offer: { title: "20% off", startDate: "2026-11-20", endDate: "2026-11-30" },
};

describe("googlePostSummary", () => {
  it("an update names its button, each one", () => {
    for (const type of GOOGLE_BUTTON_TYPES) {
      const button = type === "CALL" ? { type } : { type, url: "https://e.com" };
      expect(googlePostSummary({ postType: "update", button })).toBe(
        `Google post: Update, button ${GOOGLE_BUTTON_LABELS[type]}`,
      );
    }
    expect(googlePostSummary({ postType: "update", button: { type: "BOOK", url: "https://e.com" } })).toBe(
      "Google post: Update, button Book",
    );
  });

  it("an update without a button says so", () => {
    expect(googlePostSummary({ postType: "update" })).toBe("Google post: Update, no button");
  });

  it("an event names its button; an offer has none", () => {
    expect(googlePostSummary(event)).toBe("Google post: Event, button Book");
    expect(googlePostSummary(offer)).toBe("Google post: Offer");
  });
});

const book = (url: string): GoogleBusinessPostMetadata => ({ postType: "update", button: { type: "BOOK", url } });

describe("googleBoxHold: when the box may not fold", () => {
  it("an update whose fields the browser and the app take: nothing holds it", () => {
    expect(googleBoxHold({ metadata: book("https://e.com/book"), fieldsValid: true })).toBeNull();
    expect(googleBoxHold({ metadata: { postType: "update" }, fieldsValid: true })).toBeNull();
  });

  it("an offer or an event holds it open", () => {
    expect(googleBoxHold({ metadata: offer, fieldsValid: true })).toBe("offer-or-event");
    expect(googleBoxHold({ metadata: event, fieldsValid: true })).toBe("offer-or-event");
  });

  it("a link the browser refuses (www.mysite.com in a url field) holds it open", () => {
    expect(googleBoxHold({ metadata: book("www.mysite.com"), fieldsValid: false })).toBe("fix-link");
    // The browser's check alone is enough, whatever the app thinks.
    expect(googleBoxHold({ metadata: book("https://e.com/book"), fieldsValid: false })).toBe("fix-link");
  });

  it("a link the app refuses (Book with http://) holds it open", () => {
    expect(googleBoxHold({ metadata: book("http://e.com/book"), fieldsValid: true })).toBe("fix-link");
  });
});

describe("googleBoxShowsOpen", () => {
  it("collapsed by default for an update, open once the person opens it", () => {
    expect(googleBoxShowsOpen({ open: false, hold: null })).toBe(false);
    expect(googleBoxShowsOpen({ open: true, hold: null })).toBe(true);
  });

  it("open whenever something holds it", () => {
    expect(googleBoxShowsOpen({ open: false, hold: "offer-or-event" })).toBe(true);
    expect(googleBoxShowsOpen({ open: false, hold: "fix-link" })).toBe(true);
  });
});

describe("googleBoxOpenAfterChange", () => {
  it("choosing Offer or Event leaves the box open, so switching back to Update mid-edit does not close it", () => {
    expect(googleBoxOpenAfterChange(false, { metadata: offer, fieldsValid: true })).toBe(true);
    expect(googleBoxOpenAfterChange(false, { metadata: event, fieldsValid: true })).toBe(true);
    expect(googleBoxOpenAfterChange(true, { metadata: { postType: "update" }, fieldsValid: true })).toBe(true);
    expect(googleBoxOpenAfterChange(false, { metadata: { postType: "update" }, fieldsValid: true })).toBe(false);
  });

  it("a link being fixed leaves it open, so it does not fold away mid-typing once it is right", () => {
    expect(googleBoxOpenAfterChange(false, { metadata: book("www.mysite.com"), fieldsValid: false })).toBe(true);
    expect(googleBoxOpenAfterChange(false, { metadata: book("http://e.com"), fieldsValid: true })).toBe(true);
  });
});

describe("allFieldsValid", () => {
  const field = (valid: boolean) => ({ validity: { valid } });
  it("reads each field's own validity", () => {
    expect(allFieldsValid([])).toBe(true);
    expect(allFieldsValid([field(true), field(true)])).toBe(true);
    expect(allFieldsValid([field(true), field(false)])).toBe(false);
  });
});

describe("googleBoxOpensOnSubmit", () => {
  it("opens when a required field is missing", () => {
    expect(googleBoxOpensOnSubmit({ shown: true, metadata: { postType: "update", button: { type: "BOOK", url: "" } } })).toBe(true);
    expect(
      googleBoxOpensOnSubmit({ shown: true, metadata: { postType: "event", event: { title: "", startDate: "", endDate: "" } } }),
    ).toBe(true);
  });

  it("stays as it is when everything is filled in, or when the box is not on the page", () => {
    expect(googleBoxOpensOnSubmit({ shown: true, metadata: { postType: "update", button: { type: "BOOK", url: "https://e.com" } } })).toBe(
      false,
    );
    expect(googleBoxOpensOnSubmit({ shown: true, metadata: { postType: "update" } })).toBe(false);
    expect(googleBoxOpensOnSubmit({ shown: false, metadata: { postType: "update", button: { type: "BOOK", url: "" } } })).toBe(false);
  });
});

describe("GooglePostBox", () => {
  it("collapsed by default: a one-line summary that opens it, the settings hidden", () => {
    const html = render({ postType: "update", button: { type: "BOOK", url: "https://e.com/book" } });
    expect(html).toMatch(/<button[^>]*aria-expanded="false"[^>]*>.*Google post: Update, button Book/);
    expect(html).toMatch(/<div[^>]*id="google-post-box-settings"[^>]*hidden=""/);
    expect(html).toContain('aria-controls="google-post-box-settings"');
  });

  it("open: the settings show", () => {
    const html = render({ postType: "update" }, true);
    expect(html).toContain('aria-expanded="true"');
    expect(html).not.toMatch(/id="google-post-box-settings"[^>]*hidden=""/);
  });

  it("an offer or an event opens it by itself", () => {
    for (const metadata of [offer, event]) {
      const html = render(metadata);
      expect(html).not.toMatch(/id="google-post-box-settings"[^>]*hidden=""/);
    }
  });

  // Fix round 1, item 4c: no disabled button left under the person's finger.
  it("held open: the summary is plain text with why, and there is no fold control", () => {
    for (const metadata of [offer, event]) {
      const html = render(metadata);
      expect(html).not.toContain("<button");
      expect(html).not.toContain("aria-expanded");
      expect(html).toContain("Open while it has an offer or event");
      expect(html).toContain(googlePostSummary(metadata));
    }
    for (const metadata of [book("http://e.com/book"), book("")]) {
      const html = render(metadata, true);
      expect(html).not.toContain("<button");
      expect(html).toContain("Open until the link is fixed");
    }
  });

  it("not held: a fold button, with no reason line", () => {
    const html = render(book("https://e.com/book"), true);
    expect(html).toMatch(/<button[^>]*aria-expanded="true"/);
    expect(html.match(/<button[^>]*>/)?.[0]).not.toContain("disabled");
    expect(html).not.toContain("Open while");
    expect(html).not.toContain("Open until");
  });

  it("Book with http:// is open, with its alert visible and a warning on the summary", () => {
    const html = render(book("http://e.com/book"));
    expect(html).not.toMatch(/id="google-post-box-settings"[^>]*hidden=""/);
    expect(html).toContain('role="alert"');
    expect(html).toContain("The button link must start with https://.");
    expect(html).toContain('data-google-box-warning=""');
  });

  it("a valid link folds as before, with no warning", () => {
    const html = render(book("https://e.com/book"));
    expect(html).toMatch(/id="google-post-box-settings"[^>]*hidden=""/);
    expect(html).not.toContain("data-google-box-warning");
  });

  it("an offer or an event is held open without a warning when its fields are fine", () => {
    expect(render(offer)).not.toContain("data-google-box-warning");
    expect(render(event)).not.toContain("data-google-box-warning");
  });

  it("the settings inside are today's, with the same values, open or closed", () => {
    for (const metadata of [book("https://e.com/book"), book("http://e.com/book"), book("www.mysite.com"), offer, event]) {
      const settings = renderToStaticMarkup(createElement(GooglePostSettings, { metadata, onChange: () => {} }));
      expect(render(metadata)).toContain(settings);
      expect(render(metadata, true)).toContain(settings);
    }
  });
});
