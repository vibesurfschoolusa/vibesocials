import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { search, fresh } = vi.hoisted(() => ({
  search: { value: "" },
  // R18 L1: what the server's fresh session read answered; undefined uses the real hook.
  fresh: { account: undefined as { name: string | null; email: string | null } | null | undefined },
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(search.value),
}));
// R17-pages L1: the pages read the session through next-auth's own context.
vi.mock("next-auth/react", async () => {
  const { createContext } = await import("react");
  return {
    signIn: vi.fn(),
    signOut: vi.fn(),
    getSession: vi.fn(async () => null),
    getProviders: vi.fn(async () => null),
    SessionContext: createContext(undefined),
  };
});
vi.mock("@/components/signed-in-swap", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/components/signed-in-swap")>();
  return {
    ...real,
    useFreshSignedInAccount: () => {
      const account = real.useFreshSignedInAccount();
      return fresh.account === undefined ? account : fresh.account;
    },
  };
});

import LoginPage from "./page";

function render(): string {
  return renderToStaticMarkup(LoginPage() as ReactElement);
}

function text(html: string): string {
  return html.replace(/<[^>]+>/g, "").replace(/&#x27;/g, "'");
}

beforeEach(() => {
  search.value = "";
  fresh.account = undefined;
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

// R17-pages L1: someone already signed in is told so before any form, so no
// second account or sign-in happens by accident. R18 L1: only once the server's
// own session read says so; the cached client session alone is not enough.
describe("login page for a signed-in visitor", () => {
  const OWNER = { name: "Owner", email: "owner@example.com" };

  async function renderWith(status: "authenticated" | "unauthenticated" | "loading"): Promise<string> {
    const { SessionContext } = await import("next-auth/react");
    const { createElement } = await import("react");
    const value =
      status === "authenticated"
        ? { status, data: { user: OWNER, expires: "2099-01-01T00:00:00Z" }, update: async () => null }
        : { status, data: null, update: async () => null };
    return renderToStaticMarkup(
      createElement(SessionContext.Provider, { value: value as never }, LoginPage() as ReactElement),
    );
  }

  it("says who is signed in and offers the dashboard and Sign out, not the form", async () => {
    fresh.account = OWNER;
    const html = await renderWith("authenticated");
    expect(text(html)).toContain("You're already signed in");
    expect(text(html)).toContain("You're signed in as owner@example.com.");
    expect(html).toMatch(/<a [^>]*href="\/"[^>]*>Go to your dashboard<\/a>/);
    expect(html).toMatch(/<button[^>]*>Sign out<\/button>/);
    expect(html).not.toContain('id="password"');
    expect(html).not.toContain(">Sign in</button>");
  });

  it("lets a signed-in invitee continue to the invite", async () => {
    search.value = "callbackUrl=%2Fjoin%2Fabc";
    fresh.account = OWNER;
    const html = await renderWith("authenticated");
    expect(html).toMatch(/<a [^>]*href="\/join\/abc"[^>]*>Continue<\/a>/);
    expect(html).toMatch(/<button[^>]*>Sign out<\/button>/);
    expect(html).not.toContain('id="password"');
  });

  it("shows the form until the server has answered, even when the cached session says signed in", async () => {
    const html = await renderWith("authenticated");
    expect(html).toContain('id="password"');
    expect(html).not.toContain("already signed in");
  });

  // The loops in the R18 reports: a reset in this browser then "Log in" (/login),
  // a reset on another device then a page's redirect (/login?callbackUrl=/activity)
  // or Join's "Sign in again" (/login?callbackUrl=/join/abc). The cached session
  // still says signed in; the server has none, so the form shows, keeping the way back.
  it("shows the form when the server has no session, on every loop path", async () => {
    for (const [query, back] of [
      ["", "/register"],
      ["callbackUrl=%2Factivity", "/register?callbackUrl=%2Factivity"],
      ["callbackUrl=%2Fjoin%2Fabc", "/register?callbackUrl=%2Fjoin%2Fabc"],
    ] as const) {
      search.value = query;
      fresh.account = null;
      const html = await renderWith("authenticated");
      expect(html).toContain('id="password"');
      expect(html).not.toContain("already signed in");
      expect(html).toContain(`href="${back}"`);
    }
  });

  it("shows the form once signed out, and while the session is still loading", async () => {
    for (const status of ["unauthenticated", "loading"] as const) {
      const html = await renderWith(status);
      expect(html).toContain('id="password"');
      expect(html).not.toContain("already signed in");
    }
  });

  it("keeps a signed-out invitee's way back to the invite", async () => {
    search.value = "callbackUrl=%2Fjoin%2Fabc";
    const html = await renderWith("unauthenticated");
    expect(html).toContain('id="password"');
    expect(html).toContain('href="/register?callbackUrl=%2Fjoin%2Fabc"');
  });
});
