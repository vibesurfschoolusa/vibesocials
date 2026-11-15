import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { search } = vi.hoisted(() => ({ search: { value: "" } }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(search.value),
}));
vi.mock("next-auth/react", () => ({ signIn: vi.fn(), getProviders: vi.fn(async () => null) }));

import LoginPage from "./page";

function render(): string {
  return renderToStaticMarkup(LoginPage() as ReactElement);
}

function text(html: string): string {
  return html.replace(/<[^>]+>/g, "").replace(/&#x27;/g, "'");
}

beforeEach(() => {
  search.value = "";
});

describe("login page after sign-up", () => {
  // R5 pages M2 / new-customer L1: sign-up answers the same for a new and an
  // existing email (no oracle), so this page cannot know an account was made.
  it("never says the account was created, and says what to do if the email already had one", () => {
    search.value = "registered=1";
    const html = render();
    expect(text(html)).not.toContain("Account created");
    expect(text(html)).toContain(
      "If this email is new, your account is ready. If you already had an account, sign in with its password or reset it.",
    );
    expect(html).toMatch(/<a [^>]*href="\/forgot-password"[^>]*>reset it<\/a>/);
  });

  it("shows no sign-up note on a plain visit", () => {
    expect(text(render())).not.toContain("If this email is new");
  });
});

// R5 pages L13: the form sits in the page's main landmark.
describe("login page landmarks", () => {
  it("has a main landmark", () => {
    expect(render()).toMatch(/<main[ >]/);
  });
});
