import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import { NoAnswerError } from "@/lib/requestNoAnswer";

import {
  CONFIRM_FAILED_MESSAGE,
  CONFIRM_UNREACHABLE_MESSAGE,
  ConfirmFailureShown,
  confirmFailureText,
  focusFallbacks,
  restoreFocus,
} from "./dialog";

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

/**
 * R25 new-customer L1 / publishing-flow L2: ConfirmDialog swallowed a thrown
 * error, so a Team or Queue confirm whose request never left said nothing. One
 * contract now: an onConfirm that already told the person throws
 * ConfirmFailureShown, which the dialog ignores; anything else the dialog says
 * itself, in the dialog, so a failure is never silent and never shown twice.
 */
describe("ConfirmDialog failures", () => {
  it("a failure the caller already showed is not shown again", () => {
    expect(confirmFailureText(new ConfirmFailureShown("REMOVE_FAILED"))).toBeNull();
    expect(new ConfirmFailureShown("REMOVE_FAILED")).toBeInstanceOf(Error);
  });

  it("a request that got no answer (lib/requestNoAnswer): nothing changed, check the connection", () => {
    expect(confirmFailureText(new NoAnswerError(new TypeError("Failed to fetch")))).toBe(CONFIRM_UNREACHABLE_MESSAGE);
    expect(CONFIRM_UNREACHABLE_MESSAGE).toBe(
      "We couldn't reach Vibe Socials, so nothing changed. Check your connection and try again.",
    );
  });

  it("a caller can word the unreachable case itself (Queue's Publish)", () => {
    expect(confirmFailureText(new NoAnswerError(new TypeError("Load failed")), "Check Activity.")).toBe("Check Activity.");
  });

  it("a coding TypeError is not 'couldn't reach': the plain sentence, and it is logged", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const coding = new TypeError("Cannot read properties of undefined (reading 'id')");
    expect(confirmFailureText(coding)).toBe(CONFIRM_FAILED_MESSAGE);
    expect(log).toHaveBeenCalledWith(expect.any(String), coding);
    log.mockRestore();
  });

  it("anything else: a plain sentence, never the raw error, and logged", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    for (const error of [new Error("REMOVE_FAILED"), new TypeError("Failed to fetch"), "oops", null, undefined]) {
      expect(confirmFailureText(error)).toBe(CONFIRM_FAILED_MESSAGE);
    }
    expect(log).toHaveBeenCalledTimes(5);
    expect(CONFIRM_FAILED_MESSAGE).toBe("Something went wrong, nothing changed. Try again.");
    log.mockRestore();
  });

  it("an already-shown failure and a request with no answer are not logged", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    confirmFailureText(new ConfirmFailureShown("X"));
    confirmFailureText(new NoAnswerError(new TypeError("Failed to fetch")));
    expect(log).not.toHaveBeenCalled();
    log.mockRestore();
  });

  const confirmDialog = source.slice(source.indexOf("export function ConfirmDialog"));

  it("the dialog shows its sentence in itself, as an alert, and stays open", () => {
    expect(confirmDialog).toMatch(/confirmFailureText\(error, unreachableText\)/);
    expect(confirmDialog).toMatch(/role="alert"/);
    expect(confirmDialog).not.toMatch(/catch \{/);
  });

  it("takes the unreachable wording as an optional prop", () => {
    const props = source.slice(source.indexOf("export interface ConfirmDialogProps"), source.indexOf("export function ConfirmDialog"));
    expect(props).toMatch(/unreachableText\?: string;/);
  });
});

/**
 * Every ConfirmDialog caller follows the contract: a failure it already
 * toasted is thrown as ConfirmFailureShown, never a bare code like
 * "REMOVE_FAILED" or the error it caught (which the dialog would show again).
 */
describe("ConfirmDialog callers", () => {
  const callers = [
    "../../app/queue/queue-view.tsx",
    "../connect-link-section.tsx",
    "../connection-actions.tsx",
    "../media-library.tsx",
    "../team-section.tsx",
    "../../app/reviews/reviews-view.tsx",
  ];
  for (const path of callers) {
    it(`${path} throws ConfirmFailureShown after it has told the person`, () => {
      const caller = readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");
      expect(caller).not.toMatch(/throw new Error\("[A-Z_]+"\)/);
      // A rethrow right after its own toast would be shown twice.
      expect(caller).not.toMatch(/toast\.error\([^;]*\);\s*throw (err|error);/);
      expect(caller).toMatch(/ConfirmFailureShown/);
    });
  }

  // KK3 follow-up: the dialog only says "couldn't reach" for a request that got
  // no answer, so the confirm handlers' requests go through fetchOrNoAnswer.
  for (const [path, handlers] of [
    ["../../app/queue/queue-view.tsx", ["confirmCancel", "confirmDelete", "confirmPublish", "makeLink", "turnOff"]],
    ["../team-section.tsx", ["handleLeave", "revokeInvite", "confirmRemove", "confirmPromote", "confirmDemote"]],
    ["../media-library.tsx", ["makeLink", "turnOff"]],
  ] as const) {
    it(`${path}: ${handlers.join(", ")} send through fetchOrNoAnswer`, () => {
      const caller = readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");
      for (const handler of handlers) {
        let at = caller.indexOf(`const ${handler} = useCallback`);
        expect(at, handler).toBeGreaterThan(-1);
        while (at !== -1) {
          const body = caller.slice(at, caller.indexOf("}, [", at));
          expect(body, handler).toMatch(/await fetchOrNoAnswer\(/);
          expect(body, handler).not.toMatch(/await fetch\(/);
          at = caller.indexOf(`const ${handler} = useCallback`, at + 1);
        }
      }
    });
  }

  // KK3 follow-up: Create link (no dialog) swallowed an offline failure.
  for (const path of ["../../app/queue/queue-view.tsx", "../media-library.tsx"]) {
    it(`${path}: Create link says a failure through the same texts`, () => {
      const caller = readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");
      const body = caller.slice(caller.indexOf("async function handleCreate()"), caller.indexOf("async function copyUrl()"));
      expect(body).toMatch(/catch \(error\) \{\s+const text = confirmFailureText\(error\);\s+if \(text\) toast\.error\(text\);/);
    });
  }
});

/**
 * R26 pages L4: a confirmed action can remove the button that opened the
 * dialog (Team Remove and the "gone" drop, Queue Cancel/Delete/Publish,
 * "Create link"), and focus returned to a button no longer on the page lands
 * on the body. The dialog records, at open, the headings above the trigger
 * (nearest first) and, on close, focuses the first one still on the page.
 * A fake element tree: the panel renders into a portal and vitest has no DOM.
 */
type Fake = {
  tagName: string;
  parentElement: Fake | null;
  children: Fake[];
  attrs: Record<string, string>;
  tabIndex: number;
  focus: ReturnType<typeof vi.fn>;
  hasAttribute(name: string): boolean;
  readonly isConnected: boolean;
};

function el(tagName: string, children: Fake[] = [], attrs: Record<string, string> = {}): Fake {
  const node: Fake = {
    tagName,
    parentElement: null,
    children,
    attrs,
    tabIndex: tagName === "BUTTON" ? 0 : -1,
    focus: vi.fn(),
    hasAttribute: (name) => name in node.attrs,
    get isConnected() {
      let at: Fake = node;
      while (at.parentElement) at = at.parentElement;
      return at.tagName === "HTML";
    },
  };
  for (const child of children) child.parentElement = node;
  return node;
}

function detach(node: Fake) {
  const parent = node.parentElement;
  if (parent) parent.children = parent.children.filter((child) => child !== node);
  node.parentElement = null;
}

const asElement = (node: Fake) => node as unknown as HTMLElement;

describe("Dialog focus when its trigger is gone", () => {
  function teamPage() {
    const remove = el("BUTTON");
    const otherRemove = el("BUTTON");
    const row = el("LI", [el("P"), remove]);
    const otherRow = el("LI", [el("P"), otherRemove]);
    const members = el("H3");
    const invite = el("H3", [], { tabindex: "0" });
    el("HTML", [el("BODY", [el("H1"), el("DIV", [invite]), el("DIV", [members, el("UL", [otherRow, row])])])]);
    return { remove, row, members, invite };
  }

  it("records the headings above the trigger, nearest section first", () => {
    const { remove, members, invite } = teamPage();
    const fallbacks = focusFallbacks(asElement(remove));
    expect(fallbacks[0]).toBe(members);
    expect(fallbacks).toContain(invite);
    expect(fallbacks).toHaveLength(3);
  });

  it("the trigger still on the page gets focus back, as before", () => {
    const { remove } = teamPage();
    const fallbacks = focusFallbacks(asElement(remove));
    restoreFocus(asElement(remove), fallbacks);
    expect(remove.focus).toHaveBeenCalledTimes(1);
  });

  it("the trigger's row was removed: its section heading gets focus, made focusable", () => {
    const { remove, row, members } = teamPage();
    const fallbacks = focusFallbacks(asElement(remove));
    detach(row);
    restoreFocus(asElement(remove), fallbacks);
    expect(remove.focus).not.toHaveBeenCalled();
    expect(members.focus).toHaveBeenCalledTimes(1);
    expect(members.tabIndex).toBe(-1);
  });

  it("a heading that is gone too is skipped; one with its own tabindex is left as is", () => {
    const { remove, row, members, invite } = teamPage();
    const fallbacks = focusFallbacks(asElement(remove));
    detach(row);
    detach(members);
    invite.tabIndex = 0;
    restoreFocus(asElement(remove), fallbacks);
    expect(invite.focus).toHaveBeenCalledTimes(1);
    expect(invite.tabIndex).toBe(0);
  });

  it("nothing was focused at open: nothing to restore", () => {
    expect(focusFallbacks(null)).toEqual([]);
    expect(() => restoreFocus(null, [])).not.toThrow();
  });

  it("Dialog records the fallbacks at open and restores through them on close", () => {
    const dialog = source.slice(source.indexOf("export function Dialog("), source.indexOf("export const DialogHeader"));
    expect(dialog).toContain("fallbacks.current = focusFallbacks(previouslyFocused.current);");
    expect(dialog).toContain("restoreFocus(previouslyFocused.current, fallbacks.current);");
    expect(dialog).not.toContain("previouslyFocused.current?.focus();");
  });
});
