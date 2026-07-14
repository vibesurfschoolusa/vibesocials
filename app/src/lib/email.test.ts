import { describe, expect, it } from "vitest";

import { normalizeEmail } from "./email";

describe("normalizeEmail", () => {
  it("trims and lowercases", () => {
    expect(normalizeEmail("  User@Example.COM ")).toBe("user@example.com");
  });

  it("is idempotent", () => {
    const once = normalizeEmail("A@B.C");
    expect(normalizeEmail(once)).toBe(once);
  });
});
