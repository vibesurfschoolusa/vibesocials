import { describe, expect, it } from "vitest";

import { buildClientChangeRequestEmail } from "./clientChangeRequestEmail";

const base = {
  workspaceName: "Surf Co",
  scheduledFor: new Date("2026-11-12T15:00:00Z"),
  caption: "Dawn patrol tomorrow",
  note: "Use the other photo",
  appUrl: "https://app.example",
};

describe("buildClientChangeRequestEmail", () => {
  it("names the workspace in the subject and carries the date, caption, note and Queue link", () => {
    const email = buildClientChangeRequestEmail(base);

    expect(email.subject).toBe("Surf Co: your client asked for a change");
    expect(email.html).toContain("Nov 12, 2026");
    expect(email.html).toContain("UTC");
    expect(email.html).toContain("Dawn patrol tomorrow");
    expect(email.html).toContain("Use the other photo");
    expect(email.html).toContain('href="https://app.example/queue"');
  });

  it("shows only the first 100 characters of the caption", () => {
    const caption = `${"a".repeat(100)}TAIL`;
    const { html } = buildClientChangeRequestEmail({ ...base, caption });
    expect(html).toContain("a".repeat(100));
    expect(html).not.toContain("TAIL");
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

  it("says so when the post has no time", () => {
    const { html } = buildClientChangeRequestEmail({ ...base, scheduledFor: null });
    expect(html).toContain("No time set");
  });
});
