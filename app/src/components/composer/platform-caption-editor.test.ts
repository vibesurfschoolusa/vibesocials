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

// R31 (lead follow-up): Adapt sends the workspace the page was drawn for, and
// both pages that show the editor pass it.
describe("PlatformCaptionEditor: the page's workspace id", () => {
  it("Adapt's body carries workspaceId, and Create and the Queue pass it", () => {
    const editor = readFileSync(new URL("./platform-caption-editor.tsx", import.meta.url), "utf8");
    expect(editor).toMatch(/workspaceId: string \| null;/);
    expect(editor).toMatch(/\.\.\.\(workspaceId \? \{ workspaceId \} : \{\}\)/);
    for (const page of ["../create-post-form.tsx", "../../app/queue/queue-view.tsx"]) {
      const source = readFileSync(new URL(page, import.meta.url), "utf8");
      const at = source.indexOf("<PlatformCaptionEditor");
      expect(source.slice(at, source.indexOf("/>", at)), page).toMatch(/workspaceId=\{workspaceId\}/);
    }
  });
});
