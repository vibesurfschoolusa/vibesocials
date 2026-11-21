import { describe, expect, it } from "vitest";

import { buildPlatformPreview } from "./platformPreview";
import { adaptMaxLength } from "./platformOverrides";
import { removeXMentions } from "./xMentions";
import { textUnits } from "./truncate";
import { countsAsLink, xWeightedLength } from "./xWeightedLength";
import { computeTweetText } from "@/server/platforms/xClient";

// The footer from the 2026-11-08 live post that X refused with 403.
const LIVE_POST =
  "Ride the waves and feel the thrill! Join us at Vibe Surf School for a surf experience you'll never forget. 🌊🏄‍♀️\n\n" +
  "For more info visit www.vibesurfschool.com\n\n" +
  "#thingstodo #surflessons #fortlauderdale @visitflorida @surfrider @surfer_magazine @daniabeachfl " +
  "@heinrich_.schroder @klaus_seas @floridatravelguide @gopro @themiamiguide @swell @vibesurfschool.za " +
  "@vibebeachhouse @surfingworld @onlyinfloridaa @usasurfing @perrucciarts";

describe("removeXMentions", () => {
  it("drops every mention from the live post, keeping the caption, link and hashtags", () => {
    expect(removeXMentions(LIVE_POST)).toBe(
      "Ride the waves and feel the thrill! Join us at Vibe Surf School for a surf experience you'll never forget. 🌊🏄‍♀️\n\n" +
        "For more info visit www.vibesurfschool.com\n\n" +
        "#thingstodo #surflessons #fortlauderdale",
    );
  });

  it("keeps email addresses and text with no mentions", () => {
    expect(removeXMentions("Email info@vibesurfschool.com today")).toBe("Email info@vibesurfschool.com today");
    expect(removeXMentions("No tags here #surf")).toBe("No tags here #surf");
  });

  // R59 new-customer-2 L2: in running text only the "@" goes, so the sentence
  // still reads; X doesn't take a bare name as a mention.
  it("mid-sentence, drops only the @", () => {
    expect(removeXMentions("Come surf with @vibesurfschool. Lessons daily!")).toBe(
      "Come surf with vibesurfschool. Lessons daily!",
    );
  });

  it("in a list, drops only the @", () => {
    expect(removeXMentions("Shot by @kai, edited by @mia")).toBe("Shot by kai, edited by mia");
  });

  it("in brackets and at the start, drops only the @", () => {
    expect(removeXMentions("@gopro Thanks @surfrider for the waves (@usasurfing)")).toBe(
      "gopro Thanks surfrider for the waves (usasurfing)",
    );
  });

  // R59 fix review L2: a bare dotted name that X would count as a link keeps
  // only the part before its first dot, so the post never carries a link.
  it.each([
    ["Surf with @vibesurfschool.za", "Surf with vibesurfschool"],
    ["Coached by @kai.surf today", "Coached by kai today"],
    ["Ask @surf.co!", "Ask surf!"],
  ])("%s: a name that would be a link keeps the part before its first dot", (text, expected) => {
    expect(removeXMentions(text)).toBe(expected);
  });

  it("keeps a dotted name whole when it would not be a link", () => {
    expect(removeXMentions("Hi @heinrich_.schroder!")).toBe("Hi heinrich_.schroder!");
  });

  // R59 fix review L3: the footer is a paragraph of its own.
  it("a mentions-only line inside a paragraph with text is running text", () => {
    // R60 pages-a-4 L1: the blank lines held no mention, so they stay as written.
    expect(removeXMentions("Line one @a\n@b @c\n\n\n\nLine two")).toBe("Line one a\nb c\n\n\n\nLine two");
    expect(removeXMentions("Photos by:\n@kai @mia\n\nBook now")).toBe("Photos by:\nkai mia\n\nBook now");
    expect(removeXMentions("Our coaches:\n- @kai\n- @mia")).toBe("Our coaches:\n- kai\n- mia");
  });

  it("removes a footer paragraph of mentions alone, with its whitespace", () => {
    expect(removeXMentions("Great day out\n\n  @kai @mia.surf  ")).toBe("Great day out");
    expect(removeXMentions("@kai @mia\n\nGreat day out")).toBe("Great day out");
  });

  it("a footer paragraph of several tag lines loses every mention", () => {
    expect(removeXMentions("Great day\n\n#surf #florida\n@kai @mia")).toBe("Great day\n\n#surf #florida");
  });

  it("on a footer line of hashtags and mentions, removes the mentions whole", () => {
    expect(removeXMentions("Great day\n\n#surf @kai #florida @mia")).toBe("Great day\n\n#surf #florida");
  });

  it("treats separators on a footer line as part of the footer", () => {
    expect(removeXMentions("Great day\n\n#surf · @kai | @mia, @ana · #florida")).toBe("Great day\n\n#surf · #florida");
    expect(removeXMentions("Great day\n\n@kai, @mia | @ana")).toBe("Great day");
  });

  it("a line with any other word is running text", () => {
    expect(removeXMentions("#surf with @kai")).toBe("#surf with kai");
  });

  it("keeps CRLF line ends on a footer line", () => {
    expect(removeXMentions("Great day\r\n\r\n#surf @kai\r\n#fl")).toBe("Great day\r\n\r\n#surf\r\n#fl");
  });

  // R60 platform-clients L2: as twitter-text, a mention starts after any
  // character outside [A-Za-z0-9_!#$%&*@＠], so X reads these as mentions too.
  it.each([
    ["Thanks.@kai for the shot", "Thanks.kai for the shot"],
    ['Shot by "@mia"', 'Shot by "mia"'],
    ["Waves\u2014@ana all day", "Waves\u2014ana all day"],
    ["\u{1F4F8}@kai", "\u{1F4F8}kai"],
    ["Photo:@kai", "Photo:kai"],
  ])("%s: a mention after punctuation or an emoji loses its @", (text, expected) => {
    expect(removeXMentions(text)).toBe(expected);
  });

  it.each(["Email info@surf.com today", "Write to kai_@surf.co", "Hi!@kai", "Score 3@kai", "C#@kai", "a&@kai", "x*@kai"])(
    "%s: an @ after a letter, digit or one of _!#$%%&*@ is not a mention",
    (text) => {
      expect(removeXMentions(text)).toBe(text);
    },
  );

  // R60 platform-clients L3: a dotted name is cut when any part of it is a link.
  it.each([
    ["Thanks @kai.surf_co today", "Thanks kai today"],
    ["Ask @surf.co_kai", "Ask surf"],
    ["Hi @heinrich_.schroder", "Hi heinrich_.schroder"],
  ])("%s: a name with a link anywhere in it keeps the part before its first dot", (text, expected) => {
    expect(removeXMentions(text)).toBe(expected);
  });

  // R60 pages-a-4 L1: only the lines a mention was removed from are tidied.
  it("an indented price list with an email address comes back unchanged", () => {
    const text = "Prices:\n  Lesson   $50\n  Board    $20\n\n\n\nBook at info@surf.com  ";
    expect(removeXMentions(text)).toBe(text);
  });

  it("a line with a removed mention is tidied; the other lines stay as written", () => {
    expect(removeXMentions("Prices:\n  Lesson   $50\n  Shot   by @kai  ")).toBe("Prices:\n  Lesson   $50\nShot by kai");
  });

  it("a footer paragraph still goes whole, and the lines around it stay as written", () => {
    expect(removeXMentions("  Lesson   $50\n\n#surf   @kai")).toBe("  Lesson   $50\n\n#surf");
    expect(removeXMentions("  Lesson   $50\n\n@kai @mia\n\n  Board    $20")).toBe("  Lesson   $50\n\n  Board    $20");
  });

  // R60 fix review M1: an "@" inside a link the X count finds is part of the
  // link (a YouTube, TikTok or Threads handle address), never a mention.
  it.each([
    "See youtube.com/@x",
    "Watch https://www.youtube.com/@vibesurfschool",
    "Follow https://www.tiktok.com/@vibe.surf.co",
    "Ride the waves!\n\nFor more info visit https://www.tiktok.com/@vibesurfschool",
    "Ride the waves!\n\nFor more info visit www.tiktok.com/@vibe.surf.co",
  ])("%s: the link stays whole", (text) => {
    expect(removeXMentions(text)).toBe(text);
  });

  it("a real mention right after a link still loses its @", () => {
    expect(removeXMentions("Lessons at https://surf.co/surf @kai")).toBe("Lessons at https://surf.co/surf kai");
    expect(removeXMentions("youtube.com/@x with @kai")).toBe("youtube.com/@x with kai");
  });

  // R60 fix review L1: a footer after leading blank lines leaves no stray newline.
  it("a footer after leading blank lines takes the blank lines on both sides with it", () => {
    expect(removeXMentions("\n\n@kai\n\nText")).toBe("Text");
    expect(removeXMentions("\n\n@kai\n\n")).toBe("");
  });

  it("in running text, the name stays and counts on X", () => {
    const text = computeTweetText(`Surf with @ana_surf ${"a".repeat(280)}`);
    expect(text.startsWith("Surf with ana_surf ")).toBe(true);
    expect([...new Intl.Segmenter().segment(text)].length).toBe(280);
  });
});

describe("Adapt for X room with the new rule (#288)", () => {
  it("still measures the footer without its mentions", () => {
    const handles = Array.from({ length: 8 }, (_, i) => `@surfspot_account${i}`).join(" ");
    const footer = { companyWebsite: "a.co", defaultHashtags: `#surf ${handles}` };
    const withoutMentions = { companyWebsite: "a.co", defaultHashtags: "#surf" };
    expect(adaptMaxLength("x", footer)).toBe(adaptMaxLength("x", withoutMentions));
  });
});

describe("X text: client and preview agree", () => {
  it("the X client posts the live caption without mentions, under 280 characters", () => {
    const text = computeTweetText(LIVE_POST);
    expect(text).not.toMatch(/(^|\s)@\w/);
    expect(text).toBe(removeXMentions(LIVE_POST));
    expect([...new Intl.Segmenter().segment(text)].length).toBeLessThanOrEqual(280);
  });

  it("the composer's X preview shows exactly what the client posts", () => {
    const preview = buildPlatformPreview({ platform: "x", caption: LIVE_POST });
    expect(preview.rendered).toBe(computeTweetText(LIVE_POST));
    expect(preview.willTruncate).toBe(false);
  });

  it("other platforms keep their mentions", () => {
    expect(buildPlatformPreview({ platform: "instagram", caption: LIVE_POST }).rendered).toContain("@visitflorida");
  });
});

// R59 second look: the cut uses xWeightedLength's own link test (countsAsLink),
// never a copy, so a name is cut exactly when the X count weighs it as a link.
describe("removeXMentions and the X count agree on links", () => {
  it.each([
    ["kai.surf", true],
    ["surf.co", true],
    ["kai.Surf", false],
    ["kai.Thanks", false],
  ] as const)("@%s: cut before its dot %s, as the X count weighs it", (name, isLink) => {
    expect(xWeightedLength(name) === 23).toBe(isLink);
    expect(removeXMentions(`Hi @${name}`)).toBe(isLink ? `Hi ${name.slice(0, name.indexOf("."))}` : `Hi ${name}`);
  });

  it("keeps \"kai.Surf\" whole: a capitalised ending is not a link (G1 rule)", () => {
    expect(removeXMentions("Coached by @kai.Surf")).toBe("Coached by kai.Surf");
  });

  it("keeps \"kai.Thanks\" whole: \"Thanks\" is not a link ending", () => {
    expect(removeXMentions("Shot by @kai.Thanks for watching")).toBe("Shot by kai.Thanks for watching");
  });

  it("keeps \"kai.pro\" whole: \"pro\" is not on the ending list (known limit)", () => {
    expect(removeXMentions("Coached by @kai.pro")).toBe("Coached by kai.pro");
  });

  it("calls the shared link test instead of a copy of it", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const source = readFileSync(fileURLToPath(new URL("./xMentions.ts", import.meta.url)), "utf8");
    expect(source).toContain("countsAsLink(");
    expect(source).not.toContain("xWeightedLength(");
    // R59 third look: no copy of the ending list or its test either.
    expect(source).not.toMatch(/GENERIC_TLDS|isLinkEnding|typedEnding/);
    expect(source).not.toMatch(/new Set\(\[|"(?:com|net|org|surf|co|za)"/);
  });

  // R60 platform-clients L3: the cut and the X count agree on names with a
  // link in part of them. A cut name was weighed as holding a link, and what is
  // left holds none; a name kept whole was weighed as plain characters.
  it.each([
    ["kai.surf_co", true],
    ["surf.co_kai", true],
    ["kai.surf", true],
    ["a.b.c.com", true],
    ["kai.co.uk", true],
    ["kai.Surf_co", false],
    ["heinrich_.schroder", false],
    ["kai_surf.co", false],
    ["x_kai.surf", false],
    ["vibe_surf.school", false],
    ["kai.surf.Com", false],
  ] as const)("@%s: cut %s, as xWeightedLength weighs it", (name, cut) => {
    const left = removeXMentions(`Hi @${name}`).slice("Hi ".length);
    expect(left).toBe(cut ? name.slice(0, name.indexOf(".")) : name);
    expect(xWeightedLength(name) !== name.length).toBe(cut);
    expect(xWeightedLength(left)).toBe(left.length);
  });

  // R59 third look: the cut agrees with countsAsLink on every shape of name.
  it.each([
    "kai.surf", "kai.Surf", "kai.SURF", "KAI.surf", "surf.co", "surf.Co", "vibesurfschool.za", "vibesurfschool.ZA",
    "kai.com", "kai.Com", "kai.net", "kai.org", "kai.pro", "kai.Pro", "kai.xyzzy", "kai.Thanks", "kai.thanks",
    "www.kai", "www.Kai", "WWW.kai", "www.kai.com", "heinrich_.schroder", "kai_surf.co", "kai_.co", "kai2.com",
    "surf2026.co", "kai.c0m", "kai.co1", "a.b.c.com", "kai.school", "kai.School", "kai.miami",
    "kai.surf_co", "surf.co_kai", "kai.Surf_co", "kai.pro_x", "x_kai.surf", "kai.surf.Com", "kai.co.uk",
  ])("@%s: cut before its first dot exactly when countsAsLink says link", (name) => {
    const units = textUnits(name);
    // R60 platform-clients L3: any unit that is a link, not only a whole-name one.
    const isLink = units.some((unit) => unit.link !== null && countsAsLink(unit.link, unit.text));
    expect(removeXMentions(`Hi @${name}`)).toBe(isLink ? `Hi ${name.slice(0, name.indexOf("."))}` : `Hi ${name}`);
  });
});

// R61 platform-clients L1: twitter-text reads a full-width "＠" as the mention
// sign too, so it is removed the same way as "@".
describe("removeXMentions: the full-width ＠", () => {
  it("drops the ＠ in running text", () => {
    expect(removeXMentions("Thanks ＠kai")).toBe("Thanks kai");
  });

  it("removes a ＠ footer paragraph", () => {
    expect(removeXMentions("Great day out.\n\n＠kai ＠mia")).toBe("Great day out.");
  });

  it("handles a mix of @ and ＠", () => {
    expect(removeXMentions("Thanks @kai and ＠mia")).toBe("Thanks kai and mia");
    expect(removeXMentions("Great day out.\n\n@kai ＠mia #surf")).toBe("Great day out.\n\n#surf");
  });

  it("keeps an email address with either sign", () => {
    expect(removeXMentions("Write to info＠surf.com")).toBe("Write to info＠surf.com");
    expect(removeXMentions("Write to info@surf.com or ＠kai")).toBe("Write to info@surf.com or kai");
  });
});
