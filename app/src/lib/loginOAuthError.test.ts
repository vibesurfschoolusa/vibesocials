import { describe, expect, it } from "vitest";

import { GOOGLE_ADDRESS_HELD_ERROR, GOOGLE_PASSWORD_ACCOUNT_ERROR, loginOAuthErrorMessage } from "./loginOAuthError";

describe("loginOAuthErrorMessage", () => {
  it.each([
    [null, null],
    ["", null],
    [
      GOOGLE_PASSWORD_ACCOUNT_ERROR,
      "This email already has a password. Sign in with your password instead.",
    ],
    // R6-security M1: Google sign-in on an address an undo may still restore.
    [
      GOOGLE_ADDRESS_HELD_ERROR,
      "This address was recently moved off a Vibe Socials account, so it can't be used for a new account until 72 hours after the move. Sign in with the account's current email. If you didn't make that change, use the undo link we emailed to this address.",
    ],
    [
      "AccessDenied",
      "We couldn't sign you in with that Google account — use your email and password below instead.",
    ],
    ["OAuthCallback", "Sign-in didn't complete. Please try again."],
    ["Callback", "Sign-in didn't complete. Please try again."],
    ["SomethingNew", "Sign-in didn't complete. Please try again."],
  ])("maps ?error=%s", (code, expected) => {
    expect(loginOAuthErrorMessage(code)).toBe(expected);
  });

  it("uses a URL-safe error code (it travels as ?error=<code>)", () => {
    expect(GOOGLE_PASSWORD_ACCOUNT_ERROR).toMatch(/^[A-Za-z]+$/);
    expect(GOOGLE_ADDRESS_HELD_ERROR).toMatch(/^[A-Za-z]+$/);
    expect(GOOGLE_ADDRESS_HELD_ERROR).not.toBe(GOOGLE_PASSWORD_ACCOUNT_ERROR);
  });
});
