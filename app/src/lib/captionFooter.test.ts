import { describe, expect, it } from "vitest";

import { buildCaptionWithFooter } from "./captionFooter";
import { buildPlatformPreview } from "./platformPreview";
import { computeTikTokCaption } from "@/server/platforms/tiktokClient";

describe("buildCaptionWithFooter", () => {
  it("returns the trimmed base caption alone when no footer fields are set", () => {
    expect(buildCaptionWithFooter("Just the caption", {})).toBe("Just the caption");
  });

  it("returns base alone when footer fields are explicitly null", () => {
    expect(
      buildCaptionWithFooter("Hello world", {
        companyWebsite: null,
        defaultHashtags: null,
      }),
    ).toBe("Hello world");
  });

  it("appends the website line after a blank line", () => {
    expect(
      buildCaptionWithFooter("Check us out", { companyWebsite: "example.com" }),
    ).toBe("Check us out\n\nFor more info visit example.com");
  });

  it("appends hashtags after a blank line", () => {
    expect(
      buildCaptionWithFooter("New drop", { defaultHashtags: "#new #drop" }),
    ).toBe("New drop\n\n#new #drop");
  });

  it("appends website then hashtags in order, each separated by a blank line", () => {
    expect(
      buildCaptionWithFooter("Big news", {
        companyWebsite: "example.com",
        defaultHashtags: "#news #update",
      }),
    ).toBe("Big news\n\nFor more info visit example.com\n\n#news #update");
  });

  it("trims whitespace from the base caption", () => {
    expect(buildCaptionWithFooter("   padded   ", {})).toBe("padded");
  });

  it("trims each footer field before including it", () => {
    expect(
      buildCaptionWithFooter("Base", {
        companyWebsite: "  example.com  ",
        defaultHashtags: "  #tag  ",
      }),
    ).toBe("Base\n\nFor more info visit example.com\n\n#tag");
  });

  it("omits footer segments whose value is only whitespace", () => {
    expect(
      buildCaptionWithFooter("Base", {
        companyWebsite: "   ",
        defaultHashtags: "\t\n",
      }),
    ).toBe("Base");
  });

  it("collapses an empty base caption to an empty string", () => {
    expect(buildCaptionWithFooter("", {})).toBe("");
  });

  it("collapses a whitespace-only base caption to an empty string", () => {
    expect(buildCaptionWithFooter("   ", {})).toBe("");
  });

  it("still emits the leading blank-line separator when base is empty but footer is present", () => {
    expect(
      buildCaptionWithFooter("", { companyWebsite: "example.com" }),
    ).toBe("\n\nFor more info visit example.com");
  });

  it("never throws when footer fields are undefined", () => {
    expect(() =>
      buildCaptionWithFooter("Safe", {
        companyWebsite: undefined,
        defaultHashtags: undefined,
      }),
    ).not.toThrow();
    expect(
      buildCaptionWithFooter("Safe", {
        companyWebsite: undefined,
        defaultHashtags: undefined,
      }),
    ).toBe("Safe");
  });

  it("handles a mix of null and undefined footer fields without throwing", () => {
    expect(
      buildCaptionWithFooter("Mixed", {
        companyWebsite: null,
        defaultHashtags: undefined,
      }),
    ).toBe("Mixed");
  });
});

// 20: tracking tags on the website link, per platform, opt-in.
describe("buildCaptionWithFooter with a platform", () => {
  const PLATFORMS = [
    "facebook_page",
    "linkedin",
    "x",
    "youtube",
    "pinterest",
    "google_business_profile",
    "instagram",
    "tiktok",
  ] as const;
  const off = { companyWebsite: "vibesurfschool.com", defaultHashtags: "#surf" };
  const on = { ...off, trackWebsiteLinks: true };
  const today = "Waves\n\nFor more info visit vibesurfschool.com\n\n#surf";

  it.each(PLATFORMS)("with the setting off equals today on %s", (platform) => {
    expect(buildCaptionWithFooter("Waves", off, platform)).toBe(today);
    expect(buildCaptionWithFooter("Waves", { ...off, trackWebsiteLinks: false }, platform)).toBe(today);
    expect(buildCaptionWithFooter("Waves", { ...off, trackWebsiteLinks: null }, platform)).toBe(today);
  });

  it("with no platform passed equals today, even with the setting on", () => {
    expect(buildCaptionWithFooter("Waves", on)).toBe(today);
  });

  it.each([
    ["facebook_page", "facebook"],
    ["linkedin", "linkedin"],
    ["x", "x"],
    ["youtube", "youtube"],
    ["pinterest", "pinterest"],
    ["google_business_profile", "google"],
  ] as const)("with the setting on tags the link on %s", (platform, source) => {
    expect(buildCaptionWithFooter("Waves", on, platform)).toBe(
      `Waves\n\nFor more info visit vibesurfschool.com/?utm_source=${source}&utm_medium=social&utm_campaign=vibesocials\n\n#surf`,
    );
  });

  it.each(["instagram", "tiktok"] as const)("with the setting on leaves %s untagged", (platform) => {
    expect(buildCaptionWithFooter("Waves", on, platform)).toBe(today);
  });

  it("with the setting on and no website adds nothing", () => {
    expect(buildCaptionWithFooter("Waves", { trackWebsiteLinks: true }, "x")).toBe("Waves");
  });
});

// 20, fix round 1: the tags never cost the post its text. On a platform with a
// length limit the tagged link is used only when the whole text fits it.
describe("buildCaptionWithFooter tracking tags only when they fit", () => {
  const on = { companyWebsite: "vibesurfschool.com", defaultHashtags: "#surf", trackWebsiteLinks: true };
  const plain = (caption: string) => `${caption}\n\nFor more info visit vibesurfschool.com\n\n#surf`;
  const tagged = (caption: string, source: string) =>
    `${caption}\n\nFor more info visit vibesurfschool.com/?utm_source=${source}&utm_medium=social&utm_campaign=vibesocials\n\n#surf`;

  it.each([
    ["linkedin", "linkedin", 3000],
    ["pinterest", "pinterest", 800],
    ["google_business_profile", "google", 1500],
  ] as const)("on %s: tagged up to the limit, plain one character over", (platform, source, limit) => {
    const room = limit - tagged("", source).length;
    expect(buildCaptionWithFooter("a".repeat(room - 1), on, platform)).toBe(tagged("a".repeat(room - 1), source));
    expect(buildCaptionWithFooter("a".repeat(room), on, platform)).toBe(tagged("a".repeat(room), source));
    expect(buildCaptionWithFooter("a".repeat(room + 1), on, platform)).toBe(plain("a".repeat(room + 1)));
  });

  it("on X counts the tagged link as 23, as X does, so it costs no more than the plain one", () => {
    // "For more info visit " (20) + link (23) + "#surf" (5) + two blank lines (4).
    const room = 280 - 52;
    expect(buildCaptionWithFooter("a".repeat(room), on, "x")).toBe(tagged("a".repeat(room), "x"));
    // One over: the hashtags go; the tagged link stays, as it costs no more.
    expect(buildCaptionWithFooter("a".repeat(room + 1), on, "x")).toBe(
      tagged("a".repeat(room + 1), "x").replace("\n\n#surf", ""),
    );
  });

  it("on X counts the text without @-mentions, as the X client does", () => {
    // R59: a mentions-only line goes whole; in running text only the "@" would go.
    const caption = `${"a".repeat(280 - 52)}\n\n@ana_surf`;
    expect(buildCaptionWithFooter(caption, on, "x")).toBe(tagged(caption, "x"));
  });

  it("counts code points, so an emoji caption never gets the tags into a cut", () => {
    // The surfer emoji below is one grapheme but four code points; Pinterest
    // cuts on code points too (fitPinterestDescription).
    // As graphemes the tagged text would fit; as code points only the plain one does.
    const surfer = "\u{1F3C4}\u200D\u2642\uFE0F";
    const caption = surfer.repeat(Math.floor((800 - plain("").length) / 4));
    expect(Array.from(new Intl.Segmenter().segment(tagged(caption, "pinterest"))).length).toBeLessThan(800);
    expect(buildCaptionWithFooter(caption, on, "pinterest")).toBe(plain(caption));
  });

  it("always tags on a platform without a limit", () => {
    const caption = "a".repeat(20_000);
    expect(buildCaptionWithFooter(caption, on, "facebook_page")).toBe(tagged(caption, "facebook"));
  });
});

// Fix round 1 (M5, M6): on X and LinkedIn a text over the limit loses its footer
// parts whole, hashtags first, then the website line, before the caption is cut.
describe("buildCaptionWithFooter drops the footer before the caption is cut", () => {
  const footer = { companyWebsite: "vibesurfschool.com", defaultHashtags: "#surf #miami" };
  const website = "For more info visit vibesurfschool.com";
  // On X: website line 20 + 23 = 43, hashtags 11, each after a blank line (2).

  it("on X keeps the whole footer when it fits: 200 plain characters", () => {
    const caption = "a".repeat(200);
    expect(buildCaptionWithFooter(caption, footer, "x")).toBe(`${caption}\n\n${website}\n\n#surf #miami`);
  });

  it("on X drops the hashtags first", () => {
    const caption = "a".repeat(230); // 230 + 45 + 13 = 288; without hashtags 275
    expect(buildCaptionWithFooter(caption, footer, "x")).toBe(`${caption}\n\n${website}`);
  });

  it("on X then drops the website line", () => {
    const caption = "a".repeat(240); // 240 + 45 = 285
    expect(buildCaptionWithFooter(caption, footer, "x")).toBe(caption);
  });

  it("on X weighs emoji as 2 when deciding", () => {
    const caption = "\u{1F30A}".repeat(115); // 230 by weight, 115 characters
    expect(buildCaptionWithFooter(caption, footer, "x")).toBe(`${caption}\n\n${website}`);
  });

  it("on X counts without @-mentions", () => {
    // 220 + 45 + 13 = 278 once the mentions-only line is gone (R59).
    const caption = `${"a".repeat(220)}\n\n@ana_surf`;
    expect(buildCaptionWithFooter(caption, footer, "x")).toBe(`${caption}\n\n${website}\n\n#surf #miami`);
  });

  it("on LinkedIn drops the footer from a 3,100-character post", () => {
    const caption = "a".repeat(3100);
    expect(buildCaptionWithFooter(caption, footer, "linkedin")).toBe(caption);
  });

  it("on LinkedIn keeps the footer under the limit", () => {
    const caption = "a".repeat(2900);
    expect(buildCaptionWithFooter(caption, footer, "linkedin")).toBe(`${caption}\n\n${website}\n\n#surf #miami`);
  });

  // R5-publishing L2: Instagram, Business Profile, TikTok and Pinterest cut the
  // whole text at their limit, so a long caption lost the end of its footer: a
  // half link, a half hashtag. Every platform with a limit now drops footer parts
  // whole first. Website line 38 + hashtags 12, each after a blank line (2).
  describe.each([
    ["instagram", 2200],
    ["tiktok", 2200],
    ["google_business_profile", 1500],
    ["pinterest", 800],
  ] as const)("on %s (limit %i)", (platform, limit) => {
    it("keeps the whole footer when it fits", () => {
      const caption = "a".repeat(limit - 54);
      expect(buildCaptionWithFooter(caption, footer, platform)).toBe(`${caption}\n\n${website}\n\n#surf #miami`);
    });

    it("drops the hashtags first", () => {
      const caption = "a".repeat(limit - 53);
      expect(buildCaptionWithFooter(caption, footer, platform)).toBe(`${caption}\n\n${website}`);
    });

    it("then drops the website line, never cutting inside the link", () => {
      const caption = "a".repeat(limit - 39);
      expect(buildCaptionWithFooter(caption, footer, platform)).toBe(caption);
      expect(buildCaptionWithFooter("a".repeat(limit + 100), footer, platform)).toBe("a".repeat(limit + 100));
    });

    it("counts an emoji by its code points, so the client never cuts into the footer", () => {
      const surfer = String.fromCodePoint(0x1f3c4, 0x200d, 0x2642, 0xfe0f); // one grapheme, four code points
      const caption = surfer.repeat(Math.floor((limit - 54) / 4) + 1);
      expect(buildCaptionWithFooter(caption, footer, platform)).toBe(`${caption}\n\n${website}`);
    });
  });

  it("leaves a platform without a limit untouched", () => {
    const caption = "a".repeat(20_000);
    expect(buildCaptionWithFooter(caption, footer, "facebook_page")).toBe(`${caption}\n\n${website}\n\n#surf #miami`);
    expect(buildCaptionWithFooter(caption, footer, "youtube")).toBe(`${caption}\n\n${website}\n\n#surf #miami`);
  });
});

// R65: TikTok counts UTF-16 units, so its footer rule counts them too. Text that
// keeps its footer is then never cut by the client, so "For more info visit" is
// never left without its link.
describe("buildCaptionWithFooter on TikTok counts UTF-16 units", () => {
  const tracked = { companyWebsite: "vibesurfschool.com", defaultHashtags: "#surf #miami", trackWebsiteLinks: true };
  const plain = { companyWebsite: "vibesurfschool.com", defaultHashtags: "#surf #miami" };
  const website = "For more info visit vibesurfschool.com";
  const wave = "\u{1F30A}";

  it("an emoji-heavy caption near 2,200 units: no website line without its link, and the preview equals what is sent", () => {
    // 1,060 to 1,099 waves: the footer fits by code points but not by units.
    for (let count = 1060; count < 1100; count += 1) {
      const caption = `${wave} `.repeat(count / 2) + wave.repeat(count % 2);
      for (const footer of [plain, tracked]) {
        const full = buildCaptionWithFooter(caption, footer, "tiktok");
        const sent = computeTikTokCaption(full);
        expect(sent).toBe(full);
        expect(sent).not.toMatch(/For more info visit\s*$/);
        if (sent.includes("For more info visit")) expect(sent).toMatch(/For more info visit \S*vibesurfschool\.com/);
        expect(buildPlatformPreview({ platform: "tiktok", caption, user: footer }).rendered).toBe(sent);
      }
    }
  });

  it("the footer is dropped whole when only code points would let it fit", () => {
    const caption = wave.repeat(1075); // 1,075 code points, 2,150 units
    expect(buildCaptionWithFooter(caption, plain, "tiktok")).toBe(caption);
  });

  it("plain ASCII with the footer: as before", () => {
    expect(buildCaptionWithFooter("a".repeat(2146), plain, "tiktok")).toBe(`${"a".repeat(2146)}\n\n${website}\n\n#surf #miami`);
    expect(buildCaptionWithFooter("a".repeat(2147), plain, "tiktok")).toBe(`${"a".repeat(2147)}\n\n${website}`);
  });

  it("the other platforms' footer rules: as before", () => {
    const keep = (n: number) => `${wave.repeat(n)}\n\n${website}\n\n#surf #miami`;
    // Instagram, Business Profile and Pinterest count code points; X weighs an emoji 2.
    expect(buildCaptionWithFooter(wave.repeat(1075), plain, "instagram")).toBe(keep(1075));
    expect(buildCaptionWithFooter(wave.repeat(1446), plain, "google_business_profile")).toBe(keep(1446));
    expect(buildCaptionWithFooter(wave.repeat(746), plain, "pinterest")).toBe(keep(746));
    expect(buildCaptionWithFooter(wave.repeat(115), plain, "x")).toBe(`${wave.repeat(115)}\n\n${website}`);
  });
});
