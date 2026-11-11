import { describe, expect, it } from "vitest";

import { trackedGoogleButtonUrl, trackedWebsiteLink } from "./trackingTags";

const TAGS = (source: string) => `utm_source=${source}&utm_medium=social&utm_campaign=vibesocials`;

describe("trackedWebsiteLink", () => {
  it.each([
    ["facebook_page", "facebook"],
    ["linkedin", "linkedin"],
    ["x", "x"],
    ["youtube", "youtube"],
    ["pinterest", "pinterest"],
    ["google_business_profile", "google"],
  ] as const)("tags %s as utm_source=%s", (platform, source) => {
    expect(trackedWebsiteLink("https://example.com/", platform)).toBe(
      `https://example.com/?${TAGS(source)}`,
    );
  });

  it.each(["instagram", "tiktok"] as const)("leaves %s unchanged (its links cannot be clicked)", (platform) => {
    expect(trackedWebsiteLink("https://example.com/", platform)).toBe("https://example.com/");
  });

  it("keeps a website typed without a scheme in that form", () => {
    expect(trackedWebsiteLink("vibesurfschool.com", "facebook_page")).toBe(
      `vibesurfschool.com/?${TAGS("facebook")}`,
    );
    expect(trackedWebsiteLink("www.vibesurfschool.com/lessons", "x")).toBe(
      `www.vibesurfschool.com/lessons?${TAGS("x")}`,
    );
  });

  it("keeps the scheme, host case and path as typed", () => {
    expect(trackedWebsiteLink("http://Example.com/Surf/", "linkedin")).toBe(
      `http://Example.com/Surf/?${TAGS("linkedin")}`,
    );
  });

  it("keeps an existing query and adds the tags after it", () => {
    expect(trackedWebsiteLink("example.com/book?lang=en", "youtube")).toBe(
      `example.com/book?lang=en&${TAGS("youtube")}`,
    );
    expect(trackedWebsiteLink("example.com/book?", "youtube")).toBe(
      `example.com/book?${TAGS("youtube")}`,
    );
  });

  it("keeps a fragment and puts the tags before it", () => {
    expect(trackedWebsiteLink("https://example.com/surf?lang=en#book", "pinterest")).toBe(
      `https://example.com/surf?lang=en&${TAGS("pinterest")}#book`,
    );
    expect(trackedWebsiteLink("example.com#book", "x")).toBe(`example.com/?${TAGS("x")}#book`);
  });

  it("leaves a link that already has a utm_source unchanged", () => {
    const own = "https://example.com/?utm_source=newsletter&utm_medium=email";
    expect(trackedWebsiteLink(own, "facebook_page")).toBe(own);
  });

  it.each([
    "",
    "not a url",
    "mailto:hello@example.com",
    "ftp://example.com/file",
    "localhost",
    "user:pass@example.com",
    "https://",
  ])("returns %j unchanged", (junk) => {
    expect(trackedWebsiteLink(junk, "facebook_page")).toBe(junk);
  });
});

describe("trackedGoogleButtonUrl", () => {
  it("tags a button that links to the workspace website's host", () => {
    expect(trackedGoogleButtonUrl("https://vibesurfschool.com/book", "vibesurfschool.com")).toBe(
      `https://vibesurfschool.com/book?${TAGS("google")}`,
    );
  });

  it("treats www. and the bare host as the same site", () => {
    expect(trackedGoogleButtonUrl("https://www.vibesurfschool.com/", "vibesurfschool.com")).toBe(
      `https://www.vibesurfschool.com/?${TAGS("google")}`,
    );
    expect(trackedGoogleButtonUrl("https://vibesurfschool.com/", "https://WWW.vibesurfschool.com")).toBe(
      `https://vibesurfschool.com/?${TAGS("google")}`,
    );
  });

  it("leaves a button on another site alone", () => {
    expect(trackedGoogleButtonUrl("https://booking.example.org/vibe", "vibesurfschool.com")).toBe(
      "https://booking.example.org/vibe",
    );
    expect(trackedGoogleButtonUrl("https://shop.vibesurfschool.com/", "vibesurfschool.com")).toBe(
      "https://shop.vibesurfschool.com/",
    );
  });

  it("leaves the button alone when the website is missing or unreadable", () => {
    expect(trackedGoogleButtonUrl("https://vibesurfschool.com/", null)).toBe("https://vibesurfschool.com/");
    expect(trackedGoogleButtonUrl("https://vibesurfschool.com/", "not a url")).toBe(
      "https://vibesurfschool.com/",
    );
  });
});
