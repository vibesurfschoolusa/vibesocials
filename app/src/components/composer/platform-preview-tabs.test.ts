import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Platform } from "@prisma/client";
import { describe, expect, it } from "vitest";

import { composerPageView } from "../create-post-form";
import { PlatformPreviewList, shownPreviewPlatform } from "./platform-preview";

const ALL: Platform[] = [
  "tiktok",
  "youtube",
  "instagram",
  "x",
  "linkedin",
  "facebook_page",
  "google_business_profile",
  "pinterest",
];

const render = (platforms: Platform[], caption = "hello", mimeType: string | null = "image/jpeg") =>
  renderToStaticMarkup(
    createElement(PlatformPreviewList, {
      platforms,
      caption,
      mediaUrl: mimeType ? "blob:cover" : null,
      mediaMimeType: mimeType,
    }),
  );

const tabs = (html: string) => [...html.matchAll(/<button[^>]*role="tab"[^>]*>/g)].map((m) => m[0]);
const cards = (html: string) => html.match(/role="group"/g)?.length ?? 0;

describe("the preview shows one platform at a time, with tabs", () => {
  it("no platform selected: nothing, as today", () => {
    expect(render([])).toBe("");
  });

  it("one platform: its card and no tab row", () => {
    const html = render(["instagram"]);
    expect(html).not.toContain('role="tablist"');
    expect(cards(html)).toBe(1);
    expect(html).toContain("platform-preview-heading-instagram");
  });

  it("eight platforms: eight tabs in one scrolling row, one card, the first shown", () => {
    const html = render(ALL);
    expect(html).toContain('role="tablist"');
    const row = html.match(/<div[^>]*role="tablist"[^>]*>/)?.[0] ?? "";
    expect(row).toContain("overflow-x-auto");
    expect(row).not.toContain("flex-wrap");
    expect(tabs(html)).toHaveLength(8);
    expect(cards(html)).toBe(1);
    expect(html).toContain("platform-preview-heading-tiktok");
    expect(html).not.toContain("platform-preview-heading-youtube");
    // A proper tab list: the shown tab is selected and the only one in the tab order.
    const [first, ...rest] = tabs(html);
    expect(first).toContain('aria-selected="true"');
    expect(first).toContain('tabindex="0"');
    for (const tab of rest) {
      expect(tab).toContain('aria-selected="false"');
      expect(tab).toContain('tabindex="-1"');
    }
    expect(html).toContain('role="tabpanel"');
    expect(html).toContain('aria-labelledby="platform-preview-tab-tiktok"');
  });

  it("the card in the panel is today's card: media, caption and character count", () => {
    const html = render(["instagram", "x"]);
    expect(html).toContain('src="blob:cover"');
    expect(html).toContain(">hello</p>");
    expect(html).toContain("5 / 2200 characters");
  });

  it("a platform over its limit is marked on its tab while another is shown", () => {
    const html = render(["instagram", "x"], "a".repeat(300));
    const [instagram, x] = tabs(html);
    expect(instagram).toContain('aria-selected="true"');
    expect(instagram).not.toContain("over its limit");
    expect(x).toContain('aria-label="X, over its limit: the text will be shortened"');
    // The shown card keeps its own warning; X's is on its tab only.
    expect(html.match(/Will be shortened/g)).toBeNull();
    const xTab = html.match(/<button[^>]*id="platform-preview-tab-x"[^>]*>.*?<\/button>/)?.[0] ?? "";
    expect(xTab).toContain("<svg");
  });

  it("the shown card keeps its over-limit warning", () => {
    const html = render(["x", "instagram"], "a".repeat(300));
    expect(html).toContain("Will be shortened");
  });
});

describe("shownPreviewPlatform", () => {
  it("nothing chosen yet: the first selected platform", () => {
    expect(shownPreviewPlatform(["instagram", "x"], null)).toBe("instagram");
  });

  it("the chosen platform while it stays selected", () => {
    expect(shownPreviewPlatform(["instagram", "x", "linkedin"], "x")).toBe("x");
  });

  it("the shown platform deselected: the next one", () => {
    expect(shownPreviewPlatform(["instagram", "linkedin", "facebook_page"], "x")).toBe("linkedin");
  });

  it("the last one deselected: the one before it", () => {
    expect(shownPreviewPlatform(["instagram", "x"], "google_business_profile")).toBe("x");
  });

  it("nothing selected: none", () => {
    expect(shownPreviewPlatform([], "x")).toBeNull();
  });
});

describe("the tabs follow the page's own rules", () => {
  const view = (pageState: "untouched" | "text" | "file", mimeType: string | null) =>
    composerPageView({
      pageState,
      connected: ["instagram", "x", "linkedin", "facebook_page"],
      deselected: new Set(),
      mimeType,
      mode: "now",
      loading: false,
      triedSend: false,
    });

  it("untouched: a tab for every connected platform, as the previews were", () => {
    const html = render(view("untouched", null).selected, "", null);
    expect(tabs(html).map((tab) => tab.match(/id="platform-preview-tab-([a-z_]+)"/)?.[1])).toEqual([
      "instagram",
      "x",
      "linkedin",
      "facebook_page",
    ]);
  });

  it("text only: tabs only for the platforms that take text", () => {
    const html = render(view("text", null).selected, "hi", null);
    const ids = tabs(html).map((tab) => tab.match(/id="platform-preview-tab-([a-z_]+)"/)?.[1]);
    expect(ids).toEqual(["x", "linkedin", "facebook_page"]);
  });
});

// Fix round 1, item 4d: after a successful post the next post starts on the first tab.
describe("the chosen tab after a successful post", () => {
  it("a fresh list starts on the first selected platform", () => {
    const [first] = tabs(render(["instagram", "x", "linkedin"]));
    expect(first).toContain('id="platform-preview-tab-instagram"');
    expect(first).toContain('aria-selected="true"');
  });

  it("the form remounts the list after each saved post, so the chosen tab goes back to the first", () => {
    const form = readFileSync(path.join(__dirname, "..", "create-post-form.tsx"), "utf8");
    expect(form).toMatch(/<PlatformPreviewList\s+key=\{postsSaved\}/);
    // Counted in the success branch, beside the rest of the form's reset.
    const success = form.slice(form.indexOf("setShowSuccess(true);"), form.indexOf("} catch (err: unknown) {", form.indexOf("setShowSuccess(true);")));
    expect(success).toContain("setPostsSaved((count) => count + 1);");
  });
});
