import { describe, expect, it } from "vitest";

import { buildPlatformPreview } from "./platformPreview";
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

  it("removes mentions at the start, mid-sentence and in brackets, and tidies the gaps", () => {
    expect(removeXMentions("@gopro Thanks @surfrider for the waves (@usasurfing)")).toBe(
      "Thanks for the waves ()",
    );
    expect(removeXMentions("Line one @a\n@b @c\n\n\n\nLine two")).toBe("Line one\n\nLine two");
  });

  it("removes dotted Instagram-style handles as a whole", () => {
    // Only the mention goes: the space before "!" was the user's, so it stays.
    expect(removeXMentions("Hi @vibesurfschool.za and @heinrich_.schroder!")).toBe("Hi and !");
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
