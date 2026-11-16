import { describe, expect, it } from "vitest";

import { htmlToPlainText } from "./plainText";
import { buildExpiryWarningEmail, buildReconnectEmail } from "./reconnectEmail";

describe("buildReconnectEmail", () => {
  const email = buildReconnectEmail({
    platformLabel: "Google Business Profile",
    workspaceId: "ws_1",
    workspaceName: "Klaus Schroder's workspace",
    appBaseUrl: "https://vibesocials.wtf",
    clientLinks: {},
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
      clientLinks: {},
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
      clientLinks: {},
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
      clientLinks: {},
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
      clientLinks: {},
    });
    expect(evil.html).not.toContain("<img");
  });

  // R5-client-journey L4: an agency's client often connected the account through
  // a connect link, and only they can connect it again.
  it("says to send the client a connect link, linked to Settings, Connections through /go", () => {
    expect(email.html).toContain("If your client connected it, send them a connect link from");
    expect(email.html).toContain(
      'href="https://vibesocials.wtf/go?w=ws_1&amp;to=%2Fsettings%23connect-link">Settings, Connections</a>.',
    );
  });

  it("names Settings, Connections without a link when appBaseUrl is null", () => {
    const noLink = buildReconnectEmail({ platformLabel: "X", workspaceId: "ws_1", workspaceName: "W", appBaseUrl: null, clientLinks: {} });
    expect(noLink.html).toContain("If your client connected it, send them a connect link from Settings, Connections.");
  });

  // R5-publishing M1: a connection flagged by a failed post (a Graph 190, a 401)
  // gets this email too, so it no longer speaks of a renewal that never happened.
  it("says the platform no longer accepts the sign-in", () => {
    expect(email.html).toContain(
      "has stopped working: Google Business Profile no longer accepts its sign-in, which usually means access was removed or the sign-in expired.",
    );
    expect(email.html).not.toContain("renewal");
  });

  it("an expired sign-in that cannot be renewed says so", () => {
    const expired = buildReconnectEmail({
      platformLabel: "LinkedIn",
      workspaceId: "ws_1",
      workspaceName: "Acme",
      appBaseUrl: null,
      clientLinks: {},
      reason: "expired",
    });
    expect(expired.html).toContain(
      "The LinkedIn connection in <strong>Acme</strong> has stopped working: its sign-in expired, and LinkedIn does not let us renew it automatically.",
    );
    expect(expired.subject).toBe("Action needed: reconnect LinkedIn in Acme");
  });
});

// R5-publishing M1: LinkedIn gives this app no refresh token, so its 60-day
// sign-in ends on a known date. The owners hear a week before.
describe("buildExpiryWarningEmail", () => {
  const params = {
    platformLabel: "LinkedIn",
    workspaceId: "ws_1",
    workspaceName: "Surf & Co",
    expiresAt: new Date("2026-11-20T15:30:00.000Z"),
    timeZone: "America/New_York",
    appBaseUrl: "https://vibesocials.wtf",
    clientLinks: {},
  };
  const email = buildExpiryWarningEmail(params);

  it("subject: '<Platform> needs reconnecting by <date>' and the workspace", () => {
    expect(email.subject).toBe("LinkedIn needs reconnecting by Friday, November 20, 2026 (Surf & Co)");
  });

  it("dates it in the owner's time zone, and labels UTC when the zone is unknown", () => {
    expect(email.html).toContain("Fri, Nov 20, 2026, 10:30 AM EST");
    const utc = buildExpiryWarningEmail({ ...params, timeZone: null });
    expect(utc.subject).toBe("LinkedIn needs reconnecting by Friday, November 20, 2026 (UTC) (Surf & Co)");
    expect(utc.html).toContain("3:30 PM UTC");
  });

  it("says what happens, why, and what to do: reconnect, or send the client a connect link", () => {
    expect(email.html).toContain("The LinkedIn connection in <strong>Surf &amp; Co</strong> stops working on");
    expect(email.html).toContain("LinkedIn does not let us renew this sign-in automatically");
    expect(email.html).toContain("posts to LinkedIn will fail");
    expect(email.html).toContain(
      'href="https://vibesocials.wtf/go?w=ws_1&amp;to=%2Fsettings%23connections">Reconnect LinkedIn in Settings</a>',
    );
    expect(email.html).toContain("If your client connected it, send them a connect link from");
    expect(email.html).toContain('to=%2Fsettings%23connect-link">Settings, Connections</a>.');
  });

  it("renders without links when appBaseUrl is null, and escapes the workspace name", () => {
    const plain = buildExpiryWarningEmail({ ...params, appBaseUrl: null, workspaceName: "<b>x</b>" });
    expect(plain.html).not.toContain("<a ");
    expect(plain.html).not.toContain("<b>x</b>");
    expect(plain.html).toContain("Reconnect LinkedIn in Settings");
  });

  it("keeps a line break in the workspace name out of the subject", () => {
    expect(buildExpiryWarningEmail({ ...params, workspaceName: "Surf\r\nCo" }).subject).toBe(
      "LinkedIn needs reconnecting by Friday, November 20, 2026 (Surf Co)",
    );
  });
});

// R24 pages L4: the client line follows what the Settings connect-link group
// shows (clientLinkPanelStatus), so an owner without client links is not told
// to send one. The plain-text part is made from this HTML (sendEmail).
describe("the client line, by what Settings offers", () => {
  const PLAN_LINE =
    "If your client connected it, they need a connect link to connect it again, and connect links are part of the Growth and Pro plans. See Settings, Plan.";
  const BLOCKED =
    "Client links don't work right now. Your free trial has ended. Choose Growth or Pro in Settings and your client links work again, or contact help@example.com.";
  const PAUSED = "Client links don't work right now. This workspace is paused. Contact help@example.com.";
  const reconnect = (clientLinks: { pausedByPlan?: true; workspaceBlocked?: string }, appBaseUrl: string | null = "https://vibesocials.wtf") =>
    buildReconnectEmail({ platformLabel: "LinkedIn", workspaceId: "ws_1", workspaceName: "Acme", appBaseUrl, clientLinks });
  const expiry = (clientLinks: { pausedByPlan?: true; workspaceBlocked?: string }, appBaseUrl: string | null = "https://vibesocials.wtf") =>
    buildExpiryWarningEmail({
      platformLabel: "LinkedIn",
      workspaceId: "ws_1",
      workspaceName: "Acme",
      expiresAt: new Date("2026-11-20T15:30:00.000Z"),
      timeZone: null,
      appBaseUrl,
      clientLinks,
    });

  for (const [name, build] of [["reconnect", reconnect], ["expiry warning", expiry]] as const) {
    it(`${name}: links on (billing off, or Growth): today's line`, () => {
      const text = htmlToPlainText(build({}).html);
      expect(text).toContain(
        "If your client connected it, send them a connect link from Settings, Connections: https://vibesocials.wtf/go?w=ws_1&to=%2Fsettings%23connect-link.",
      );
      expect(text).not.toContain("Growth and Pro");
    });

    it(`${name}: a plan without client links (Starter): the plan line, linked to Settings, Plan`, () => {
      const email = build({ pausedByPlan: true });
      expect(email.html).toContain('href="https://vibesocials.wtf/go?w=ws_1&amp;to=%2Fsettings%23plan">Settings, Plan</a>');
      expect(email.html).not.toContain("send them a connect link");
      expect(htmlToPlainText(email.html)).toContain(
        "If your client connected it, they need a connect link to connect it again, and connect links are part of the Growth and Pro plans. See Settings, Plan: https://vibesocials.wtf/go?w=ws_1&to=%2Fsettings%23plan.",
      );
      expect(htmlToPlainText(build({ pausedByPlan: true }, null).html)).toContain(PLAN_LINE);
    });

    it(`${name}: an ended trial or a pause: the Settings panel's sentence`, () => {
      for (const blocked of [BLOCKED, PAUSED]) {
        const email = build({ workspaceBlocked: blocked, pausedByPlan: true });
        const text = htmlToPlainText(email.html);
        expect(text).toContain(`If your client connected it, they need a connect link to connect it again. ${blocked}`);
        expect(text).not.toContain("send them a connect link");
        expect(text).not.toContain("Growth and Pro plans");
      }
    });
  }
});
