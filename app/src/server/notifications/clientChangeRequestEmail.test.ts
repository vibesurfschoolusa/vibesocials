import { describe, expect, it } from "vitest";

import { buildClientChangeRequestEmail } from "./clientChangeRequestEmail";

const base = {
  workspaceId: "ws_1",
  workspaceName: "Surf Co",
  timeZone: null,
  scheduledFor: new Date("2026-11-12T15:00:00Z"),
  caption: "Dawn patrol tomorrow",
  note: "Use the other photo",
  appUrl: "https://app.example",
};

describe("buildClientChangeRequestEmail", () => {
  it("names the workspace in the subject and carries the date, caption, note and Queue link", () => {
    const email = buildClientChangeRequestEmail(base);

    expect(email.subject).toBe("Surf Co: your client asked for a change");
    expect(email.html).toContain("Thu, Nov 12, 2026, 3:00 PM UTC");
    expect(email.html).toContain("Dawn patrol tomorrow");
    expect(email.html).toContain("Use the other photo");
    expect(email.html).toContain('href="https://app.example/go?w=ws_1&amp;to=%2Fqueue"');
  });

  it("shows the time in the owner's own time zone when it is known (F4)", () => {
    const email = buildClientChangeRequestEmail({ ...base, timeZone: "America/New_York" });
    expect(email.html).toContain("Thu, Nov 12, 2026, 10:00 AM EST");
    expect(email.html).not.toContain("UTC");
  });

  it("shows only the first 100 characters of the caption", () => {
    const caption = `${"a".repeat(100)}TAIL`;
    const { html } = buildClientChangeRequestEmail({ ...base, caption });
    expect(html).toContain("a".repeat(100));
    expect(html).not.toContain("TAIL");
  });

  // R22 client-journey L4: a cut caption says so, and an emoji is never split.
  it("ends a cut caption with an ellipsis, cut between whole characters", () => {
    const caption = `${"a".repeat(99)}🏄‍♂️🌊TAIL`;
    const { html } = buildClientChangeRequestEmail({ ...base, caption });
    expect(html).toContain(`<strong>Caption:</strong> ${"a".repeat(99)}🏄‍♂️…</p>`);
  });

  it("a caption of 100 characters or fewer has no ellipsis", () => {
    const caption = "b".repeat(100);
    const { html } = buildClientChangeRequestEmail({ ...base, caption });
    expect(html).toContain(`<strong>Caption:</strong> ${caption}</p>`);
  });

  it("escapes every value", () => {
    const { html } = buildClientChangeRequestEmail({
      ...base,
      workspaceName: "<i>Surf</i>",
      caption: '<script>alert("c")</script>',
      note: "<img src=x onerror=alert(1)> & 'quotes'",
      appUrl: 'https://app.example"><b>',
    });

    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<i>Surf");
    expect(html).not.toContain('"><b>');
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt; &amp; &#39;quotes&#39;");
  });

  it("for a post without a Story, says it will not go out (as before)", () => {
    const { html } = buildClientChangeRequestEmail(base);
    expect(html).toContain("a change to a post in <strong>Surf Co</strong>. It is out of the schedule and will not go out until you schedule it again.");
    expect(html).not.toContain("Story");
  });

  it("for a Feed and Story post, speaks of the post and its Story together (F6)", () => {
    const { subject, html } = buildClientChangeRequestEmail({ ...base, withStory: true });
    expect(subject).toBe("Surf Co: your client asked for a change");
    expect(html).toContain(
      "a change to a post and its Story in <strong>Surf Co</strong>. Both are out of the schedule and will not go out until you schedule them again.",
    );
  });

  it("says so when the post has no time", () => {
    const { html } = buildClientChangeRequestEmail({ ...base, scheduledFor: null });
    expect(html).toContain("No time set");
  });
});
