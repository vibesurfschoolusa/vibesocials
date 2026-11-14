import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * Live check 2026-11-14: Add many's "Choose from Media" listed a real library
 * taller than the window, and the dialog grew past both edges (top -202 px,
 * bottom 1057 px in an 855 px window): its title and its Add button could not
 * be reached. Every dialog now fits the window; its body scrolls while the
 * header and footer stay in view, and a dialog laid out differently scrolls as
 * a whole. The panel renders into a portal, so the rule is read from source.
 */
const source = readFileSync(fileURLToPath(new URL("./dialog.tsx", import.meta.url)), "utf8");

function classesOf(marker: string): string {
  const at = source.indexOf(marker);
  expect(at).toBeGreaterThan(-1);
  const classNameAt = source.indexOf("className", at);
  const cls = source.slice(classNameAt).match(/"([^"]*)"/);
  return cls ? cls[1] : "";
}

describe("Dialog layout", () => {
  it("the panel never grows past the window and can scroll as a whole", () => {
    const panel = classesOf("ref={panelRef}");
    for (const cls of ["flex", "flex-col", "max-h-[calc(100dvh-2rem)]", "overflow-y-auto"]) {
      expect(panel.split(/\s+/)).toContain(cls);
    }
  });

  it("the body is the part that scrolls, so the title and the buttons stay in view", () => {
    const body = classesOf("function DialogBody");
    for (const cls of ["min-h-0", "overflow-y-auto"]) {
      expect(body.split(/\s+/)).toContain(cls);
    }
  });

  it("the header and footer do not shrink", () => {
    expect(classesOf("function DialogHeader").split(/\s+/)).toContain("shrink-0");
    expect(classesOf("function DialogFooter").split(/\s+/)).toContain("shrink-0");
  });
});

/**
 * R2-client-journey M1 review: the Queue's cancel and delete dialogs keep
 * Confirm disabled while they look up the other half of a Feed and Story post.
 * The dialog renders into a portal, so the prop is read from source.
 */
describe("ConfirmDialog confirmDisabled", () => {
  const confirmDialog = source.slice(source.indexOf("export interface ConfirmDialogProps"));

  it("is an optional prop that defaults to false, so other callers are unchanged", () => {
    expect(confirmDialog).toMatch(/confirmDisabled\?: boolean;/);
    expect(confirmDialog).toMatch(/confirmDisabled = false,/);
  });

  it("disables only the confirm button", () => {
    expect(confirmDialog).toMatch(/<Button variant=\{confirmVariant\} onClick=\{handleConfirm\} loading=\{busy\} disabled=\{confirmDisabled\}>/);
    expect(confirmDialog).toMatch(/<Button variant="outline" onClick=\{\(\) => onOpenChange\(false\)\} disabled=\{busy\}>/);
  });
});
