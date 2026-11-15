import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { addressHeldSentence, emailChangeLockedSentence, formatDisplayDate } from "./displayDate";

// R6-pages L8: one date format across Settings (account, team, connect link).
describe("formatDisplayDate", () => {
  it("writes the month in full, then the day and the year", () => {
    expect(formatDisplayDate("2026-11-21T12:00:00.000Z")).toBe("November 21, 2026");
    expect(formatDisplayDate(new Date("2026-03-02T12:00:00.000Z"))).toBe("March 2, 2026");
  });

  it("writes nothing for a value that isn't a date", () => {
    expect(formatDisplayDate("not a date")).toBe("");
  });
});

// R6-security M1: a new email change waits until the undo window has closed.
describe("emailChangeLockedSentence", () => {
  it("says why and from when", () => {
    expect(emailChangeLockedSentence("2026-11-21T12:00:00.000Z")).toBe(
      "You changed your email recently; you can change it again after November 21, 2026.",
    );
  });
});

describe("one date format across Settings", () => {
  const source = (file: string) => readFileSync(join(__dirname, "..", "components", file), "utf8");

  it("account-section and connect-link-section write dates only with it", () => {
    for (const file of ["account-section.tsx", "connect-link-section.tsx"]) {
      expect(source(file)).toContain("formatDisplayDate(");
      expect(source(file)).not.toContain("toLocaleDateString");
    }
  });

  it("team-section's invite date line uses it", () => {
    const team = source("team-section.tsx");
    expect(team).toMatch(/function formatDate\(iso: string\): string \{[^}]*return formatDisplayDate\(date\);/);
    expect(team).not.toContain("toLocaleDateString");
  });
});

// R6-security M1: the confirm page's refusal when another account's undo may
// still take the address back.
describe("addressHeldSentence", () => {
  it("says why the email is unchanged and from when to ask again", () => {
    expect(addressHeldSentence("2026-11-17T12:00:00.000Z")).toBe(
      "This address was another Vibe Socials account's sign-in email until recently, and that account can take it back until November 17, 2026, so your email is unchanged. After that, ask for the change again in Settings, Account.",
    );
  });
});
