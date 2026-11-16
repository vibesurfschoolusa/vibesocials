import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

// R26 LL3 item 5: the "Adapt for X" button that is working keeps keyboard
// focus (Button's loading ignores the press); the others wait, disabled.
describe("Adapt for X while busy", () => {
  const source = readFileSync(new URL("./platform-caption-editor.tsx", import.meta.url), "utf8");
  it("the busy button is loading, not disabled", () => {
    expect(source).toContain("loading={adapting === platform}");
    expect(source).toContain("disabled={disabled || (adapting !== null && adapting !== platform)}");
  });
});
