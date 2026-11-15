import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ClientPageShell } from "./client-page-header";

function render(props: Omit<Parameters<typeof ClientPageShell>[0], "children">): string {
  return renderToStaticMarkup(createElement(ClientPageShell, props as Parameters<typeof ClientPageShell>[0], createElement("p", null, "body")));
}

describe("ClientPageShell", () => {
  it("shows the workspace logo, name, title and the footer", () => {
    const html = render({
      workspace: { name: "Surf & Co", logoUrl: "https://x.example/logos/ws-1/a.png" },
      title: "Upcoming posts",
    });
    expect(html).toContain('src="https://x.example/logos/ws-1/a.png"');
    expect(html).toContain("Surf &amp; Co");
    expect(html).toMatch(/<h1[^>]*>Upcoming posts<\/h1>/);
    expect(html).toContain("Sent with Vibe Socials");
    expect(html).toContain('src="/icon.svg"');
    expect(html).toContain("body");
  });

  it("uses a tile with the initials when there is no logo", () => {
    const html = render({ workspace: { name: "surf co", logoUrl: null }, title: "T" });
    expect(html).not.toContain("<img src=\"https://");
    expect(html).toContain(">SC<");
  });

  // R11-pages L5: the inactive /c, /u, /v and /v/report pages have an h1 too.
  it("with no workspace (inactive link) shows the mark and product name only, the name as the page's h1", () => {
    const html = render({ workspace: null });
    expect(html).toMatch(/<h1[^>]*>Vibe Socials<\/h1>/);
    expect(html).not.toContain("Sent with");
    expect(html).toContain("body");
  });

  it("with no workspace and a title, the title is the page's h1 under the product name", () => {
    const html = render({ workspace: null, title: "This link is not active" });
    expect(html).toMatch(/<h1[^>]*>This link is not active<\/h1>/);
    expect(html.match(/<h1/g)).toHaveLength(1);
    expect(html).toContain("Vibe Socials");
  });

  it("keeps the page inside a phone: no fixed widths, long names wrap", () => {
    const html = render({ workspace: { name: "A".repeat(80), logoUrl: null }, title: "T" });
    expect(html).toContain("break-words");
    expect(html).toContain("min-w-0");
  });
});
