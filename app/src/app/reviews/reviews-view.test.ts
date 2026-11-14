import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(path.join(__dirname, "reviews-view.tsx"), "utf8");
const at = (needle: string) => {
  const index = source.indexOf(needle);
  expect(index, needle).toBeGreaterThan(-1);
  return index;
};

// N2: people open Reviews to answer reviews, so the list comes first.
describe("ReviewsView layout", () => {
  it("orders heading, picker, tabs, list, then the Get more reviews panel", () => {
    const heading = at("<h1");
    const picker = at("<LocationPicker");
    const tabs = at('aria-label="Review filter"');
    const list = at("needsReplyReviews.map((review) => renderReviewCard(");
    const panel = at("<ReviewLinkPanel");
    expect(heading).toBeLessThan(picker);
    expect(picker).toBeLessThan(tabs);
    expect(tabs).toBeLessThan(list);
    expect(list).toBeLessThan(panel);
  });

  it("shows the picker only through the 2+ locations helper", () => {
    expect(source).toContain("showLocationPicker(locations) && (");
    expect(source).toContain("singleLocationName(locations)");
  });

  it("drops the separate count box; the subtitle carries it", () => {
    expect(source).not.toContain("Reviews needing reply");
    expect(source).toContain("reviewsSubtitle(");
  });

  it("has an empty Needs reply state that points to the panel below", () => {
    expect(source).toContain("Every review has a reply.");
    expect(source).toContain("Get more reviews below");
    expect(source).not.toContain("All caught up!");
  });

  it("announces a posted reply politely and moves focus on", () => {
    expect(source).toContain('role="status"');
    expect(source).toContain('"Reply posted"');
    expect(source).toContain("focusAfterReply(");
  });
});
