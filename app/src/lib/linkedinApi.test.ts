import { describe, expect, it } from "vitest";

import {
  LINKEDIN_API_VERSION,
  LINKEDIN_REST_BASE_URL,
  LINKEDIN_RESTLI_PROTOCOL_VERSION,
  linkedinRestHeaders,
  toLinkedInLittleText,
} from "./linkedinApi";

describe("the LinkedIn API version", () => {
  it("is 202610 (supported until 2027-10-15), on the versioned /rest base with Rest.li 2.0.0", () => {
    expect(LINKEDIN_API_VERSION).toBe("202610");
    expect(LINKEDIN_REST_BASE_URL).toBe("https://api.linkedin.com/rest");
    expect(LINKEDIN_RESTLI_PROTOCOL_VERSION).toBe("2.0.0");
  });

  it("puts the token, the version and the protocol on every call, plus what the caller adds", () => {
    expect(linkedinRestHeaders("tok")).toEqual({
      Authorization: "Bearer tok",
      "Linkedin-Version": "202610",
      "X-Restli-Protocol-Version": "2.0.0",
    });
    expect(linkedinRestHeaders("tok", { "Content-Type": "application/json" })).toEqual({
      Authorization: "Bearer tok",
      "Linkedin-Version": "202610",
      "X-Restli-Protocol-Version": "2.0.0",
      "Content-Type": "application/json",
    });
  });
});

describe("toLinkedInLittleText", () => {
  it("leaves text with no reserved character as it is, line breaks and emoji included", () => {
    const text = "Waves are up! 50% off lessons today.\n\nBook now 🏄 — see you there, friends.";
    expect(toLinkedInLittleText(text)).toBe(text);
  });

  it("escapes every reserved character of the little format with a backslash", () => {
    expect(toLinkedInLittleText("a|b{c}d@e[f]g(h)i<j>k*l_m~n\\o")).toBe(
      "a\\|b\\{c\\}d\\@e\\[f\\]g\\(h\\)i\\<j\\>k\\*l\\_m\\~n\\\\o",
    );
  });

  it("keeps a hashtag a hashtag: a # that starts a word is not escaped", () => {
    expect(toLinkedInLittleText("#surf #ÉtéSurf #2026 #Wellen")).toBe("#surf #ÉtéSurf #2026 #Wellen");
  });

  // 2026-11-09 review: a # inside a word or a URL is not a hashtag (a link's
  // #fragment stays part of the link).
  it("escapes a # inside a word or a URL", () => {
    expect(toLinkedInLittleText("Book at https://vibesurfschool.com/#lessons today #surf")).toBe(
      "Book at https://vibesurfschool.com/\\#lessons today #surf",
    );
    expect(toLinkedInLittleText("page#top and x#tag")).toBe("page\\#top and x\\#tag");
    expect(toLinkedInLittleText('(#surf) and "#waves"')).toBe('\\(#surf\\) and "#waves"');
  });

  it("escapes a # that starts no word", () => {
    expect(toLinkedInLittleText("C# and # alone, #")).toBe("C\\# and \\# alone, \\#");
    expect(toLinkedInLittleText("##double")).toBe("\\##double");
  });

  it("turns a caption with a would-be mention and parentheses into plain text that shows as typed", () => {
    expect(toLinkedInLittleText("Lessons (beginners) @ 9am with @[Ana](urn:li:person:1) #surf")).toBe(
      "Lessons \\(beginners\\) \\@ 9am with \\@\\[Ana\\]\\(urn:li:person:1\\) #surf",
    );
  });
});
