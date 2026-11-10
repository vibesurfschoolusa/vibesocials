import { describe, expect, it } from "vitest";

import { SUPPORT_EMAIL } from "@/lib/siteInfo";

import { buildLimitReachedEmail } from "./limitReachedEmail";

describe("buildLimitReachedEmail", () => {
  it("names the workspace in the subject", () => {
    const email = buildLimitReachedEmail({
      workspaceName: "Surf Co",
      kind: "postsPerDay",
      limit: 20,
      day: new Date("2026-11-12T00:00:00Z"),
      resetsAt: null,
    });
    expect(email.subject).toBe("Surf Co reached a Vibe Socials limit");
  });

  it("posts per day: names the full day, says only that other days are not affected, and gives the support address", () => {
    const { html } = buildLimitReachedEmail({
      workspaceName: "Surf Co",
      kind: "postsPerDay",
      limit: 20,
      day: new Date("2026-11-12T15:00:00Z"),
      resetsAt: null,
    });
    expect(html).toContain(
      "<p><strong>Surf Co</strong> reached its limit of 20 posts for 12 November. Posts on other days are not affected.</p>",
    );
    expect(html).not.toContain("possible again");
    expect(html).toContain(`write to ${SUPPORT_EMAIL}`);
  });

  it("X per month names the first of the next month", () => {
    const { html } = buildLimitReachedEmail({
      workspaceName: "Surf Co",
      kind: "xPostsPerMonth",
      limit: 30,
      resetsAt: new Date("2027-01-01T00:00:00Z"),
    });
    expect(html).toContain("has used its 30 X posts for this month.");
    expect(html).toContain("Posts to every other platform still go out.");
    expect(html).toContain("X posts start again on 1 January 2027.");
  });

  it("YouTube per day starts again at midnight Pacific time", () => {
    const { html } = buildLimitReachedEmail({
      workspaceName: "Surf Co",
      kind: "youtubeUploadsPerDay",
      limit: 10,
      resetsAt: new Date("2026-11-11T08:00:00Z"),
    });
    expect(html).toContain("has reached its limit of 10 YouTube uploads a day.");
    expect(html).toContain("Posts to every other platform still go out.");
    expect(html).toContain("YouTube uploads start again at midnight Pacific time.");
  });

  it("storage frees up when media is deleted", () => {
    const { html } = buildLimitReachedEmail({
      workspaceName: "Surf Co",
      kind: "storage",
      limit: 5120 * 1024 * 1024,
      resetsAt: null,
    });
    expect(html).toContain("has used all of its 5.0 GB of media storage.");
    expect(html).toContain("Posting with media already in the library still works.");
    expect(html).toContain("Uploads work again as soon as media is deleted on the Media page.");
  });

  it("escapes the workspace name in the body", () => {
    const { html } = buildLimitReachedEmail({
      workspaceName: "<b>x</b>",
      kind: "storage",
      limit: 0,
      resetsAt: null,
    });
    expect(html).toContain("&lt;b&gt;x&lt;/b&gt;");
    expect(html).not.toContain("<b>x</b>");
  });
});
