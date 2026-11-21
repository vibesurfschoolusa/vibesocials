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
    expect(removeXMentions("Line one @a\n@b @c\n\n\n\nLine two")).toBe("Line one a\nb c\n\nLine two");
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

  // R59 third look: the cut agrees with countsAsLink on every shape of name.
  it.each([
    "kai.surf", "kai.Surf", "kai.SURF", "KAI.surf", "surf.co", "surf.Co", "vibesurfschool.za", "vibesurfschool.ZA",
    "kai.com", "kai.Com", "kai.net", "kai.org", "kai.pro", "kai.Pro", "kai.xyzzy", "kai.Thanks", "kai.thanks",
    "www.kai", "www.Kai", "WWW.kai", "www.kai.com", "heinrich_.schroder", "kai_surf.co", "kai_.co", "kai2.com",
    "surf2026.co", "kai.c0m", "kai.co1", "a.b.c.com", "kai.school", "kai.School", "kai.miami",
  ])("@%s: cut before its first dot exactly when countsAsLink says link", (name) => {
    const units = textUnits(name);
    const isLink = units.length === 1 && units[0].link !== null && countsAsLink(units[0].link, units[0].text);
    expect(removeXMentions(`Hi @${name}`)).toBe(isLink ? `Hi ${name.slice(0, name.indexOf("."))}` : `Hi ${name}`);
  });
});
