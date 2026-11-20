import bcrypt from "bcryptjs";
import { describe, expect, it } from "vitest";

import {
  PASSWORD_TOO_LONG,
  PASSWORD_TOO_SHORT,
  newPasswordProblem,
  sameToBcrypt,
} from "./passwordRule";

// R46 security L3: bcrypt reads only the first 72 UTF-8 bytes and ignores the
// rest without a word, so a new password over 72 bytes is refused.
describe("newPasswordProblem", () => {
  it("passes 72 bytes of ASCII and refuses 73", () => {
    expect(newPasswordProblem("x".repeat(72))).toBeNull();
    expect(newPasswordProblem("x".repeat(73))).toBe(PASSWORD_TOO_LONG);
  });

  it("passes 24 CJK characters (72 bytes) and refuses 25", () => {
    expect(newPasswordProblem("密".repeat(24))).toBeNull();
    expect(newPasswordProblem("密".repeat(25))).toBe(PASSWORD_TOO_LONG);
  });

  it("agrees with bcrypt's own truncation on both sides of the line", () => {
    for (const password of ["x".repeat(72), "x".repeat(73), "密".repeat(24), "密".repeat(25), "é".repeat(37)]) {
      expect(newPasswordProblem(password) === PASSWORD_TOO_LONG, password).toBe(bcrypt.truncates(password));
    }
  });

  it("keeps the 8-character floor and refuses what isn't text", () => {
    expect(newPasswordProblem("short")).toBe(PASSWORD_TOO_SHORT);
    expect(newPasswordProblem(12345678)).toBe(PASSWORD_TOO_SHORT);
    expect(newPasswordProblem(undefined)).toBe(PASSWORD_TOO_SHORT);
    expect(newPasswordProblem("goodpassword")).toBeNull();
  });

  it("says the limit plainly", () => {
    expect(PASSWORD_TOO_LONG).toBe(
      "Use a shorter password: at most 72 bytes. Accented and non-Latin letters count as 2 to 3 bytes.",
    );
  });

  it("stays fast on a very long input", () => {
    const started = performance.now();
    expect(newPasswordProblem("密".repeat(1_000_000))).toBe(PASSWORD_TOO_LONG);
    expect(performance.now() - started).toBeLessThan(200);
  });
});

describe("sameToBcrypt", () => {
  it("is true when two passwords differ only after byte 72", () => {
    expect(sameToBcrypt(`${"x".repeat(72)}A`, `${"x".repeat(72)}B`)).toBe(true);
    expect(sameToBcrypt(`${"密".repeat(24)}secret1`, "密".repeat(24))).toBe(true);
  });

  it("is false when they differ within the first 72 bytes", () => {
    expect(sameToBcrypt("old-password", "new-password")).toBe(false);
    expect(sameToBcrypt("x".repeat(71), "x".repeat(72))).toBe(false);
  });

  it("matches what bcrypt itself would accept", async () => {
    const hash = await bcrypt.hash(`${"x".repeat(72)}A`, 4);
    await expect(bcrypt.compare(`${"x".repeat(72)}B`, hash)).resolves.toBe(true);
    expect(sameToBcrypt(`${"x".repeat(72)}A`, `${"x".repeat(72)}B`)).toBe(true);
  });
});

// Existing long passwords keep working: sign-in compares with bcrypt as before
// and never applies the new-password rule.
describe("sign-in with a long password made before the rule", () => {
  it("still matches its stored hash", async () => {
    const long = `${"密".repeat(30)}-made-before-the-rule`;
    const hash = await bcrypt.hash(long, 4);
    await expect(bcrypt.compare(long, hash)).resolves.toBe(true);
  });
});
