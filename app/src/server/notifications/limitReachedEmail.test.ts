import { describe, expect, it } from "vitest";

import { SUPPORT_EMAIL } from "@/lib/siteInfo";

import { buildLimitReachedEmail } from "./limitReachedEmail";

describe("buildLimitReachedEmail", () => {
  it("names the workspace in the subject", () => {
    const email = buildLimitReachedEmail({
      workspaceName: "Surf Co",
      kind: "postsPerDay",
      limit: 20,
      resetsAt: new Date("2026-11-11T00:00:00Z"),
    });
    expect(email.subject).toBe("Surf Co reached a Vibe Socials limit");
  });

  it("posts per day: the limit, what still works, when it starts again, and the support address", () => {
    const { html } = buildLimitReachedEmail({
      workspaceName: "Surf Co",
      kind: "postsPerDay",
      limit: 20,
      resetsAt: new Date("2026-11-11T00:00:00Z"),
    });
    expect(html).toContain("<strong>Surf Co</strong> has reached its limit of 20 posts a day.");
    expect(html).toContain("Drafts and posts scheduled for other days still work.");
    expect(html).toContain("New posts for that day are possible again from 00:00 UTC on 11 November 2026.");
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
      limit: 2048 * 1024 * 1024,
      resetsAt: null,
    });
    expect(html).toContain("has used all of its 2.0 GB of media storage.");
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
