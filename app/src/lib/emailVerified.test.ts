import { afterEach, describe, expect, it, vi } from "vitest";

import {
  isEmailVerificationEnforced,
  isEmailVerifiedForPublish,
} from "./emailVerified";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("emailVerified", () => {
  it("does not enforce when RESEND_API_KEY is unset", () => {
    vi.stubEnv("RESEND_API_KEY", "");
    expect(isEmailVerificationEnforced()).toBe(false);
    expect(isEmailVerifiedForPublish({ emailVerifiedAt: null })).toBe(true);
  });

  it("enforces when RESEND_API_KEY is set", () => {
    vi.stubEnv("RESEND_API_KEY", "re_test");
    expect(isEmailVerificationEnforced()).toBe(true);
    expect(isEmailVerifiedForPublish({ emailVerifiedAt: null })).toBe(false);
    expect(
      isEmailVerifiedForPublish({ emailVerifiedAt: new Date("2026-01-01") }),
    ).toBe(true);
  });
});
