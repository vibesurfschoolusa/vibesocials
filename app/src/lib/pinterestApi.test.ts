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
