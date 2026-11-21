import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Platform } from "@prisma/client";
import { describe, expect, it } from "vitest";

import type { CaptionFooterUser } from "@/lib/captionFooter";
import { platformCaptionCounter } from "@/lib/platformOverrides";
import { STORY_NO_CAPTION } from "@/lib/storyPlacement";

import { PlatformPreviewList } from "./platform-preview";

const render = (mediaCount?: number) =>
  renderToStaticMarkup(
    createElement(PlatformPreviewList, {
      platforms: ["instagram"],
      caption: "hello",
      mediaUrl: "blob:cover",
      mediaMimeType: "image/jpeg",
      mediaCount,
    }),
  );

describe("PlatformPreviewList photo count", () => {
  it("shows the first photo with no badge for one photo", () => {
    expect(render()).toContain('src="blob:cover"');
    expect(render()).not.toContain("photos");
    expect(render(1)).toBe(render());
  });

  it("shows a count badge for several photos", () => {
    const html = render(4);
    expect(html).toContain('src="blob:cover"');
    expect(html).toContain('aria-label="4 photos"');
    expect(html).toContain(">4</span>");
  });
});

// Go-live check F2 item 4: a long footer link ran past the card on a phone.
describe("PlatformPreviewList long text", () => {
  it("wraps the preview text anywhere, so a long link stays inside its card", () => {
    const link = "https://example.com/?utm_source=facebook&utm_medium=social&utm_campaign=vibesocials";
    for (const platform of ["instagram", "facebook_page", "x", "linkedin", "tiktok", "youtube", "google_business_profile"] as const) {
      const html = renderToStaticMarkup(
        createElement(PlatformPreviewList, { platforms: [platform], caption: link, mediaUrl: null, mediaMimeType: null }),
      );
      const text = html.match(/<p class="([^"]*)">[^<]*utm_campaign/)?.[1] ?? "";
      expect(text, platform).toContain("[overflow-wrap:anywhere]");
      // The card itself may shrink to its column instead of growing to the link.
      expect(html.match(/role="group"[^>]*class="([^"]*)"|class="([^"]*)"[^>]*role="group"/)?.slice(1).join(" "), platform).toContain(
        "min-w-0",
      );
    }
  });
});

// R48 publishing L3: a platform set to Story only publishes no caption, so its
// tab shows "Story, no caption" with no count and no over-limit mark.
describe("PlatformPreviewList with a Story-only platform", () => {
  const long = "a".repeat(2_300);
  const renderWith = (storyOnly: Platform[], platforms: Platform[] = ["instagram"]) =>
    renderToStaticMarkup(
      createElement(PlatformPreviewList, {
        platforms,
        caption: long,
        mediaUrl: "blob:cover",
        mediaMimeType: "image/jpeg",
        storyOnly,
      }),
    );

  it("Instagram Story only: Story, no caption, with no count and no over-limit mark", () => {
    const html = renderWith(["instagram"]);
    expect(html).toContain(STORY_NO_CAPTION);
    expect(html).not.toContain("characters");
    expect(html).not.toContain("Will be shortened");
    expect(html).not.toContain(long);
  });

  it("the Story-only tab carries no over-limit mark; the other tabs keep theirs", () => {
    const html = renderWith(["instagram"], ["instagram", "x"]);
    expect(html).not.toContain("Instagram, over its limit");
    expect(html).toContain("X, over its limit");
  });

  it("Feed and Story (not Story only) and Story switched off: the caption and its count", () => {
    const html = renderWith([]);
    expect(html).not.toContain(STORY_NO_CAPTION);
    expect(html).toContain("/ 2200 characters");
    expect(html).toContain("Will be shortened");
  });
});

// R52 platform-clients L1 follow-up: YouTube's card reads the same number,
// limit and hint as its caption counter; every other card's count line is
// exactly as on main f796e2e.
describe("PlatformPreviewList count line", () => {
  const user = { companyWebsite: "vibesurfschool.com", defaultHashtags: "#surf #waves", trackWebsiteLinks: true };
  const short = "Dawn patrol at Las Olas \u{1F30A} <3 café ".repeat(4).trim();
  const long = "Glassy waves é ".repeat(250);
  const card = (platform: Platform, caption: string, footer: CaptionFooterUser | null = user) =>
    renderToStaticMarkup(
      createElement(PlatformPreviewList, { platforms: [platform], caption, user: footer, mediaUrl: null, mediaMimeType: null }),
    );
  const line = (text: string) => `<p class="text-xs text-muted-foreground">${text}</p>`;
  // The first such line is the list's own intro sentence.
  const countLines = (markup: string) =>
    (markup.match(/<p class="text-xs text-muted-foreground">[^<]*<\/p>/g) ?? []).slice(1);

  it.each([
    ["x", "198 / 280 characters", "3749 / 280 characters"],
    ["instagram", "189 / 2200 characters", "3749 / 2200 characters"],
    ["linkedin", "253 / 3000 characters", "3749 / 3000 characters"],
    ["facebook_page", "253 characters", "3867 characters"],
    ["google_business_profile", "251 / 1500 characters", "3749 / 1500 characters"],
  ] as const)("%s: unchanged", (platform, shortLine, longLine) => {
    expect(countLines(card(platform, short))).toEqual([line(shortLine)]);
    expect(countLines(card(platform, long))).toEqual([line(longLine)]);
  });

  it.each([
    [`${"Waves \u{1F30A}".repeat(500)}!`, null],
    [short, user],
    [long, user],
    ["a".repeat(4812), null],
    ["I <3 waves", null],
  ] as const)("youtube: the counter's number, limit and hint (%#)", (caption, footer) => {
    const counter = platformCaptionCounter(caption, "youtube", footer);
    const expected = [line(counter.label)];
    if (counter.hint) expected.push(line(counter.hint.replace(/</g, "&lt;").replace(/>/g, "&gt;")));
    expect(countLines(card("youtube", caption, footer))).toEqual(expected);
    expect(counter.max).toBe(5000);
  });

  it("youtube: an emoji-heavy post reads 5,001 / 5,000 with the hint beneath", () => {
    expect(countLines(card("youtube", `${"Waves \u{1F30A}".repeat(500)}!`, null))).toEqual([
      line("5,001 / 5,000"),
      line("YouTube counts accented letters, curly quotes and emoji as 2 or more."),
    ]);
  });
});

// R52 fix review L2: the card's YouTube line agrees with the counter on
// "incl. footer", over the limit too.
describe("PlatformPreviewList YouTube count line: incl. footer", () => {
  const footer = { companyWebsite: "vibesurfschool.com", defaultHashtags: "#surf" };
  const youtubeLine = (caption: string, user: CaptionFooterUser | null) =>
    (renderToStaticMarkup(
      createElement(PlatformPreviewList, { platforms: ["youtube"], caption, user, mediaUrl: null, mediaMimeType: null }),
    ).match(/<p class="text-xs text-muted-foreground">[^<]*<\/p>/g) ?? [])[1];

  it.each([
    ["under, with a footer", "hello", footer],
    ["over, with a footer", "a".repeat(5500), footer],
    ["under, no footer", "hello", null],
    ["over, no footer", "a".repeat(5500), null],
  ] as const)("%s: the counter's label", (_case, caption, user) => {
    const label = platformCaptionCounter(caption, "youtube", user).label;
    expect(youtubeLine(caption, user)).toBe(`<p class="text-xs text-muted-foreground">${label}</p>`);
    expect(label.endsWith(" incl. footer")).toBe(user !== null);
  });
});

// R53 platform-clients L1 follow-up: Pinterest's card shows exactly what its
// counter shows (the same number, limit and hint), from the one helper.
describe("PlatformPreviewList Pinterest count line", () => {
  const footer = { companyWebsite: "vibesurfschool.com", defaultHashtags: "#surf" };
  const lines = (caption: string, user: CaptionFooterUser | null = null) =>
    (
      renderToStaticMarkup(
        createElement(PlatformPreviewList, { platforms: ["pinterest"], caption, user, mediaUrl: null, mediaMimeType: null }),
      ).match(/<p class="text-xs text-muted-foreground">[^<]*<\/p>/g) ?? []
    ).slice(1);
  const line = (text: string) => `<p class="text-xs text-muted-foreground">${text}</p>`;

  it("760 characters with 50 hearts: 810 / 800 and the counter's hint", () => {
    const caption = `${"a".repeat(710)}${"❤️".repeat(50)}`;
    expect(lines(caption)).toEqual([
      line("810 / 800"),
      line("Pinterest counts some characters, such as emoji, as 2 or more."),
    ]);
  });

  it.each([
    ["ASCII", "a".repeat(790), null],
    ["ASCII over", "a".repeat(1200), null],
    ["with a footer", "Love ❤️", footer],
    ["footer dropped", "❤️".repeat(390), footer],
    ["a family", "\u{1F468}‍\u{1F469}‍\u{1F467} ".repeat(150), footer],
  ] as const)("%s: the counter's label and hint, line for line", (_case, caption, user) => {
    const counter = platformCaptionCounter(caption, "pinterest", user);
    const expected = [line(counter.label)];
    if (counter.hint) expected.push(line(counter.hint));
    expect(lines(caption, user)).toEqual(expected);
  });

  it("ASCII reads 790 / 800 with no hint", () => {
    expect(lines("a".repeat(790))).toEqual([line("790 / 800")]);
  });
});

// R53 follow-up: every other platform's card line, pinned from main 632efda.
describe("PlatformPreviewList count line on the other platforms, unchanged by Pinterest's", () => {
  const user = { companyWebsite: "vibesurfschool.com", defaultHashtags: "#surf #waves", trackWebsiteLinks: true };
  const short = "Dawn patrol at Las Olas \u{1F30A} <3 café ".repeat(4).trim();
  const long = "Glassy waves é ".repeat(250);
  const lines = (platform: Platform, caption: string) =>
    (
      renderToStaticMarkup(
        createElement(PlatformPreviewList, { platforms: [platform], caption, user, mediaUrl: null, mediaMimeType: null }),
      ).match(/<p class="text-xs text-muted-foreground">[^<]*<\/p>/g) ?? []
    ).slice(1);
  const line = (text: string) => `<p class="text-xs text-muted-foreground">${text}</p>`;

  it.each([
    ["x", ["198 / 280 characters"], ["3749 / 280 characters"]],
    ["tiktok", ["189 / 2200 characters"], ["3749 / 2200 characters"]],
    ["instagram", ["189 / 2200 characters"], ["3749 / 2200 characters"]],
    ["linkedin", ["253 / 3000 characters"], ["3749 / 3000 characters"]],
    ["facebook_page", ["253 characters"], ["3867 characters"]],
    ["google_business_profile", ["251 / 1500 characters"], ["3749 / 1500 characters"]],
    [
      "youtube",
      ["276 / 5,000 incl. footer", "YouTube counts accented letters, curly quotes, emoji, &lt; and &gt; as 2 or more."],
      ["4,116 / 5,000 incl. footer", "YouTube counts accented letters, curly quotes and emoji as 2 or more."],
    ],
  ] as const)("%s", (platform, shortLines, longLines) => {
    expect(lines(platform, short)).toEqual(shortLines.map(line));
    expect(lines(platform, long)).toEqual(longLines.map(line));
  });
});

// R57 publishing-flow-2 L2: the preview shows the ticked platforms only.
describe("PlatformPreviewList heading", () => {
  it("says each platform the post goes to, not each connected one", () => {
    const html = render();
    expect(html).toContain("How this post will look on each platform it goes to.");
    expect(html).not.toContain("connected platform");
  });
});
