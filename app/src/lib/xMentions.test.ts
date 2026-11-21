import { describe, expect, it } from "vitest";

import { buildPlatformPreview } from "./platformPreview";
import { adaptMaxLength } from "./platformOverrides";
import { removeXMentions } from "./xMentions";
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

  it("keeps a dotted Instagram-style handle whole in running text", () => {
    expect(removeXMentions("Hi @vibesurfschool.za and @heinrich_.schroder!")).toBe(
      "Hi vibesurfschool.za and heinrich_.schroder!",
    );
  });

  it("removes a footer line of mentions alone, with its whitespace", () => {
    expect(removeXMentions("Line one @a\n@b @c\n\n\n\nLine two")).toBe("Line one a\n\nLine two");
    expect(removeXMentions("Great day out\n\n  @kai @mia.surf  ")).toBe("Great day out");
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
    expect(removeXMentions("#surf @kai\r\nGreat day")).toBe("#surf\r\nGreat day");
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
