import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

import RegisterPage from "./page";

/** 23: Register with billing on. Billing off: publicPagesBillingOff.test.ts pins today's page. */

function render(): string {
  return renderToStaticMarkup(RegisterPage() as ReactElement);
}

beforeEach(() => {
  search.value = "";
  fresh.account = undefined;
  vi.stubEnv("BILLING_ENABLED", "true");
  vi.stubEnv("BILLING_TRIAL_DAYS", "21");
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("Register with billing on", () => {
  it("says how long the trial is, under the button", () => {
    const html = render();
    expect(html).toContain("21-day free trial. No card needed.");
    expect(html.indexOf("21-day free trial")).toBeGreaterThan(html.indexOf("Create account</"));
  });

  it("says what the person agrees to, with links to both", () => {
    const html = render();
    expect(html.replace(/<[^>]+>/g, "")).toContain(
      "By creating an account you agree to the Terms and the Privacy Policy.",
    );
    expect(html).toMatch(/<a [^>]*href="\/terms"[^>]*>Terms<\/a>/);
    expect(html).toMatch(/<a [^>]*href="\/privacy"[^>]*>Privacy Policy<\/a>/);
  });

  it("uses the default trial length when none is set", () => {
    vi.stubEnv("BILLING_TRIAL_DAYS", undefined);
    expect(render()).toContain("14-day free trial. No card needed.");
  });
});

describe("Register with billing off", () => {
  it("says nothing about a trial", () => {
    vi.stubEnv("BILLING_ENABLED", undefined);
    const html = render();
    expect(html).not.toContain("free trial");
  });

  // F7 (R1 L5): what the person agrees to shows whether billing is on or off.
  it("still says what the person agrees to, with links to both", () => {
    vi.stubEnv("BILLING_ENABLED", undefined);
    const html = render();
    expect(html.replace(/<[^>]+>/g, "")).toContain(
      "By creating an account you agree to the Terms and the Privacy Policy.",
    );
    expect(html).toMatch(/<a [^>]*href="\/terms"[^>]*>Terms<\/a>/);
    expect(html).toMatch(/<a [^>]*href="\/privacy"[^>]*>Privacy Policy<\/a>/);
  });
});

// F7 (R1 L6): the browser tab names the page.
describe("Register metadata", () => {
  it("names the browser tab", async () => {
    const { metadata } = await import("./page");
    expect(metadata.title).toBe("Create an account | Vibe Socials");
  });
});

// R5 pages L13 and L8.
describe("Register page landmarks and failure sentences", () => {
  it("has a main landmark", () => {
    expect(render()).toMatch(/<main[ >]/);
  });

  it("says what happened and what to do when sign-up fails", async () => {
    const { REGISTER_FAILED_MESSAGE, REGISTER_OFFLINE_MESSAGE } = await import("./register-form");
    expect(REGISTER_FAILED_MESSAGE).toContain("Nothing was saved");
    expect(REGISTER_FAILED_MESSAGE).toContain("try again");
    expect(REGISTER_OFFLINE_MESSAGE).toContain("Check your internet connection");
  });

  it("caps the name field at what the workspace name can hold", () => {
    expect(render()).toMatch(/<input[^>]*id="name"[^>]*maxLength="48"|<input[^>]*maxLength="48"[^>]*id="name"/);
  });
});

// R17-pages L1: a paying owner pressed About's trial button and made a second
// account; a signed-in visitor now sees who they are instead of the form.
describe("Register for a signed-in visitor", () => {
  async function renderWith(status: "authenticated" | "unauthenticated" | "loading"): Promise<string> {
    const { SessionContext } = await import("next-auth/react");
    const { createElement } = await import("react");
    const value =
      status === "authenticated"
        ? { status, data: { user: { email: "owner@example.com" }, expires: "2099-01-01T00:00:00Z" }, update: async () => null }
        : { status, data: null, update: async () => null };
    return renderToStaticMarkup(
      createElement(SessionContext.Provider, { value: value as never }, RegisterPage() as ReactElement),
    );
  }

  it("says who is signed in and offers the dashboard and Sign out, not the form", async () => {
    fresh.account = { name: null, email: "owner@example.com" };
    const html = await renderWith("authenticated");
    const page = html.replace(/<[^>]+>/g, "").replace(/&#x27;/g, "'");
    expect(page).toContain("You're already signed in");
    expect(page).toContain("You're signed in as owner@example.com.");
    expect(page).toContain("To create a different account, sign out first.");
    expect(html).toMatch(/<a [^>]*href="\/"[^>]*>Go to your dashboard<\/a>/);
    expect(html).toMatch(/<button[^>]*>Sign out<\/button>/);
    expect(html).not.toContain('id="password"');
    expect(html).not.toContain("Create account</");
  });

  it("lets a signed-in invitee continue to the invite", async () => {
    search.value = "callbackUrl=%2Fjoin%2Fabc";
    fresh.account = { name: null, email: "owner@example.com" };
    const html = await renderWith("authenticated");
    expect(html).toMatch(/<a [^>]*href="\/join\/abc"[^>]*>Continue<\/a>/);
  });

  // R18 L1: the cached session alone is not enough; the server must say so.
  it("shows the form until the server answers, and when it has no session", async () => {
    for (const answer of [undefined, null]) {
      fresh.account = answer;
      const html = await renderWith("authenticated");
      expect(html).toContain('id="password"');
      expect(html).not.toContain("already signed in");
    }
  });

  it("shows the form once signed out, and while the session is still loading", async () => {
    for (const status of ["unauthenticated", "loading"] as const) {
      const html = await renderWith(status);
      expect(html).toContain('id="password"');
      expect(html).not.toContain("already signed in");
    }
  });
});
