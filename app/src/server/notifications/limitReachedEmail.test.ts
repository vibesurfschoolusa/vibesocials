import { describe, expect, it } from "vitest";

import { SUPPORT_EMAIL } from "@/lib/siteInfo";

import { buildLimitReachedEmail } from "./limitReachedEmail";

describe("buildLimitReachedEmail", () => {
  it("names the workspace in the subject", () => {
    const email = buildLimitReachedEmail({
      workspaceId: "ws_1",
      workspaceName: "Surf Co",
      planInSettings: false,
      appBaseUrl: null,
      kind: "postsPerDay",
      limit: 20,
      day: new Date("2026-11-12T00:00:00Z"),
      resetsAt: null,
    });
    expect(email.subject).toBe("Surf Co reached a Vibe Socials limit");
  });

  it("posts per day: names the full day, says only that other days are not affected, and gives the support address", () => {
    const { html } = buildLimitReachedEmail({
      workspaceId: "ws_1",
      workspaceName: "Surf Co",
      planInSettings: false,
      appBaseUrl: null,
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
      workspaceId: "ws_1",
      workspaceName: "Surf Co",
      planInSettings: false,
      appBaseUrl: null,
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
      workspaceId: "ws_1",
      workspaceName: "Surf Co",
      planInSettings: false,
      appBaseUrl: null,
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
      workspaceId: "ws_1",
      workspaceName: "Surf Co",
      planInSettings: false,
      appBaseUrl: null,
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
      workspaceId: "ws_1",
      workspaceName: "<b>x</b>",
      planInSettings: false,
      appBaseUrl: null,
      kind: "storage",
      limit: 0,
      resetsAt: null,
    });
    expect(html).toContain("&lt;b&gt;x&lt;/b&gt;");
    expect(html).not.toContain("<b>x</b>");
  });
});

// S1 fix round 2: "its limit of 1 YouTube uploads a day" read wrong with the plans' small limits.
describe("buildLimitReachedEmail counts agree with their number", () => {
  function html(kind: "postsPerDay" | "xPostsPerMonth" | "youtubeUploadsPerDay", limit: number): string {
    return buildLimitReachedEmail({
      workspaceId: "ws_1",
      workspaceName: "Surf Co",
      planInSettings: false,
      appBaseUrl: null,
      kind,
      limit,
      day: new Date("2026-11-12T00:00:00Z"),
      resetsAt: null,
    }).html;
  }

  it.each([
    [1, "post"],
    [2, "posts"],
    [10, "posts"],
  ])("posts per day: %i %s", (n, word) => {
    expect(html("postsPerDay", n)).toContain(`reached its limit of ${n} ${word} for 12 November.`);
  });

  it.each([
    [1, "X post"],
    [2, "X posts"],
    [10, "X posts"],
  ])("X posts: %i %s", (n, words) => {
    expect(html("xPostsPerMonth", n)).toContain(`has used its ${n} ${words} for this month.`);
  });

  it.each([
    [1, "YouTube upload"],
    [2, "YouTube uploads"],
    [10, "YouTube uploads"],
  ])("YouTube uploads: %i %s", (n, words) => {
    expect(html("youtubeUploadsPerDay", n)).toContain(`has reached its limit of ${n} ${words} a day.`);
  });
});

// F4: with billing on, an owner raises the limit by changing the plan, not by writing in.
describe("buildLimitReachedEmail - where a higher limit comes from", () => {
  const base = {
    workspaceId: "ws_1",
    workspaceName: "Surf Co",
    kind: "postsPerDay" as const,
    limit: 20,
    day: new Date("2026-11-12T00:00:00Z"),
    resetsAt: null,
  };

  it("billing on: points to Settings, Plan through /go and not to writing in", () => {
    const { html } = buildLimitReachedEmail({ ...base, planInSettings: true, appBaseUrl: "https://vibesocials.wtf" });
    expect(html).toContain(
      `<p>For a higher limit, change this workspace's plan in <a href="https://vibesocials.wtf/go?w=ws_1&amp;to=%2Fsettings%23plan">Settings, Plan</a>.</p>`,
    );
    expect(html).not.toContain(SUPPORT_EMAIL);
  });

  it("billing on without a base URL names Settings, Plan without a link", () => {
    const { html } = buildLimitReachedEmail({ ...base, planInSettings: true, appBaseUrl: null });
    expect(html).toContain("<p>For a higher limit, change this workspace's plan in Settings, Plan.</p>");
  });

  it("billing off: the support address, exactly as before", () => {
    const { html } = buildLimitReachedEmail({ ...base, planInSettings: false, appBaseUrl: "https://vibesocials.wtf" });
    expect(html).toContain(`<p>If you need a higher limit, write to ${SUPPORT_EMAIL} and we will raise it.</p>`);
    expect(html).not.toContain("/go?");
  });
});
