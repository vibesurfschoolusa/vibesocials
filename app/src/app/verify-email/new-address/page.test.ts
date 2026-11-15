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
});
