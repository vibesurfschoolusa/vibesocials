import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { teamMemberLines } from "./team-section";

// R5 pages L10: the field that shows a new invite link has a name for screen
// readers. It only renders right after a link is made (client state), so the
// source is checked.
describe("Team section invite link field", () => {
  it("is labelled", () => {
    const source = readFileSync(join(__dirname, "team-section.tsx"), "utf8");
    expect(source).toMatch(/<Input\s+readOnly\s+value=\{freshUrl\}\s+aria-label="New invite link"/);
  });
});

// R15 (after AA2): the owners' Team card names each person with the one label
// rule, so a blank or spaces-only name never shows as an empty row.
describe("Team card member names", () => {
  it("shows the name with the address under it, else the full address alone", () => {
    expect(teamMemberLines({ name: "Ana Ruiz", email: "ana@surf.example" })).toEqual({
      label: "Ana Ruiz",
      email: "ana@surf.example",
    });
    for (const name of [null, "", "   "]) {
      expect(teamMemberLines({ name, email: "info@surf.example" }), String(name)).toEqual({
        label: "info@surf.example",
        email: null,
      });
    }
  });

  it("the card's rows, toasts and dialogs never fall back with name ?? email", () => {
    const source = readFileSync(join(__dirname, "team-section.tsx"), "utf8");
    expect(source).not.toMatch(/\.name \?\? /);
  });
});
