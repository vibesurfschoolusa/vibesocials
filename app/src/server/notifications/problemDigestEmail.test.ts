import { describe, expect, it } from "vitest";

import { buildProblemDigestEmail, type ProblemDigestWorkspace } from "./problemDigestEmail";

function workspace(overrides: Partial<ProblemDigestWorkspace> = {}): ProblemDigestWorkspace {
  return {
    workspaceId: "ws-1",
    name: "Surf Co",
    failedPosts: 0,
    failedPlatforms: [],
    needsReconnect: [],
    waitingForApproval: 0,
    ...overrides,
  };
}

const BASE = "https://vibesocials.wtf";

describe("buildProblemDigestEmail", () => {
  it("uses the singular subject for one workspace", () => {
    const email = buildProblemDigestEmail({
      workspaces: [workspace({ waitingForApproval: 1 })],
      appBaseUrl: BASE,
    });
    expect(email.subject).toBe("Vibe Socials: 1 workspace needs attention");
  });

  it("uses the plural subject for several workspaces", () => {
    const email = buildProblemDigestEmail({
      workspaces: [
        workspace({ workspaceId: "a", name: "A", waitingForApproval: 1 }),
        workspace({ workspaceId: "b", name: "B", needsReconnect: ["x"] }),
      ],
      appBaseUrl: BASE,
    });
    expect(email.subject).toBe("Vibe Socials: 2 workspaces need attention");
    expect(email.html).toContain("A");
    expect(email.html).toContain("B");
  });

  it("writes a line for failed posts with the platform names", () => {
    const many = buildProblemDigestEmail({
      workspaces: [workspace({ failedPosts: 3, failedPlatforms: ["x", "instagram"] })],
      appBaseUrl: BASE,
    });
    expect(many.html).toContain("3 posts failed on X and Instagram");

    const one = buildProblemDigestEmail({
      workspaces: [workspace({ failedPosts: 1, failedPlatforms: ["linkedin"] })],
      appBaseUrl: BASE,
    });
    expect(one.html).toContain("1 post failed on LinkedIn");

    const three = buildProblemDigestEmail({
      workspaces: [workspace({ failedPosts: 4, failedPlatforms: ["x", "linkedin", "tiktok"] })],
      appBaseUrl: BASE,
    });
    expect(three.html).toContain("4 posts failed on X, LinkedIn and TikTok");
  });

  it("writes a line for connections that need reconnecting", () => {
    const one = buildProblemDigestEmail({
      workspaces: [workspace({ needsReconnect: ["linkedin"] })],
      appBaseUrl: BASE,
    });
    expect(one.html).toContain("LinkedIn needs reconnecting");

    const two = buildProblemDigestEmail({
      workspaces: [workspace({ needsReconnect: ["linkedin", "x"] })],
      appBaseUrl: BASE,
    });
    expect(two.html).toContain("LinkedIn and X need reconnecting");
  });

  it("writes a line for posts waiting for approval", () => {
    const two = buildProblemDigestEmail({
      workspaces: [workspace({ waitingForApproval: 2 })],
      appBaseUrl: BASE,
    });
    expect(two.html).toContain("2 posts are waiting for your approval");

    const one = buildProblemDigestEmail({
      workspaces: [workspace({ waitingForApproval: 1 })],
      appBaseUrl: BASE,
    });
    expect(one.html).toContain("1 post is waiting for your approval");
  });

  it("leaves out the lines for problems a workspace does not have", () => {
    const email = buildProblemDigestEmail({
      workspaces: [workspace({ waitingForApproval: 2 })],
      appBaseUrl: BASE,
    });
    expect(email.html).not.toContain("failed on");
    expect(email.html).not.toContain("reconnecting");
  });

  it("links once to the workspaces page and says where to turn the email off", () => {
    const email = buildProblemDigestEmail({
      workspaces: [workspace({ waitingForApproval: 1 })],
      appBaseUrl: "https://vibesocials.wtf/",
    });
    expect(email.html.match(/<a /g)).toHaveLength(1);
    expect(email.html).toContain('href="https://vibesocials.wtf/workspaces"');
    expect(email.html).not.toContain("wtf//workspaces");
    expect(email.html).toContain("Settings, Notifications");
  });

  it("renders without a link when there is no base URL", () => {
    const email = buildProblemDigestEmail({
      workspaces: [workspace({ waitingForApproval: 1 })],
      appBaseUrl: null,
    });
    expect(email.html).not.toContain("<a ");
  });

  it("escapes a workspace name containing <", () => {
    const email = buildProblemDigestEmail({
      workspaces: [workspace({ name: "<img src=x onerror=alert(1)> & Co", waitingForApproval: 1 })],
      appBaseUrl: BASE,
    });
    expect(email.html).not.toContain("<img");
    expect(email.html).toContain("&lt;img src=x onerror=alert(1)&gt; &amp; Co");
  });
});
