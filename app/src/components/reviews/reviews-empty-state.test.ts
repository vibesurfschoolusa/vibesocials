import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ReviewsEmptyState } from "./reviews-empty-state";

const render = (locationsCount: number, gbpConnected: boolean, isMember: boolean) =>
  renderToStaticMarkup(createElement(ReviewsEmptyState, { locationsCount, gbpConnected, isMember })).replace(
    /&#x27;/g,
    "'",
  );

// R12 L1: Reviews before a location is selected, for an owner and for a member.
describe("ReviewsEmptyState", () => {
  it("owner, nothing connected: the connect step and the button, as before", () => {
    const html = render(0, false, false);
    expect(html).toContain("Connect Google Business Profile");
    expect(html).toContain("Connect it in Settings to see and reply to reviews here.");
    expect(html).toContain('href="/settings#connections"');
    expect(html).toContain("Go to connections");
  });

  it("member, nothing connected: who can connect it, no button", () => {
    const html = render(0, false, true);
    expect(html).toContain("Google Business Profile is not connected");
    expect(html).toContain(
      "Reviews come from this workspace's Google Business Profile listing. The workspace owner can connect Google Business Profile.",
    );
    expect(html).not.toContain("<a");
  });

  it("owner, connected with no locations: add one in Google, as before", () => {
    expect(render(0, true, false)).toContain(
      "Your connected Google Business Profile doesn't have any locations yet. Add one in Google Business Profile, then refresh this page.",
    );
  });

  it("member, connected with no locations: who can add one", () => {
    const html = render(0, true, true);
    expect(html).toContain("No locations found");
    expect(html).toContain(
      "The connected Google Business Profile doesn't have any locations yet. The workspace owner can add one in Google Business Profile.",
    );
  });

  it("locations listed: choose one above, for everyone", () => {
    for (const isMember of [false, true]) {
      const html = render(2, true, isMember);
      expect(html).toContain("Select a location");
      expect(html).toContain("Choose a location above to view and reply to reviews");
    }
  });
});
