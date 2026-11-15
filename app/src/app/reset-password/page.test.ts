import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

import Page, { metadata } from "./page";

// R5 pages L11 and L13.
describe("/reset-password", () => {
  it("names the tab with the product", () => {
    expect(metadata.title).toBe("Reset your password | Vibe Socials");
  });

  it("sits in a main landmark", () => {
    expect(renderToStaticMarkup(Page() as ReactElement)).toMatch(/<main[ >]/);
  });
});

// R5 pages L8: the failure sentences are tested in resetOutcome.test.ts.
