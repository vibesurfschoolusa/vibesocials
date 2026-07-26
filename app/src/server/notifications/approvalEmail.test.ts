import { describe, expect, it } from "vitest";

import {
  buildApprovalDecisionEmail,
  buildApprovalRequestedEmail,
} from "./approvalEmail";

describe("buildApprovalRequestedEmail", () => {
  const email = buildApprovalRequestedEmail({
    submitterName: "Sam",
    workspaceName: "Klaus Schroder's workspace",
    caption: "Sunset session this Friday",
    appBaseUrl: "https://vibesocials.wtf",
  });

  it("says a post needs review and names the workspace", () => {
    expect(email.subject).toBe("A post needs your approval in Klaus Schroder's workspace");
  });

  it("names the submitter and quotes the caption", () => {
    expect(email.html).toContain("Sam");
    expect(email.html).toContain("Sunset session this Friday");
  });

  it("links to the Queue", () => {
    expect(email.html).toContain("https://vibesocials.wtf/queue");
  });

  it("escapes HTML in the caption and names", () => {
    const evil = buildApprovalRequestedEmail({
      submitterName: "<img src=x onerror=alert(1)>",
      workspaceName: "W",
      caption: "<script>bad()</script>",
      appBaseUrl: null,
    });
    expect(evil.html).not.toContain("<img");
    expect(evil.html).not.toContain("<script>");
  });

  it("renders without a link when appBaseUrl is null", () => {
    const noLink = buildApprovalRequestedEmail({
      submitterName: "Sam",
      workspaceName: "W",
      caption: "hi",
      appBaseUrl: null,
    });
    expect(noLink.html).not.toContain("<a ");
    expect(noLink.html).toMatch(/queue/i);
  });

  it("trims a trailing slash off appBaseUrl", () => {
    const trimmed = buildApprovalRequestedEmail({
      submitterName: "Sam",
      workspaceName: "W",
      caption: "hi",
      appBaseUrl: "https://vibesocials.wtf/",
    });
    expect(trimmed.html).toContain("https://vibesocials.wtf/queue");
    expect(trimmed.html).not.toContain("wtf//queue");
  });
});

describe("buildApprovalDecisionEmail", () => {
  it("tells the member their post was approved and what happens next", () => {
    const approved = buildApprovalDecisionEmail({
      approved: true,
      workspaceName: "Acme",
      caption: "Friday promo",
      scheduledFor: "2026-07-31T14:30:00.000Z",
      appBaseUrl: "https://vibesocials.wtf",
    });
    expect(approved.subject).toBe("Your post was approved");
    expect(approved.html).toContain("Friday promo");
    expect(approved.html).toMatch(/scheduled/i);
  });

  it("says publishing now when an approved post had no scheduled time", () => {
    const approved = buildApprovalDecisionEmail({
      approved: true,
      workspaceName: "Acme",
      caption: "Now post",
      scheduledFor: null,
      appBaseUrl: null,
    });
    expect(approved.html).toMatch(/publishing now/i);
  });

  it("tells the member their post was not approved, without blaming them", () => {
    const rejected = buildApprovalDecisionEmail({
      approved: false,
      workspaceName: "Acme",
      caption: "Friday promo",
      scheduledFor: null,
      appBaseUrl: null,
    });
    expect(rejected.subject).toBe("Your post wasn't approved");
    expect(rejected.html).toMatch(/will not be published/i);
  });

  it("escapes HTML in the caption", () => {
    const evil = buildApprovalDecisionEmail({
      approved: false,
      workspaceName: "W",
      caption: "<script>bad()</script>",
      scheduledFor: null,
      appBaseUrl: null,
    });
    expect(evil.html).not.toContain("<script>");
  });
});
