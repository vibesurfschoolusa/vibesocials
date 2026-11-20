import { readFileSync } from "node:fs";

import type { Platform } from "@prisma/client";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ToastProvider } from "@/components/ui/toast";
import type { CaptionFooterUser } from "@/lib/captionFooter";
import { platformCaptionCounter } from "@/lib/platformOverrides";

import { PlatformCaptionEditor } from "./platform-caption-editor";

// R26 LL3 item 5: the "Adapt for X" button that is working keeps keyboard
// focus (Button's loading ignores the press); the others wait, disabled.
describe("Adapt for X while busy", () => {
  const source = readFileSync(new URL("./platform-caption-editor.tsx", import.meta.url), "utf8");
  it("the busy button is loading, not disabled", () => {
    expect(source).toContain("loading={adapting === platform}");
    expect(source).toContain("disabled={disabled || (adapting !== null && adapting !== platform)}");
  });
});

// R31 (lead follow-up): Adapt sends the workspace the page was drawn for, and
// both pages that show the editor pass it.
describe("PlatformCaptionEditor: the page's workspace id", () => {
  it("Adapt's body carries workspaceId, and Create and the Queue pass it", () => {
    const editor = readFileSync(new URL("./platform-caption-editor.tsx", import.meta.url), "utf8");
    expect(editor).toMatch(/workspaceId: string \| null;/);
    expect(editor).toMatch(/\.\.\.\(workspaceId \? \{ workspaceId \} : \{\}\)/);
    for (const page of ["../create-post-form.tsx", "../../app/queue/queue-view.tsx"]) {
      const source = readFileSync(new URL(page, import.meta.url), "utf8");
      const at = source.indexOf("<PlatformCaptionEditor");
      expect(source.slice(at, source.indexOf("/>", at)), page).toMatch(/workspaceId=\{workspaceId\}/);
    }
  });
});

// R52 platform-clients L1 follow-up: YouTube's hint has its own line under the
// count, so "(too long)" stays next to the number; every other platform's
// counter line is exactly as on main f796e2e.
describe("PlatformCaptionEditor: the count line", () => {
  const user = { companyWebsite: "vibesurfschool.com", defaultHashtags: "#surf #waves", trackWebsiteLinks: true };
  const short = "Dawn patrol at Las Olas \u{1F30A} <3 café ".repeat(4).trim();
  const long = "Glassy waves é ".repeat(250);
  const html = (platform: Platform, text: string, footer: CaptionFooterUser | null = user) =>
    renderToStaticMarkup(
      createElement(
        ToastProvider,
        null,
        createElement(PlatformCaptionEditor, {
          idPrefix: "t",
          platforms: [platform],
          caption: "main",
          overrides: { [platform]: text },
          onChange: () => {},
          workspaceId: "ws",
          footer,
        }),
      ),
    );
  const countLine = (markup: string, platform: Platform) =>
    markup.match(new RegExp(`<p id="t-${platform}-count"[^>]*>.*?</p>`))?.[0];
  const muted = (platform: Platform, text: string) =>
    `<p id="t-${platform}-count" class="ml-auto text-xs tabular-nums text-muted-foreground">${text}</p>`;
  const red = (platform: Platform, text: string) =>
    `<p id="t-${platform}-count" class="ml-auto text-xs tabular-nums text-destructive">${text} (too long)</p>`;

  it.each([
    ["x", muted("x", "198 / 280 incl. footer"), red("x", "3,749 / 280")],
    ["instagram", muted("instagram", "189 / 2,200 incl. footer"), red("instagram", "3,749 / 2,200")],
    ["linkedin", muted("linkedin", "253 / 3,000 incl. footer"), red("linkedin", "3,749 / 3,000")],
    ["facebook_page", muted("facebook_page", "139 / 10,000"), muted("facebook_page", "3,750 / 10,000")],
    [
      "google_business_profile",
      muted("google_business_profile", "251 / 1,500 incl. footer"),
      red("google_business_profile", "3,749 / 1,500"),
    ],
  ] as const)("%s: unchanged, with no hint line", (platform, shortLine, longLine) => {
    for (const [text, line] of [[short, shortLine], [long, longLine]] as const) {
      const markup = html(platform, text);
      expect(countLine(markup, platform)).toBe(line);
      expect(markup).not.toContain(`t-${platform}-count-hint`);
      expect(markup).toContain(`aria-describedby="t-${platform}-count"`);
    }
  });

  it("youtube: (too long) next to the number, the hint on its own line, both describing the box", () => {
    const text = `${"Waves \u{1F30A}".repeat(500)}!`;
    const counter = platformCaptionCounter(text, "youtube", null);
    const markup = html("youtube", text, null);
    expect(countLine(markup, "youtube")).toBe(red("youtube", "5,001 / 5,000"));
    expect(markup).toContain(
      `<p id="t-youtube-count-hint" class="text-xs text-muted-foreground">${counter.hint}</p>`,
    );
    expect(counter.hint).toBe("YouTube counts some characters as more than one: accented letters and curly quotes as 2 or 3, emoji as 3 or more");
    expect(markup).toContain('aria-describedby="t-youtube-count t-youtube-count-hint"');
  });

  it("youtube: plain ASCII shows the count alone, as before", () => {
    const markup = html("youtube", "a".repeat(4812), null);
    expect(countLine(markup, "youtube")).toBe(muted("youtube", "4,812 / 5,000"));
    expect(markup).not.toContain("t-youtube-count-hint");
  });
});
