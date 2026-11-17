import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("next-auth/react", async () => {
  const { createContext } = await import("react");
  return { signOut: vi.fn(), SessionContext: createContext(undefined) };
});

import {
  FormHeading,
  SignedInNotice,
  pressSignOut,
  showSignedInNotice,
  signOutHere,
} from "./signed-in-notice";
import { SIGN_OUT_FAILED_MESSAGE, SIGN_OUT_NOT_SENT_MESSAGE, SIGN_OUT_STILL_SIGNED_IN_MESSAGE } from "@/lib/signOutChecked";

const source = readFileSync(join(__dirname, "signed-in-notice.tsx"), "utf8");

// R17-pages L1.
describe("signed-in notice on Log in and Register", () => {
  it("shows for a signed-in visitor, but not while their own form is signing them in", () => {
    const account = { name: null, email: "owner@example.com" };
    expect(showSignedInNotice(account, false)).toBe(true);
    // The form's own sign-in (password or sign-up) goes on to its callbackUrl,
    // an invite included; the notice must not replace it on the way.
    expect(showSignedInNotice(account, true)).toBe(false);
    expect(showSignedInNotice(null, false)).toBe(false);
  });

  // R32 new-customer L2: through the one checked sign-out (lib/signOutChecked.ts).
  it("signs out on this page, so the form shows here with the same callbackUrl", async () => {
    const signOut = vi.fn(async () => ({ ok: true as const }));
    await expect(signOutHere(signOut)).resolves.toBeNull();
    expect(signOut).toHaveBeenCalledTimes(1);
  });

  it("says plainly when signing out did not work (a csrf=true answer, a lost one, a session still there)", async () => {
    await expect(signOutHere(async () => ({ ok: false as const, kind: "lost" as const }))).resolves.toBe(SIGN_OUT_FAILED_MESSAGE);
    // R32 lead review: an answer that left the person signed in says so.
    await expect(signOutHere(async () => ({ ok: false as const, kind: "refused" as const }))).resolves.toBe(
      SIGN_OUT_STILL_SIGNED_IN_MESSAGE,
    );
    // R33 pages L4: no answer to the token read, so nothing was sent.
    await expect(signOutHere(async () => ({ ok: false as const, kind: "not_sent" as const }))).resolves.toBe(
      SIGN_OUT_NOT_SENT_MESSAGE,
    );
    // Lead review 3 (R28 NN2): the sign-out may have ended the session before the answer was lost.
    expect(SIGN_OUT_FAILED_MESSAGE).toBe(
      "Vibe Socials' answer didn't reach you, so you may be signed out. If your connection dropped, reconnect first. Then reload the page to see.",
    );
  });

  it("the card's Sign out goes through it", () => {
    expect(source).toMatch(/pressSignOut\(signOutChecked, onSignedOut\)/);
    expect(source).toMatch(/signOutFn: \(\) => Promise<SignOutCheck> = signOutChecked/);
  });
});

// R18-pages L2: after Sign out the card and its focused button are gone, so the
// form's heading takes the focus and a screen reader lands on the form.
describe("after Sign out on the notice", () => {
  it("tells the page once when signing out worked, so the form's heading takes the focus", async () => {
    const onSignedOut = vi.fn();
    await expect(pressSignOut(async () => ({ ok: true as const }), onSignedOut)).resolves.toBeNull();
    expect(onSignedOut).toHaveBeenCalledTimes(1);
  });

  it("does not move the focus when signing out failed; the notice says why", async () => {
    const onSignedOut = vi.fn();
    await expect(
      pressSignOut(async () => ({ ok: false as const, kind: "lost" as const }), onSignedOut),
    ).resolves.toBe(SIGN_OUT_FAILED_MESSAGE);
    expect(onSignedOut).not.toHaveBeenCalled();
  });

  it("makes the form's heading focusable only after a sign-out, so the page's first HTML is unchanged", () => {
    const plain = renderToStaticMarkup(createElement(FormHeading, { focus: false }, "Log in"));
    expect(plain).toBe('<h1 class="text-2xl font-semibold leading-none tracking-tight text-foreground">Log in</h1>');
    const focused = renderToStaticMarkup(createElement(FormHeading, { focus: true }, "Log in"));
    expect(focused).toMatch(/^<h1 [^>]*tabindex="-1"[^>]*>Log in<\/h1>$/);
  });
});

// R18-pages L3: a long address wraps inside the card at 375 px.
describe("the signed-in notice's address line", () => {
  it("breaks a long address instead of running out of the card", () => {
    const html = renderToStaticMarkup(
      createElement(SignedInNotice, {
        account: { name: null, email: "marketing.department@coastalrealtygroup.example.com" },
        callbackUrl: "/",
        purpose: "login",
      }),
    );
    expect(html).toMatch(/<p class="[^"]*\bbreak-words\b[^"]*">You(&#x27;|')re signed in as marketing/);
  });
});
