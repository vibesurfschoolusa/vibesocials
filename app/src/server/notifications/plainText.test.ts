import { describe, expect, it } from "vitest";

import { buildFreeRunCeilingEmail } from "@/server/notifications/freeRunCeilingEmail";
import { htmlToPlainText } from "@/server/notifications/plainText";
import { buildReconnectEmail } from "@/server/notifications/reconnectEmail";

describe("htmlToPlainText", () => {
  it("turns paragraphs, lists and links into readable text", () => {
    const html = [
      "<div>",
      "<h1>Your post finished</h1>",
      "<p>In <strong>Acme &amp; Co</strong>.</p>",
      "<ul><li>X: Succeeded</li><li>YouTube: Failed — &quot;quota&quot;</li></ul>",
      '<p><a href="https://app.example.com/go?w=1&amp;to=%2Factivity">View in Activity</a></p>',
      "</div>",
    ].join("\n");
    expect(htmlToPlainText(html)).toBe(
      [
        "Your post finished",
        "",
        "In Acme & Co.",
        "",
        "- X: Succeeded",
        "- YouTube: Failed — \"quota\"",
        "",
        "View in Activity: https://app.example.com/go?w=1&to=%2Factivity",
      ].join("\n"),
    );
  });

  it("keeps line breaks, quotes and the text of a link that is its own address", () => {
    const html =
      '<p>One<br>Two</p>\n<blockquote style="x">It&#39;s &lt;fine&gt;</blockquote>\n<p><a href="https://a.example">https://a.example</a></p>';
    expect(htmlToPlainText(html)).toBe("One\nTwo\n\nIt's <fine>\n\nhttps://a.example");
  });

  it("drops images", () => {
    expect(htmlToPlainText('<img src="https://x/logo.png" alt="Acme"><p>Hi</p>')).toBe("Hi");
  });

  // R24 pages L5: a table's cells ran together ("OwnerPosts", "owner@shop.com12").
  it("separates table cells and ends each row on its own line", () => {
    const email = buildFreeRunCeilingEmail({
      day: new Date("2026-11-14T12:00:00Z"),
      topOwners: [
        { email: "owner@shop.com", runs: 12 },
        { email: "b@x.example", runs: 3 },
      ],
    });
    expect(htmlToPlainText(email.html)).toContain(
      "The owners with the most free posts today:\n\nOwner | Posts\nowner@shop.com | 12\nb@x.example | 3\n\nIf one of these",
    );
  });

  it("an email without a table reads exactly as before", () => {
    const html = buildReconnectEmail({
      platformLabel: "LinkedIn",
      workspaceId: "ws_1",
      workspaceName: "Acme & Co",
      appBaseUrl: "https://vibesocials.wtf",
      clientLinks: {},
    }).html;
    expect(htmlToPlainText(html)).toBe(
      [
        "The LinkedIn connection in Acme & Co has stopped working: LinkedIn no longer accepts its sign-in, which usually means access was removed or the sign-in expired.",
        "",
        "Until it is reconnected, new and scheduled posts to LinkedIn will fail.",
        "",
        "Reconnect LinkedIn in Settings: https://vibesocials.wtf/go?w=ws_1&to=%2Fsettings%23connections: it takes about a minute.",
        "",
        "If your client connected it, send them a connect link from Settings, Connections: https://vibesocials.wtf/go?w=ws_1&to=%2Fsettings%23connect-link.",
        "",
        "— Vibe Socials",
      ].join("\n"),
    );
  });
});
