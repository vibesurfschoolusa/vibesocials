import { describe, expect, it } from "vitest";

import { htmlToPlainText } from "./plainText";

import {
  buildApprovalDecisionEmail,
  buildApprovalRequestedEmail,
} from "./approvalEmail";

describe("buildApprovalRequestedEmail", () => {
  const email = buildApprovalRequestedEmail({
    submitterName: "Sam",
    workspaceId: "ws_1",
    workspaceName: "Klaus Schroder's workspace",
    timeZone: null,
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

  it("links to the Queue through /go, so it opens this workspace (F4)", () => {
    expect(email.html).toContain('href="https://vibesocials.wtf/go?w=ws_1&amp;to=%2Fqueue"');
  });

  it("escapes HTML in the caption and names", () => {
    const evil = buildApprovalRequestedEmail({
      submitterName: "<img src=x onerror=alert(1)>",
      workspaceId: "ws_1",
      workspaceName: "W",
      timeZone: null,
      caption: "<script>bad()</script>",
      appBaseUrl: null,
    });
    expect(evil.html).not.toContain("<img");
    expect(evil.html).not.toContain("<script>");
  });

  it("renders without a link when appBaseUrl is null", () => {
    const noLink = buildApprovalRequestedEmail({
      submitterName: "Sam",
      workspaceId: "ws_1",
      workspaceName: "W",
      timeZone: null,
      caption: "hi",
      appBaseUrl: null,
    });
    expect(noLink.html).not.toContain("<a ");
    expect(noLink.html).toMatch(/queue/i);
  });

  it("trims a trailing slash off appBaseUrl", () => {
    const trimmed = buildApprovalRequestedEmail({
      submitterName: "Sam",
      workspaceId: "ws_1",
      workspaceName: "W",
      timeZone: null,
      caption: "hi",
      appBaseUrl: "https://vibesocials.wtf/",
    });
    expect(trimmed.html).toContain("https://vibesocials.wtf/go?w=ws_1");
    expect(trimmed.html).not.toContain("wtf//go");
  });

  // 2026-11-01 audit (M1): the owner approves what publishes, including the
  // per-platform texts that replace the base caption on those platforms.
  describe("platform-specific captions (2026-11-01 audit, M1)", () => {
    const base = {
      submitterName: "Sam",
      workspaceId: "ws_1",
      workspaceName: "W",
      timeZone: null,
      caption: "Happy Friday from the team!",
      appBaseUrl: null,
    };

    it("lists each platform's text under a 'Platform-specific captions' heading", () => {
      const withOverrides = buildApprovalRequestedEmail({
        ...base,
        platformCaptions: { linkedin: "Hidden text", x: "Short X text" },
      });
      expect(withOverrides.html).toContain("Platform-specific captions");
      expect(withOverrides.html).toContain("LinkedIn");
      expect(withOverrides.html).toContain("Hidden text");
      expect(withOverrides.html).toContain("Short X text");
    });

    it("HTML-escapes the per-platform text and never truncates it", () => {
      const long = `${"a".repeat(300)} tail-end`;
      const evil = buildApprovalRequestedEmail({
        ...base,
        platformCaptions: { linkedin: "<b>bold</b> & <script>bad()</script>", x: long },
      });
      expect(evil.html).toContain("&lt;b&gt;bold&lt;/b&gt;");
      expect(evil.html).not.toContain("<b>bold</b>");
      expect(evil.html).not.toContain("<script>");
      // The base caption preview is cut at 240 characters; a per-platform text
      // is the thing being reviewed, so it is shown whole.
      expect(evil.html).toContain("tail-end");
    });

    it("lists platforms in the app's display order (X before LinkedIn)", () => {
      const html = buildApprovalRequestedEmail({
        ...base,
        platformCaptions: { linkedin: "L text", x: "X text" },
      }).html;
      expect(html.indexOf("X text")).toBeLessThan(html.indexOf("L text"));
    });

    it("omits the section when there are none (null, undefined or empty)", () => {
      for (const platformCaptions of [null, undefined, {}]) {
        const html = buildApprovalRequestedEmail({ ...base, platformCaptions }).html;
        expect(html).not.toContain("Platform-specific captions");
      }
    });
  });
});

describe("buildApprovalDecisionEmail", () => {
  it("tells the member their post was approved and what happens next", () => {
    const approved = buildApprovalDecisionEmail({
      approved: true,
      workspaceId: "ws_1",
      workspaceName: "Acme",
      timeZone: null,
      caption: "Friday promo",
      scheduledFor: "2026-07-31T14:30:00.000Z",
      appBaseUrl: "https://vibesocials.wtf",
    });
    expect(approved.subject).toBe("Your post in Acme was approved");
    expect(approved.html).toContain("Friday promo");
    expect(approved.html).toMatch(/scheduled/i);
    expect(approved.html).toContain("Fri, Jul 31, 2026, 2:30 PM UTC");
    expect(approved.html).toContain('href="https://vibesocials.wtf/go?w=ws_1&amp;to=%2Factivity"');
  });

  it("shows the scheduled time in the member's own time zone (F4)", () => {
    const approved = buildApprovalDecisionEmail({
      approved: true,
      workspaceId: "ws_1",
      workspaceName: "Acme",
      timeZone: "America/Los_Angeles",
      caption: "Friday promo",
      scheduledFor: "2026-07-31T14:30:00.000Z",
      appBaseUrl: null,
    });
    expect(approved.html).toContain("Fri, Jul 31, 2026, 7:30 AM PDT");
  });

  // R26 LL3 item 6: a rejected post is cancelled, so it is no longer in the
  // Queue; the email sends the member to Create and says where the post is.
  it("links a rejection to Create through /go, and names Activity", () => {
    const rejected = buildApprovalDecisionEmail({
      approved: false,
      workspaceId: "ws_2",
      workspaceName: "Acme",
      timeZone: null,
      caption: "x",
      scheduledFor: null,
      appBaseUrl: "https://vibesocials.wtf",
    });
    expect(rejected.html).toContain('href="https://vibesocials.wtf/go?w=ws_2&amp;to=%2Fposts%2Fnew"');
    expect(rejected.html).toContain(">Create a new version</a>");
    expect(rejected.html).toContain("You can still find this post in Activity.");
    expect(rejected.html).not.toMatch(/queue/i);
  });

  it("without a base URL, a rejection says where to go in words", () => {
    const rejected = buildApprovalDecisionEmail({
      approved: false,
      workspaceId: "ws_2",
      workspaceName: "Acme",
      timeZone: null,
      caption: "x",
      scheduledFor: null,
      appBaseUrl: null,
    });
    expect(rejected.html).not.toContain("<a ");
    expect(rejected.html).toContain(
      "<p>Open Create in Vibe Socials to start a new version. You can still find this post in Activity.</p>",
    );
    expect(rejected.html).not.toMatch(/queue/i);
  });

  it("says publishing now when an approved post had no scheduled time", () => {
    const approved = buildApprovalDecisionEmail({
      approved: true,
      workspaceId: "ws_1",
      workspaceName: "Acme",
      timeZone: null,
      caption: "Now post",
      scheduledFor: null,
      appBaseUrl: null,
    });
    expect(approved.html).toMatch(/publishing now/i);
  });

  it("tells the member their post was not approved, without blaming them", () => {
    const rejected = buildApprovalDecisionEmail({
      approved: false,
      workspaceId: "ws_1",
      workspaceName: "Acme",
      timeZone: null,
      caption: "Friday promo",
      scheduledFor: null,
      appBaseUrl: null,
    });
    expect(rejected.subject).toBe("Your post in Acme wasn't approved");
    expect(rejected.html).toMatch(/will not be published/i);
  });

  it("escapes HTML in the caption", () => {
    const evil = buildApprovalDecisionEmail({
      approved: false,
      workspaceId: "ws_1",
      workspaceName: "W",
      timeZone: null,
      caption: "<script>bad()</script>",
      scheduledFor: null,
      appBaseUrl: null,
    });
    expect(evil.html).not.toContain("<script>");
  });
});

// 11 polish: a held series is one email, and it says so.
describe("buildApprovalRequestedEmail - a series", () => {
  const base = {
    submitterName: "Sam",
    workspaceId: "ws_1",
    workspaceName: "Acme",
    timeZone: null,
    caption: "Book your lesson",
    appBaseUrl: null,
  };
  const LINE =
    "This post repeats: 4 posts from Thursday, November 12, 2026 (UTC) to Thursday, December 3, 2026 (UTC). Each one needs its own approval in the Queue.";

  it("adds one line with the count and the first and last dates in UTC", () => {
    const email = buildApprovalRequestedEmail({
      ...base,
      series: {
        count: 4,
        first: new Date("2026-11-12T09:00:00.000Z"),
        last: new Date("2026-12-03T09:00:00.000Z"),
      },
    });
    expect(email.html).toContain(`<p>${LINE}</p>`);
  });

  it("writes the owner's own days when their zone is known (F4)", () => {
    const email = buildApprovalRequestedEmail({
      ...base,
      timeZone: "Europe/Berlin",
      series: {
        count: 2,
        first: new Date("2026-11-12T23:30:00.000Z"),
        last: new Date("2026-11-19T23:30:00.000Z"),
      },
    });
    expect(email.html).toContain("from Friday, November 13, 2026 to Friday, November 20, 2026.");
  });

  it("writes the UTC date even when the local day differs", () => {
    const email = buildApprovalRequestedEmail({
      ...base,
      series: {
        count: 2,
        first: new Date("2026-11-12T23:30:00.000Z"),
        last: new Date("2026-11-19T23:30:00.000Z"),
      },
    });
    expect(email.html).toContain("from Thursday, November 12, 2026 (UTC) to Thursday, November 19, 2026 (UTC)");
  });

  it("a single held post's email is unchanged", () => {
    expect(buildApprovalRequestedEmail(base).html).not.toContain("repeats");
  });
});

// Q1 fix 1: a held Feed and Story post says so. R3-client-journey M1: the Queue
// shows the pair as one card, and one decision takes both halves.
describe("buildApprovalRequestedEmail - Feed and Story", () => {
  const base = { submitterName: "Sam", workspaceId: "ws_1", workspaceName: "Acme", timeZone: null, caption: "Book your lesson", appBaseUrl: null };
  const line = (where: string) =>
    `<p>This post also goes out as a Story on ${where}. Approving or rejecting the post decides the Story too.</p>`;

  it("Instagram", () => {
    expect(buildApprovalRequestedEmail({ ...base, alsoAsStory: ["instagram"] }).html).toContain(line("Instagram"));
  });

  it("Facebook", () => {
    expect(buildApprovalRequestedEmail({ ...base, alsoAsStory: ["facebook_page"] }).html).toContain(
      line("Facebook Page"),
    );
  });

  it("both platforms", () => {
    expect(buildApprovalRequestedEmail({ ...base, alsoAsStory: ["instagram", "facebook_page"] }).html).toContain(
      line("Instagram and Facebook Page"),
    );
  });

  it("no Story job: the email is unchanged", () => {
    const before = buildApprovalRequestedEmail(base);
    expect(buildApprovalRequestedEmail({ ...base, alsoAsStory: [] })).toEqual(before);
    expect(before.html).not.toContain("as a Story");
  });
});

// R3-client-journey M1: one decision on a Feed and Story card decides both
// halves, so the member gets one email, and it names the Story.
describe("buildApprovalDecisionEmail - Feed and Story", () => {
  const base = {
    workspaceId: "ws_1",
    workspaceName: "Acme",
    caption: "Book your lesson",
    scheduledFor: null,
    timeZone: null,
    appBaseUrl: null,
  };

  it("approved: says the Story was approved too", () => {
    expect(buildApprovalDecisionEmail({ ...base, approved: true, alsoAsStory: ["instagram"] }).html).toContain(
      "<p>Its Story on Instagram was approved too.</p>",
    );
  });

  it("rejected: says the Story will not be published either", () => {
    expect(
      buildApprovalDecisionEmail({ ...base, approved: false, alsoAsStory: ["instagram", "facebook_page"] }).html,
    ).toContain("<p>Its Story on Instagram and Facebook Page will not be published either.</p>");
  });

  it("no Story: the email is unchanged", () => {
    for (const approved of [true, false]) {
      const before = buildApprovalDecisionEmail({ ...base, approved });
      expect(buildApprovalDecisionEmail({ ...base, approved, alsoAsStory: [] })).toEqual(before);
      expect(before.html).not.toContain("Story");
    }
  });
});

// R9-client-journey L3: approved to publish now, then nothing went out.
describe("buildApprovalDecisionEmail - approved but nothing sent", () => {
  const base = {
    approved: true,
    workspaceId: "ws_1",
    workspaceName: "Acme",
    timeZone: null,
    caption: "Now post",
    scheduledFor: null,
    appBaseUrl: null,
  } as const;

  it("says the approval stands but nothing was sent, and why, instead of publishing now", () => {
    const email = buildApprovalDecisionEmail({ ...base, notSent: "none of this post's platforms is connected." });
    expect(email.subject).toBe("Your post in Acme was approved, but nothing was sent");
    expect(email.html).toContain("<p>Approved, but nothing was sent: none of this post&#39;s platforms is connected.</p>");
    expect(email.html).not.toMatch(/publishing now/i);
  });

  it("without a reason, is the usual approved email", () => {
    const email = buildApprovalDecisionEmail(base);
    expect(email.subject).toBe("Your post in Acme was approved");
    expect(email.html).toMatch(/publishing now/i);
  });
});

// R22 client-journey L2: the preview counts whole characters, so an emoji at
// the cut is never split into a broken character.
describe("the caption preview", () => {
  const params = {
    submitterName: "Sam",
    workspaceId: "ws_1",
    workspaceName: "Surf Co",
    timeZone: null,
    appBaseUrl: "https://vibesocials.wtf",
  };
  const quoted = (html: string) => /<blockquote[^>]*>([\s\S]*?)<\/blockquote>/.exec(html)![1];

  it("cuts after 240 whole characters, never inside an emoji, in both emails", () => {
    const caption = `${"a".repeat(239)}🏄‍♂️🌊 more`;
    const requested = quoted(buildApprovalRequestedEmail({ ...params, caption }).html);
    expect(requested).toBe(`${"a".repeat(239)}🏄‍♂️…`);
    expect(requested).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    const decided = quoted(
      buildApprovalDecisionEmail({ ...params, approved: false, caption, scheduledFor: null }).html,
    );
    expect(decided).toBe(`${"a".repeat(239)}🏄‍♂️…`);
  });

  it("a caption of 240 characters or fewer is shown whole, with no ellipsis", () => {
    const caption = `${"a".repeat(238)}🏄‍♂️🌊`;
    expect(quoted(buildApprovalRequestedEmail({ ...params, caption }).html)).toBe(caption);
  });
});

// R26 LL3 follow-up: approved to publish now, the hand-off failed and the
// results couldn't be marked, so the post shows as publishing for about two
// hours. The email says so instead of "send it again".
describe("approved, publishing not confirmed as stopped", () => {
  const email = buildApprovalDecisionEmail({
    approved: true,
    workspaceId: "ws_1",
    workspaceName: "Acme",
    timeZone: null,
    caption: "x",
    scheduledFor: null,
    appBaseUrl: "https://vibesocials.wtf",
    startUnconfirmed: true,
  });

  it("says it may still go out and not to send it again until it shows as failed (HTML and plain text)", () => {
    expect(email.html).toContain("<p>Approved, but publishing didn&#39;t start as it should, and the post may still go out. In Activity it can show as publishing for about two hours, sometimes a little longer, before it shows as failed. Don&#39;t send it again until it shows as failed; then send it again from there.</p>");
    expect(email.html).not.toMatch(/publishing now/i);
    expect(htmlToPlainText(email.html)).toContain("Approved, but publishing didn't start as it should, and the post may still go out. In Activity it can show as publishing for about two hours, sometimes a little longer, before it shows as failed. Don't send it again until it shows as failed; then send it again from there.");
    expect(email.subject).toBe("Your post in Acme was approved, but publishing may not have started");
  });
});
