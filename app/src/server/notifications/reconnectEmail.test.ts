import { describe, expect, it } from "vitest";

import { buildReconnectEmail } from "./reconnectEmail";

describe("buildReconnectEmail", () => {
  const email = buildReconnectEmail({
    platformLabel: "Google Business Profile",
    workspaceId: "ws_1",
    workspaceName: "Klaus Schroder's workspace",
    appBaseUrl: "https://vibesocials.wtf",
  });

  // R2-pages L5: an owner of several workspaces sees which one from the subject.
  it("names the platform and the workspace in the subject", () => {
    expect(email.subject).toBe(
      "Action needed: reconnect Google Business Profile in Klaus Schroder's workspace",
    );
  });

  it("keeps a line break in the workspace name out of the subject", () => {
    const broken = buildReconnectEmail({
      platformLabel: "X",
      workspaceId: "ws_1",
      workspaceName: "Surf\r\nCo",
      appBaseUrl: null,
    });
    expect(broken.subject).toBe("Action needed: reconnect X in Surf Co");
  });

  it("says which workspace is affected and links to settings", () => {
    expect(email.html).toContain("Klaus Schroder&#39;s workspace");
    expect(email.html).toContain('href="https://vibesocials.wtf/go?w=ws_1&amp;to=%2Fsettings%23connections"');
  });

  it("explains the consequence (posts will fail) in plain language", () => {
    expect(email.html).toMatch(/posts to Google Business Profile will fail/i);
  });

  it("trims a trailing slash off appBaseUrl (postOutcomeEmail convention)", () => {
    const trimmed = buildReconnectEmail({
      platformLabel: "X",
      workspaceId: "ws_1",
      workspaceName: "W",
      appBaseUrl: "https://vibesocials.wtf/",
    });
    expect(trimmed.html).toContain("https://vibesocials.wtf/go?w=ws_1");
    expect(trimmed.html).not.toContain("wtf//go");
  });

  it("renders without a link when appBaseUrl is null", () => {
    const noLink = buildReconnectEmail({
      platformLabel: "X",
      workspaceId: "ws_1",
      workspaceName: "W",
      appBaseUrl: null,
    });
    expect(noLink.html).not.toContain("<a ");
    expect(noLink.html).toMatch(/reconnect x in settings/i);
  });

  it("escapes HTML in the workspace name", () => {
    const evil = buildReconnectEmail({
      platformLabel: "X",
      workspaceId: "ws_1",
      workspaceName: '<img src=x onerror=alert(1)>',
      appBaseUrl: null,
    });
    expect(evil.html).not.toContain("<img");
  });
});
