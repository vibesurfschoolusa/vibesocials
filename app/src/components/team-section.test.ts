import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

// R5 pages L10: the field that shows a new invite link has a name for screen
// readers. It only renders right after a link is made (client state), so the
// source is checked.
describe("Team section invite link field", () => {
  it("is labelled", () => {
    const source = readFileSync(join(__dirname, "team-section.tsx"), "utf8");
    expect(source).toMatch(/<Input\s+readOnly\s+value=\{freshUrl\}\s+aria-label="New invite link"/);
  });
});
