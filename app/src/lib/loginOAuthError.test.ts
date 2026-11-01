import { describe, expect, it } from "vitest";

import { GOOGLE_PASSWORD_ACCOUNT_ERROR, loginOAuthErrorMessage } from "./loginOAuthError";

describe("loginOAuthErrorMessage", () => {
  it.each([
    [null, null],
    ["", null],
    [
      GOOGLE_PASSWORD_ACCOUNT_ERROR,
      "This email already has a password. Sign in with your password instead.",
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
  });
});
