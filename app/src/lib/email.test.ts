import { describe, expect, it } from "vitest";

import { EMAIL_MAX_LENGTH, isEmailShaped, normalizeEmail } from "./email";

describe("normalizeEmail", () => {
  it("trims and lowercases", () => {
    expect(normalizeEmail("  User@Example.COM ")).toBe("user@example.com");
  });

  it("is idempotent", () => {
    const once = normalizeEmail("A@B.C");
    expect(normalizeEmail(once)).toBe(once);
  });
});

// R45 review M1: the check runs before any limit, so it is linear and refuses
// an over-long address before looking at it.
describe("isEmailShaped", () => {
  it.each(["user@example.com", "a@b.c", "first.last+tag@mail.example.co.uk", "a@b@c.d", "@a@b.c", "x".repeat(242) + "@example.com"])(
    "%s passes",
    (email) => {
      expect(isEmailShaped(email)).toBe(true);
    },
  );

  it.each(["", "a", "a@b", "a@.c", "a@b.", "@b.c", "a b@c.d", "a@b.c ", "a@b\u00a0.c", "a.@a.", "x".repeat(243) + "@example.com"])(
    "%j is refused",
    (email) => {
      expect(isEmailShaped(email)).toBe(false);
    },
  );

  it("refuses anything but a string", () => {
    for (const value of [undefined, null, 5, {}, ["a@b.c"]]) expect(isEmailShaped(value)).toBe(false);
  });

  it(`allows ${EMAIL_MAX_LENGTH} characters and no more`, () => {
    expect(EMAIL_MAX_LENGTH).toBe(254);
  });

  it("refuses a 10,000-character address within milliseconds, the backtracking case included", () => {
    for (const email of ["a.@".repeat(3334) + " ", "a".repeat(10_000), "a@" + "b.".repeat(5_000)]) {
      const started = performance.now();
      expect(isEmailShaped(email)).toBe(false);
      expect(performance.now() - started).toBeLessThan(50);
    }
  });
});
