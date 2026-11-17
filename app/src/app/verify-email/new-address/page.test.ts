import type { ReactElement } from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next-auth/react", () => ({ signOut: vi.fn() }));

import NewAddressPage, { metadata } from "./page";
import { NewAddressClient, NewAddressResult } from "./new-address-client";

describe("confirm new address page", () => {
  it("names the tab and sits in a main landmark", () => {
    expect(metadata.title).toBe("Confirm your new email | Vibe Socials");
    expect(renderToStaticMarkup(NewAddressPage() as ReactElement)).toMatch(/<main[ >]/);
  });

  // Review item 2: a mail scanner that opens the link changes nothing; the
  // change waits for a press of the button.
  it("first shows a button to press, not a change in progress", () => {
    const html = renderToStaticMarkup(createElement(NewAddressClient));
    expect(html).toMatch(/<button[^>]*>(<[^>]+>)*Use this email address/);
    expect(html).not.toContain("Confirming");
  });

  it("the client never posts on load", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const source = readFileSync(join(__dirname, "new-address-client.tsx"), "utf8");
    expect(source).not.toContain("useEffect");
  });

  it("shows Try again only when the link still works", () => {
    const base = {
      changed: false,
      signOutHere: false,
      title: "T",
      message: "M",
      next: { href: "/settings", label: "Go to Settings" },
    };
    const withRetry = renderToStaticMarkup(
      createElement(NewAddressResult, { view: { ...base, offerRetry: true }, onRetry: () => {} }),
    );
    const without = renderToStaticMarkup(
      createElement(NewAddressResult, { view: { ...base, offerRetry: false }, onRetry: () => {} }),
    );
    expect(withRetry).toContain("Try again");
    expect(without).not.toContain("Try again");
    expect(without).toContain('href="/settings"');
  });

  // R29 OO1 (new-customer L3): Try again showed nothing while it ran, so a
  // press while still offline looked dead and a second press sent a second
  // confirm. R44 pages-a L1: the loading card takes the answer's place while
  // it runs, so there is no second Try again to press (the live test checks it).
  it("while Try again runs, the loading card replaces the answer", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const source = readFileSync(join(__dirname, "new-address-client.tsx"), "utf8");
    expect(source).toContain("{view && busy ? (");
    expect(source).toContain("<NewAddressResult view={view} onRetry={() => void confirm()} headingRef={resultHeadingRef} />");
  });
});
