import { describe, expect, it } from "vitest";

import { htmlToPlainText } from "@/server/notifications/plainText";

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
});
