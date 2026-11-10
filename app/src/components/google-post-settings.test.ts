import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { GoogleBusinessPostMetadata } from "@/server/platforms/types";

import { GooglePostSettings } from "./google-post-settings";

const render = (metadata: GoogleBusinessPostMetadata) =>
  renderToStaticMarkup(createElement(GooglePostSettings, { metadata, onChange: () => {} }));

describe("GooglePostSettings", () => {
  it("an update shows the type and the button, with every button type and No button", () => {
    const html = render({ postType: "update", button: { type: "BOOK", url: "https://e.com/book" } });

    expect(html).toContain("Google post settings");
    expect(html).toContain('id="google-post-type"');
    expect(html).toContain('id="google-button-type"');
    for (const label of ["No button", "Book", "Order online", "Buy", "Learn more", "Sign up", "Call now"]) {
      expect(html).toContain(`>${label}</option>`);
    }
    expect(html).toContain('id="google-button-url"');
    expect(html).toContain('value="https://e.com/book"');
    // Fields of the other types are not shown.
    expect(html).not.toContain('id="google-event-title"');
    expect(html).not.toContain('id="google-offer-title"');
  });

  it("a Call button needs no link, so the link field is hidden", () => {
    const html = render({ postType: "update", button: { type: "CALL" } });

    expect(html).not.toContain('id="google-button-url"');
  });

  it("no button: no link field", () => {
    expect(render({ postType: "update" })).not.toContain('id="google-button-url"');
  });

  it("an event shows its fields and says an event without times lasts all day", () => {
    const html = render({
      postType: "event",
      event: { title: "Full moon paddle", startDate: "2026-11-20", endDate: "2026-11-20" },
    });

    for (const id of ["google-event-title", "google-event-start-date", "google-event-end-date", "google-event-start-time", "google-event-end-time"]) {
      expect(html).toContain(`id="${id}"`);
    }
    expect(html).toContain("An event without a start and end time lasts all day.");
    expect(html).toContain('id="google-button-type"');
  });

  it("an offer shows its fields and no button", () => {
    const html = render({
      postType: "offer",
      offer: { title: "20% off", startDate: "2026-11-20", endDate: "2026-11-30" },
    });

    for (const id of ["google-offer-title", "google-offer-start-date", "google-offer-end-date", "google-offer-coupon", "google-offer-redeem-url", "google-offer-terms"]) {
      expect(html).toContain(`id="${id}"`);
    }
    expect(html).not.toContain('id="google-button-type"');
    expect(html).toContain("An offer can&#x27;t have a button");
  });

  it("shows the validator's message for a value Google would refuse", () => {
    const html = render({
      postType: "event",
      event: { title: "Paddle", startDate: "2026-11-20", endDate: "2026-11-19" },
    });

    expect(html).toContain("The event end date can&#x27;t be before its start date.");
  });

  it("shows no message when the options are valid", () => {
    const html = render({ postType: "update" });

    expect(html).not.toContain('role="alert"');
  });
});
