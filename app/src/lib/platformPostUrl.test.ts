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
  it("builds a Facebook post URL", () => {
    expect(platformPostUrl("facebook_page", "111_222")).toBe("https://www.facebook.com/111_222");
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
});
