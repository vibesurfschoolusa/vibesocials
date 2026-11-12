import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { GOOGLE_BUTTON_LABELS, GOOGLE_BUTTON_TYPES } from "@/lib/googlePostOptions";
import type { GoogleBusinessPostMetadata } from "@/server/platforms/types";

import { GooglePostSettings } from "../google-post-settings";
import {
  GooglePostBox,
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

describe("googleBoxShowsOpen", () => {
  it("collapsed by default for an update, open once the person opens it", () => {
    expect(googleBoxShowsOpen({ open: false, postType: "update" })).toBe(false);
    expect(googleBoxShowsOpen({ open: true, postType: "update" })).toBe(true);
  });

  it("open by itself for an offer or an event", () => {
    expect(googleBoxShowsOpen({ open: false, postType: "offer" })).toBe(true);
    expect(googleBoxShowsOpen({ open: false, postType: "event" })).toBe(true);
  });
});

describe("googleBoxOpenAfterChange", () => {
  it("choosing Offer or Event leaves the box open, so switching back to Update mid-edit does not close it", () => {
    expect(googleBoxOpenAfterChange(false, "offer")).toBe(true);
    expect(googleBoxOpenAfterChange(false, "event")).toBe(true);
    expect(googleBoxOpenAfterChange(true, "update")).toBe(true);
    expect(googleBoxOpenAfterChange(false, "update")).toBe(false);
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
      expect(html).toContain('aria-expanded="true"');
      expect(html).not.toMatch(/id="google-post-box-settings"[^>]*hidden=""/);
    }
  });

  it("the settings inside are today's, with the same values, open or closed", () => {
    for (const metadata of [{ postType: "update" as const, button: { type: "BOOK" as const, url: "https://e.com/book" } }, offer, event]) {
      const settings = renderToStaticMarkup(createElement(GooglePostSettings, { metadata, onChange: () => {} }));
      expect(render(metadata)).toContain(settings);
      expect(render(metadata, true)).toContain(settings);
    }
  });
});
