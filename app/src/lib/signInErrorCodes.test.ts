import { describe, expect, it } from "vitest";

import { SIGN_IN_LIMITED, SIGN_IN_UNCHECKED, signInLimitedCode, signInLimitedWait } from "./signInErrorCodes";

// R32 lead: the limit code carries the limiter's own wait, so Log in states a true one.
describe("signInLimitedCode / signInLimitedWait", () => {
  it("whole minutes, rounded up, at least one", () => {
    expect(signInLimitedCode(60)).toBe("SignInLimited-1");
    expect(signInLimitedCode(61)).toBe("SignInLimited-2");
    expect(signInLimitedCode(1)).toBe("SignInLimited-1");
    expect(signInLimitedCode(3600)).toBe("SignInLimited-60");
  });

  it("no wait from the limiter: the bare code", () => {
    expect(signInLimitedCode(undefined)).toBe(SIGN_IN_LIMITED);
    expect(signInLimitedCode(0)).toBe(SIGN_IN_LIMITED);
    expect(signInLimitedCode(Number.NaN)).toBe(SIGN_IN_LIMITED);
  });

  it("reads the code back: minutes, null for no number, undefined for anything else", () => {
    expect(signInLimitedWait("SignInLimited-46")).toBe(46);
    expect(signInLimitedWait(SIGN_IN_LIMITED)).toBeNull();
    for (const other of [SIGN_IN_UNCHECKED, "CredentialsSignin", "SignInLimited-", "SignInLimited-0", "SignInLimited-x", "xSignInLimited-3", null, undefined]) {
      expect(signInLimitedWait(other)).toBeUndefined();
    }
  });
});
