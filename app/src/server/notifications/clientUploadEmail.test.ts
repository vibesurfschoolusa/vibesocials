import { describe, expect, it } from "vitest";

import { buildClientUploadEmail } from "./clientUploadEmail";

describe("buildClientUploadEmail", () => {
  it("names the sender and the workspace, says the files are in Media and links there", () => {
    const email = buildClientUploadEmail({
      senderName: "Ana",
      workspaceName: "Surf Co",
      appUrl: "https://vibesocials.wtf",
    });

    expect(email.subject).toBe("Ana sent files to Surf Co");
    expect(email.html).toContain("They are in Media.");
    expect(email.html).toContain('href="https://vibesocials.wtf/media"');
  });

  it("says 'Your client' when no name was given", () => {
    const email = buildClientUploadEmail({ senderName: null, workspaceName: "Surf Co", appUrl: "" });
    expect(email.subject).toBe("Your client sent files to Surf Co");
    expect(email.html).toContain('href="/media"');
  });

  it("escapes the sender's name and the workspace name in the HTML", () => {
    const email = buildClientUploadEmail({
      senderName: '<img src=x onerror="alert(1)">',
      workspaceName: "Tom & Jerry's <b>",
      appUrl: "https://vibesocials.wtf",
    });

    expect(email.html).not.toContain("<img");
    expect(email.html).not.toContain("<b>");
    expect(email.html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
    expect(email.html).toContain("Tom &amp; Jerry&#39;s &lt;b&gt;");
  });
});
