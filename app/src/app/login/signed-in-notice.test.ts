import { describe, expect, it, vi } from "vitest";

vi.mock("next-auth/react", async () => {
  const { createContext } = await import("react");
  return { signOut: vi.fn(), SessionContext: createContext(undefined) };
});

import { SIGN_OUT_FAILED_MESSAGE, showSignedInNotice, signOutHere } from "./signed-in-notice";

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

  it("signs out on this page, so the form shows here with the same callbackUrl", async () => {
    const signOut = vi.fn(async () => undefined);
    await expect(signOutHere(signOut)).resolves.toBeNull();
    expect(signOut).toHaveBeenCalledWith({ redirect: false });
  });

  it("says plainly when signing out did not work", async () => {
    const signOut = vi.fn(async () => {
      throw new Error("offline");
    });
    await expect(signOutHere(signOut)).resolves.toBe(SIGN_OUT_FAILED_MESSAGE);
    expect(SIGN_OUT_FAILED_MESSAGE).toBe("Couldn't sign you out. Check your internet connection and try again.");
  });
});
