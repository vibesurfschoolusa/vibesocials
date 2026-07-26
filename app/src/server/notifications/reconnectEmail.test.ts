import { describe, expect, it } from "vitest";

import { buildReconnectEmail } from "./reconnectEmail";

describe("buildReconnectEmail", () => {
  const email = buildReconnectEmail({
    platformLabel: "Google Business Profile",
    workspaceName: "Klaus Schroder's workspace",
    appBaseUrl: "https://vibesocials.wtf",
  });

  it("names the platform in the subject", () => {
    expect(email.subject).toBe(
      "Action needed: reconnect Google Business Profile on Vibe Socials",
    );
  });

  it("says which workspace is affected and links to settings", () => {
    expect(email.html).toContain("Klaus Schroder&#39;s workspace");
    expect(email.html).toContain("https://vibesocials.wtf/settings");
  });

  it("explains the consequence (posts will fail) in plain language", () => {
    expect(email.html).toMatch(/posts to Google Business Profile will fail/i);
  });

  it("trims a trailing slash off appBaseUrl (postOutcomeEmail convention)", () => {
    const trimmed = buildReconnectEmail({
      platformLabel: "X",
      workspaceName: "W",
      appBaseUrl: "https://vibesocials.wtf/",
    });
    expect(trimmed.html).toContain("https://vibesocials.wtf/settings");
    expect(trimmed.html).not.toContain("wtf//settings");
  });

  it("renders without a link when appBaseUrl is null", () => {
    const noLink = buildReconnectEmail({
      platformLabel: "X",
      workspaceName: "W",
      appBaseUrl: null,
    });
    expect(noLink.html).not.toContain("<a ");
    expect(noLink.html).toMatch(/reconnect x in settings/i);
  });

  it("escapes HTML in the workspace name", () => {
    const evil = buildReconnectEmail({
      platformLabel: "X",
      workspaceName: '<img src=x onerror=alert(1)>',
      appBaseUrl: null,
    });
    expect(evil.html).not.toContain("<img");
  });
});
