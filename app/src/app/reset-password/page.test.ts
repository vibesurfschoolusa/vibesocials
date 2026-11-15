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

// R5 pages L8.
describe("reset password failure sentences", () => {
  it("say what happened and what to do", async () => {
    const { RESET_FAILED_MESSAGE, RESET_OFFLINE_MESSAGE } = await import("./reset-password-form");
    expect(RESET_FAILED_MESSAGE).toBe("Your password wasn't changed. Please try again in a minute.");
    expect(RESET_OFFLINE_MESSAGE).toBe(
      "We couldn't reach Vibe Socials, so your password wasn't changed. Check your internet connection and try again.",
    );
  });
});
