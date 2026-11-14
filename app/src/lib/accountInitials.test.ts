import { describe, expect, it } from "vitest";

import { accountInitials, accountLabel } from "./accountInitials";

/** The account button's avatar and label (2026-11-14): the person, not the first letter of their email. */

describe("accountInitials", () => {
  it("is the first letters of the first and last name", () => {
    expect(accountInitials("Klaus Schroder", "info@vibesurfschool.com")).toBe("KS");
    expect(accountInitials("klaus van der schroder", "")).toBe("KS");
    expect(accountInitials("  Ana   Maria  Lopez ", "")).toBe("AL");
  });

  it("is one letter for a one-word name", () => {
    expect(accountInitials("Klaus", "info@vibesurfschool.com")).toBe("K");
  });

  it("keeps letters outside A-Z", () => {
    expect(accountInitials("Émile Zola", "")).toBe("ÉZ");
    expect(accountInitials("Øyvind Ånes", "")).toBe("ØÅ");
  });

  it("skips words that start with no letter or digit", () => {
    expect(accountInitials("🌊 Surf Crew", "")).toBe("SC");
    expect(accountInitials("(Klaus) Schroder", "")).toBe("KS");
  });

  it("falls back to the email's first letter without a usable name", () => {
    expect(accountInitials(null, "info@vibesurfschool.com")).toBe("I");
    expect(accountInitials("", "zoe@example.com")).toBe("Z");
    expect(accountInitials("🌊", "zoe@example.com")).toBe("Z");
    expect(accountInitials(undefined, "  max@example.com")).toBe("M");
  });

  it("is a question mark with neither", () => {
    expect(accountInitials(null, "")).toBe("?");
    expect(accountInitials("  ", "  ")).toBe("?");
  });
});

describe("accountLabel", () => {
  it("is the name when there is one, else the email, else Account", () => {
    expect(accountLabel("Klaus Schroder", "info@vibesurfschool.com")).toBe("Klaus Schroder");
    expect(accountLabel("  Klaus  ", "info@vibesurfschool.com")).toBe("Klaus");
    expect(accountLabel(null, "info@vibesurfschool.com")).toBe("info@vibesurfschool.com");
    expect(accountLabel("   ", "")).toBe("Account");
  });
});
