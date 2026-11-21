import { describe, expect, it } from "vitest";

import {
  PINTEREST_DESCRIPTION_MAX,
  buildPinterestAuthorizeUrl,
  PINTEREST_TITLE_MAX,
  fitPinterestDescription,
  fitPinterestTitle,
  parsePinterestBoards,
  pinterestBasicAuthHeader,
  pinterestConfig,
  pinterestCountHint,
  pinterestDescriptionLength,
  pinterestPinLink,
  readPinterestErrorCode,
} from "./pinterestApi";

const ENV = {
  PINTEREST_APP_ID: "1234567",
  PINTEREST_APP_SECRET: "shh",
  PINTEREST_REDIRECT_URI: "https://app.example.com/api/auth/pinterest/callback",
};

describe("pinterestConfig", () => {
  it("returns the app id, secret and redirect URI when all three are set", () => {
    expect(pinterestConfig(ENV)).toEqual({
      appId: "1234567",
      appSecret: "shh",
      redirectUri: "https://app.example.com/api/auth/pinterest/callback",
    });
  });

  it.each(Object.keys(ENV))("is null when %s is missing or blank", (missing) => {
    expect(pinterestConfig({ ...ENV, [missing]: "  " })).toBeNull();
    expect(pinterestConfig({ ...ENV, [missing]: undefined })).toBeNull();
  });
});

describe("pinterestBasicAuthHeader", () => {
  it("is HTTP Basic auth of app id and secret (Pinterest's token endpoint)", () => {
    expect(pinterestBasicAuthHeader("1234567", "shh")).toBe(
      `Basic ${Buffer.from("1234567:shh").toString("base64")}`,
    );
  });
});

describe("buildPinterestAuthorizeUrl", () => {
  it("asks Pinterest for a code with exactly the scopes the app uses, comma separated", () => {
    const url = new URL(
      buildPinterestAuthorizeUrl({
        appId: "1234567",
        redirectUri: ENV.PINTEREST_REDIRECT_URI,
        state: "signed-state",
      }),
    );

    expect(url.origin + url.pathname).toBe("https://www.pinterest.com/oauth/");
    expect(url.searchParams.get("client_id")).toBe("1234567");
    expect(url.searchParams.get("redirect_uri")).toBe(ENV.PINTEREST_REDIRECT_URI);
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("state")).toBe("signed-state");
    expect(url.searchParams.get("scope")).toBe(
      "boards:read,boards:write,pins:read,pins:write,user_accounts:read",
    );
  });
});

describe("fitPinterestDescription", () => {
  it("leaves a description that fits unchanged", () => {
    expect(fitPinterestDescription("Surf lessons in Fort Lauderdale")).toBe(
      "Surf lessons in Fort Lauderdale",
    );
  });

  it("cuts a long description to 800 characters, ending in an ellipsis", () => {
    const fitted = fitPinterestDescription("a".repeat(900));

    expect([...fitted]).toHaveLength(PINTEREST_DESCRIPTION_MAX);
    expect(fitted.endsWith("...")).toBe(true);
  });

  it("never sends more than 800 code points, even when one visible character is several", () => {
    // A family emoji is 1 grapheme but 7 code points: 800 of them are 5,600.
    const family = "\u{1F468}‍\u{1F469}‍\u{1F467}‍\u{1F466}";
    const fitted = fitPinterestDescription(family.repeat(800));

    expect([...fitted].length).toBeLessThanOrEqual(PINTEREST_DESCRIPTION_MAX);
    // Still whole emoji, then the ellipsis: never half a character.
    expect(fitted.endsWith("...")).toBe(true);
    expect(fitted.slice(0, -3).replaceAll(family, "")).toBe("");
  });
});

describe("fitPinterestTitle", () => {
  it("leaves a short caption as the title, on one line", () => {
    expect(fitPinterestTitle("Catch your first wave.\nBook today")).toBe("Catch your first wave. Book today");
  });

  it("keeps whole sentences when the caption is longer than 100 characters", () => {
    const title = fitPinterestTitle(`Catch your first wave. ${"Surf ".repeat(30)}all day.`);

    expect(title).toBe("Catch your first wave.");
  });

  it("never sends more than 100 code points, even when one visible character is several", () => {
    // 60 family emoji are 60 graphemes (under the limit) but 420 code points.
    const family = "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F466}";
    const title = fitPinterestTitle(`${family.repeat(60)} surf day`);

    expect([...title].length).toBeLessThanOrEqual(PINTEREST_TITLE_MAX);
    expect(title.length).toBeGreaterThan(0);
  });
});

describe("pinterestPinLink", () => {
  it("makes a destination link from the workspace's website", () => {
    expect(pinterestPinLink("https://www.vibesurfschool.com/lessons")).toBe(
      "https://www.vibesurfschool.com/lessons",
    );
  });

  it("adds https:// to a website saved without a scheme", () => {
    expect(pinterestPinLink(" www.vibesurfschool.com ")).toBe("https://www.vibesurfschool.com/");
  });

  it("keeps a port: host:port is not a scheme", () => {
    expect(pinterestPinLink("shop.example.com:8080/surf")).toBe("https://shop.example.com:8080/surf");
  });

  it.each([
    null,
    undefined,
    "",
    "   ",
    "not a url",
    "javascript:alert(1)",
    "ftp://example.com",
    "mailto:hello@example.com",
  ])(
    "is null for %j",
    (value) => {
      expect(pinterestPinLink(value)).toBeNull();
    },
  );

  it("is null for a link longer than Pinterest accepts (2,048 characters)", () => {
    expect(pinterestPinLink(`https://example.com/${"a".repeat(2048)}`)).toBeNull();
  });
});

describe("parsePinterestBoards", () => {
  it("reads id, name and privacy of each board, and the bookmark of the next page", () => {
    expect(
      parsePinterestBoards({
        items: [
          { id: "111", name: "Surf lessons", privacy: "PUBLIC", description: "x" },
          { id: "222", name: "Team", privacy: "SECRET" },
        ],
        bookmark: "next-page",
      }),
    ).toEqual({
      boards: [
        { id: "111", name: "Surf lessons", privacy: "PUBLIC" },
        { id: "222", name: "Team", privacy: "SECRET" },
      ],
      bookmark: "next-page",
    });
  });

  it("skips entries without a usable id or name, and copes with a body that isn't a list", () => {
    expect(
      parsePinterestBoards({ items: [{ id: 5, name: "x" }, { id: "9", name: "" }, null, { id: "7", name: "Ok" }] }),
    ).toEqual({ boards: [{ id: "7", name: "Ok", privacy: null }], bookmark: null });
    expect(parsePinterestBoards(null)).toEqual({ boards: [], bookmark: null });
    expect(parsePinterestBoards({ items: "nope" })).toEqual({ boards: [], bookmark: null });
  });
});

describe("readPinterestErrorCode", () => {
  it("reads the integer code of Pinterest's error body", () => {
    expect(readPinterestErrorCode('{"code":2,"message":"Board not found."}')).toBe(2);
  });

  it("is null for anything else", () => {
    expect(readPinterestErrorCode("<html>Bad gateway</html>")).toBeNull();
    expect(readPinterestErrorCode('{"code":"2"}')).toBeNull();
    expect(readPinterestErrorCode("null")).toBeNull();
  });
});

// R53 platform-clients L1: the composer counts the description with the unit
// fitPinterestDescription cuts on, and says why the number can jump.
describe("pinterestDescriptionLength and pinterestCountHint", () => {
  const HINT = "Pinterest counts some characters, such as emoji, as 2 or more.";

  it("counts code points: one for a letter, 2 for a heart, a flag or a skin tone, 7 for a family", () => {
    expect(pinterestDescriptionLength("abc")).toBe(3);
    expect(pinterestDescriptionLength("café")).toBe(4);
    expect(pinterestDescriptionLength("❤️")).toBe(2);
    expect(pinterestDescriptionLength("\u{1F1FA}\u{1F1F8}")).toBe(2);
    expect(pinterestDescriptionLength("\u{1F44B}\u{1F3FD}")).toBe(2);
    expect(pinterestDescriptionLength("\u{1F468}‍\u{1F469}‍\u{1F467}‍\u{1F466}")).toBe(7);
  });

  it("cuts exactly when the length is over 800", () => {
    for (const text of ["❤️".repeat(400), `${"❤️".repeat(400)}a`, "a".repeat(800), "a".repeat(801)]) {
      expect(fitPinterestDescription(text) !== text).toBe(pinterestDescriptionLength(text) > PINTEREST_DESCRIPTION_MAX);
    }
  });

  it.each([
    ["an emoji", "love ❤️"],
    ["a flag", "go \u{1F1FA}\u{1F1F8}"],
    ["a combining accent", "café"],
    ["a letter from another script that is 2 code points", "कि"],
  ])("hints for %s, which counts as 2 or more", (_case, text) => {
    expect(pinterestDescriptionLength(text)).toBeGreaterThan([...new Intl.Segmenter().segment(text)].length);
    expect(pinterestCountHint(text)).toBe(HINT);
  });

  it("gives no hint for plain ASCII", () => {
    expect(pinterestCountHint("Plain ASCII words, 123 <3 & more!")).toBeNull();
  });

  it("hints only when some character counts as 2 or more", () => {
    expect(pinterestCountHint("plain words")).toBeNull();
    expect(pinterestCountHint("café \u{1F30A}")).toBeNull();
    expect(pinterestCountHint("love ❤️")).toBe(HINT);
    expect(pinterestCountHint("café")).toBe(HINT);
    expect(pinterestCountHint("\u{1F468}‍\u{1F469}‍\u{1F467}")).toBe(HINT);
  });
});

/** A caption whose cut at `budget` (the limit less the ellipsis) falls inside "#surfschool", after "#sur". */
function tagCutCaption(budget: number): { caption: string; wholeWords: string } {
  const wholeWords = "Waves ".repeat(Math.ceil(budget / 6)).slice(0, budget - 6) + "!";
  return { caption: `${wholeWords} #surfschool #floridasurf`, wholeWords };
}

// R64 platform-clients L1: the 800-character description cut ends at a whole word.
describe("fitPinterestDescription cuts at a whole word", () => {
  it("a cut inside \"#surfschool\" ends at the word before it", () => {
    const { caption, wholeWords } = tagCutCaption(797);
    expect(fitPinterestDescription(caption)).toBe(`${wholeWords}...`);
  });

  it("a cut inside \"#surfschool\" after emoji of 2 code points, counted in code points", () => {
    // 100 hearts are 100 characters and 200 code points.
    const hearts = "❤️".repeat(100);
    const { caption, wholeWords } = tagCutCaption(597);
    const fitted = fitPinterestDescription(hearts + caption);
    expect(fitted).toBe(`${hearts}${wholeWords}...`);
    expect(pinterestDescriptionLength(fitted)).toBeLessThanOrEqual(PINTEREST_DESCRIPTION_MAX);
  });

  it("a script with no spaces keeps the plain cut", () => {
    expect(fitPinterestDescription(`Surf school ${"波".repeat(1000)}`)).toBe(`Surf school ${"波".repeat(785)}...`);
  });
});
