import type { ReactElement } from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next-auth/react", () => ({ signOut: vi.fn() }));

import NewAddressPage, { metadata } from "./page";
import { NewAddressResult } from "./new-address-client";

describe("confirm new address page", () => {
  it("names the tab and sits in a main landmark", () => {
    expect(metadata.title).toBe("Confirm your new email | Vibe Socials");
    expect(renderToStaticMarkup(NewAddressPage() as ReactElement)).toMatch(/<main[ >]/);
  });

  it("shows Try again only when the link still works", () => {
    const base = { changed: false, title: "T", message: "M", next: { href: "/settings", label: "Go to Settings" } };
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
