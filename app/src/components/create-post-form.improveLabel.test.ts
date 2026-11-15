import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

// R5 pages L3: the AI action that rewrites a caption has one name everywhere:
// "Improve caption" (Add many's row button says the same).
describe("Create page caption button", () => {
  it("is called Improve caption", () => {
    const source = readFileSync(join(__dirname, "create-post-form.tsx"), "utf8");
    expect(source).not.toContain("Enhance caption");
    expect(source).toMatch(/onClick=\{handleEnhanceCaption\}[\s\S]{0,400}?\n\s+Improve caption\n/);
  });
});
