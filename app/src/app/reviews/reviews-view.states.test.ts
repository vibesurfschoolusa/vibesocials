import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/components/ui/toast", () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn() }) }));
vi.mock("@/components/ui/dialog", () => ({ ConfirmDialog: () => null }));
vi.mock("./review-link-panel", () => ({ ReviewLinkPanel: () => null }));

import { ReviewsLoadFailedPage, ReviewsLoadingList, ReviewsView } from "./reviews-view";

const source = readFileSync(path.join(__dirname, "reviews-view.tsx"), "utf8");
const H1 = /<h1[^>]*>Google Reviews<\/h1>/;
const STATUS = /<p role="status" class="sr-only">Loading reviews…<\/p>/;

// R13-pages L1: the page is named in every state, and loading is announced.
describe("ReviewsView states", () => {
  it("loading (the first render): the h1 and a hidden Loading reviews status", () => {
    const html = renderToStaticMarkup(createElement(ReviewsView, { savedLocation: null, isMember: false, workspaceId: "ws-1" }));
    expect(html).toMatch(H1);
    expect(html).toMatch(STATUS);
  });

  it("the reviews list loading: the same status", () => {
    expect(renderToStaticMarkup(createElement(ReviewsLoadingList))).toMatch(STATUS);
    expect(source.split("<ReviewsLoadingList />").length - 1).toBe(2);
  });

  it("a failed locations load: the h1 above the error", () => {
    const html = renderToStaticMarkup(
      createElement(ReviewsLoadFailedPage, {
        error: { message: "Google asked to reconnect.", settingsLink: false },
        isMember: true,
        onRetry: () => {},
        workspaceId: "ws-1",
      }),
    );
    expect(html).toMatch(H1);
    expect(html.indexOf("<h1")).toBeLessThan(html.indexOf("Couldn&#x27;t load reviews"));
    expect(html).toContain("Google asked to reconnect.");
    expect(source).toContain("<ReviewsLoadFailedPage");
  });
});
