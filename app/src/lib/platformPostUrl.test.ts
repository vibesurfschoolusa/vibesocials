import { describe, expect, it } from "vitest";
import { platformPostUrl } from "./platformPostUrl";

describe("platformPostUrl", () => {
  it("builds a YouTube watch URL", () => {
    expect(platformPostUrl("youtube", "abc123")).toBe("https://www.youtube.com/watch?v=abc123");
  });
  it("builds an X status URL", () => {
    expect(platformPostUrl("x", "190123")).toBe("https://x.com/i/web/status/190123");
  });
  it("builds a LinkedIn update URL from an URN", () => {
    expect(platformPostUrl("linkedin", "urn:li:share:7100")).toBe(
      "https://www.linkedin.com/feed/update/urn:li:share:7100",
    );
  });
  // The Posts API answers either URN form in x-restli-id (posts-api).
  it("builds a LinkedIn update URL from a ugcPost URN, colons intact", () => {
    expect(platformPostUrl("linkedin", "urn:li:ugcPost:6856810298419044352")).toBe(
      "https://www.linkedin.com/feed/update/urn:li:ugcPost:6856810298419044352",
    );
  });
  it("builds a Facebook post URL", () => {
    expect(platformPostUrl("facebook_page", "111_222")).toBe("https://www.facebook.com/111_222");
  });
  it("builds a Pinterest Pin URL", () => {
    expect(platformPostUrl("pinterest", "987654321")).toBe("https://www.pinterest.com/pin/987654321/");
  });
  it("returns null where no public URL is derivable from the id alone", () => {
    expect(platformPostUrl("tiktok", "v_pub_url~x")).toBeNull();
    expect(platformPostUrl("instagram", "1789")).toBeNull();
    expect(platformPostUrl("google_business_profile", "loc/media/1")).toBeNull();
  });
  it("returns null for a missing id", () => {
    expect(platformPostUrl("youtube", null)).toBeNull();
    expect(platformPostUrl("youtube", "")).toBeNull();
  });

  // 2026-11-08: Instagram's media id is not a public locator, so the client
  // stores the post's permalink (PostJobResult.externalPostUrl) and that wins.
  it("uses a stored https link when there is one", () => {
    expect(
      platformPostUrl("instagram", "17993548104117537", "https://www.instagram.com/reel/DfgcZzggTmr/"),
    ).toBe("https://www.instagram.com/reel/DfgcZzggTmr/");
  });

  it("never uses a stored link that is not https", () => {
    expect(platformPostUrl("instagram", "17993548104117537", "javascript:alert(1)")).toBeNull();
    expect(platformPostUrl("instagram", "17993548104117537", "http://www.instagram.com/p/x/")).toBeNull();
    expect(platformPostUrl("x", "123", "not a url")).toBe("https://x.com/i/web/status/123");
  });
});
