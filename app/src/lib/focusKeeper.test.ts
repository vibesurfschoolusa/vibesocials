import { afterEach, describe, expect, it, vi } from "vitest";

import { focusAfterPress } from "./focusAfter";
import { installFocusKeeper, type KeeperEnv } from "./focusKeeper";

/**
 * R28 NN1: one keeper for the whole app. Presses that remove, disable or move
 * their own control (Activity's Retry, Add many's rows, Create's photos, the
 * account forms' success, /u Remove, /v) dropped focus to the page body, site
 * by site. A fake element tree, document and MutationObserver: vitest has no DOM.
 */
type Fake = {
  tagName: string;
  parentElement: Fake | null;
  children: Fake[];
  attrs: Record<string, string>;
  tabIndex: number;
  focus: ReturnType<typeof vi.fn>;
  hasAttribute(name: string): boolean;
  getAttribute(name: string): string | null;
  contains(other: Fake | null): boolean;
  readonly isConnected: boolean;
};

type Listener = (event: { type: string; target: Fake }) => void;

function makeWorld() {
  const listeners = new Map<string, Set<Listener>>();
  let observerCallback: ((records: unknown[]) => void) | null = null;
  const observed: unknown[] = [];

  const doc = {
    activeElement: null as Fake | null,
    body: null as unknown as Fake,
    documentElement: null as unknown as Fake,
    addEventListener(type: string, listener: Listener) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(listener);
    },
    removeEventListener(type: string, listener: Listener) {
      listeners.get(type)?.delete(listener);
    },
    querySelector() {
      const walk = (node: Fake): Fake | null => {
        const role = node.getAttribute("role");
        if ((role === "dialog" && node.getAttribute("aria-modal") === "true") || role === "alertdialog") return node;
        for (const child of node.children) {
          const found = walk(child);
          if (found) return found;
        }
        return null;
      };
      return walk(doc.documentElement);
    },
  };

  const fire = (type: string, target: Fake) => {
    for (const listener of listeners.get(type) ?? []) listener({ type, target });
  };

  function el(tagName: string, children: Fake[] = [], attrs: Record<string, string> = {}): Fake {
    const node: Fake = {
      tagName,
      parentElement: null,
      children,
      attrs,
      tabIndex: tagName === "BUTTON" ? 0 : -1,
      focus: vi.fn(() => {
        doc.activeElement = node;
        fire("focusin", node);
      }),
      hasAttribute: (name) => name in node.attrs,
      getAttribute: (name) => node.attrs[name] ?? null,
      contains(other) {
        for (let at = other; at; at = at.parentElement) if (at === node) return true;
        return false;
      },
      get isConnected() {
        let at: Fake = node;
        while (at.parentElement) at = at.parentElement;
        return at.tagName === "HTML";
      },
    };
    for (const child of children) child.parentElement = node;
    return node;
  }

  class FakeObserver {
    constructor(callback: (records: unknown[]) => void) {
      observerCallback = callback;
    }
    observe(target: unknown, options: unknown) {
      observed.push({ target, options });
    }
    disconnect() {
      observerCallback = null;
    }
  }

  /** The person (or the page) moved focus to `node`. */
  const focusOn = (node: Fake) => {
    doc.activeElement = node;
    fire("focusin", node);
  };
  /** React removed `node`; the browser leaves focus on the body when it held it. */
  const remove = (node: Fake) => {
    const parent = node.parentElement!;
    parent.children = parent.children.filter((child) => child !== node);
    node.parentElement = null;
    if (doc.activeElement && node.contains(doc.activeElement)) doc.activeElement = doc.body;
    observerCallback?.([{ type: "childList", target: parent, removedNodes: [node], addedNodes: [] }]);
  };
  const setAttr = (node: Fake, name: string, value = "") => {
    node.attrs[name] = value;
    if (doc.activeElement && node.contains(doc.activeElement) && name !== "aria-hidden") doc.activeElement = doc.body;
    observerCallback?.([{ type: "attributes", target: node, attributeName: name, removedNodes: [], addedNodes: [] }]);
  };
  /** A keyed item React moved: out and back in; the browser drops its focus. */
  const move = (node: Fake, toIndex: number) => {
    const parent = node.parentElement!;
    parent.children = parent.children.filter((child) => child !== node);
    parent.children.splice(toIndex, 0, node);
    if (doc.activeElement && node.contains(doc.activeElement)) doc.activeElement = doc.body;
    observerCallback?.([{ type: "childList", target: parent, removedNodes: [node], addedNodes: [node] }]);
  };
  const pointerDown = (node: Fake) => fire("pointerdown", node);

  const env = { doc, MutationObserver: FakeObserver } as unknown as KeeperEnv;
  return { doc, el, env, focusOn, remove, setAttr, move, pointerDown, fire, observed };
}

/** A page: a heading, then rows of a label and a button, inside main; a toast region beside it. */
function page(world: ReturnType<typeof makeWorld>) {
  const { el, doc } = world;
  const buttons = [el("BUTTON"), el("BUTTON"), el("BUTTON")];
  const rows = buttons.map((button) => el("LI", [el("P"), button]));
  const heading = el("H2");
  const list = el("UL", rows);
  const main = el("MAIN", [heading, list]);
  const toastButton = el("BUTTON");
  const toasts = el("DIV", [toastButton]);
  const body = el("BODY", [main, toasts]);
  const html = el("HTML", [body]);
  doc.body = body;
  doc.documentElement = html;
  doc.activeElement = body;
  return { buttons, rows, heading, list, main, toastButton, toasts, body };
}

let uninstall: (() => void) | null = null;
afterEach(() => {
  uninstall?.();
  uninstall = null;
});

function setup() {
  const world = makeWorld();
  const parts = page(world);
  uninstall = installFocusKeeper(world.env);
  return { ...world, ...parts };
}

describe("the focus keeper", () => {
  it("watches the whole document for removals and the attributes that take focus away", () => {
    const { observed, doc } = setup();
    expect(observed).toEqual([
      {
        target: doc,
        options: {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: ["disabled", "aria-hidden", "inert", "hidden"],
        },
      },
    ]);
  });

  it("removal: the next row's control takes focus, without scrolling", () => {
    const { buttons, rows, focusOn, remove, doc } = setup();
    focusOn(buttons[1]);
    remove(rows[1]);
    expect(buttons[2].focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(doc.activeElement).toBe(buttons[2]);
  });

  it("removal of the last rows: the previous row's, then the section heading", () => {
    const { buttons, rows, heading, focusOn, remove, doc } = setup();
    focusOn(buttons[2]);
    remove(rows[2]);
    expect(doc.activeElement).toBe(buttons[1]);
    remove(rows[1]);
    expect(doc.activeElement).toBe(buttons[0]);
    remove(rows[0]);
    expect(heading.focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(heading.tabIndex).toBe(-1);
    expect(doc.activeElement).toBe(heading);
  });

  it("a whole section replaced (a form swapped for its success line): the heading above", () => {
    const { buttons, list, heading, focusOn, remove, doc } = setup();
    focusOn(buttons[0]);
    remove(list);
    expect(doc.activeElement).toBe(heading);
  });

  it("disabling: the next usable control, skipping a disabled one", () => {
    const { buttons, focusOn, setAttr, doc } = setup();
    setAttr(buttons[1], "disabled");
    focusOn(buttons[0]);
    setAttr(buttons[0], "disabled");
    expect(buttons[1].focus).not.toHaveBeenCalled();
    expect(doc.activeElement).toBe(buttons[2]);
  });

  it("a fallback hidden since it was recorded is skipped: the heading", () => {
    const { buttons, rows, heading, focusOn, setAttr, doc } = setup();
    focusOn(buttons[0]);
    setAttr(rows[1], "aria-hidden", "true");
    setAttr(buttons[0], "disabled");
    expect(buttons[1].focus).not.toHaveBeenCalled();
    expect(doc.activeElement).toBe(heading);
  });

  it("a control inside a section that was hidden: the next usable one", () => {
    const { buttons, rows, focusOn, setAttr, doc } = setup();
    focusOn(buttons[0]);
    setAttr(rows[0], "inert");
    expect(doc.activeElement).toBe(buttons[1]);
  });

  it("a keyed item React moved: the same control takes focus again, without scrolling", () => {
    const { buttons, rows, focusOn, move, doc } = setup();
    focusOn(buttons[1]);
    move(rows[1], 2);
    expect(buttons[1].focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(doc.activeElement).toBe(buttons[1]);
  });

  it("a moved control whose press is still watched by focusAfterPress is focused again too", () => {
    const { buttons, rows, focusOn, move, doc } = setup();
    focusOn(buttons[1]);
    focusAfterPress(buttons[1] as never, undefined, {
      schedule: { frame: () => {}, later: () => {} },
      doc: doc as never,
    });
    move(rows[1], 0);
    expect(doc.activeElement).toBe(buttons[1]);
  });

  it("a press with its own focusAfterPress target: the keeper leaves the removal to it", () => {
    const { buttons, rows, focusOn, remove, doc } = setup();
    focusOn(buttons[1]);
    const stop = focusAfterPress(buttons[1] as never, undefined, {
      schedule: { frame: () => {}, later: () => {} },
      doc: doc as never,
    });
    remove(rows[1]);
    expect(buttons[2].focus).not.toHaveBeenCalled();
    expect(doc.activeElement).toBe(doc.body);
    stop();
  });

  it("never acts while a dialog is open", () => {
    const { buttons, rows, focusOn, remove, doc, el, body } = setup();
    const dialog = el("DIV", [el("BUTTON")], { role: "dialog", "aria-modal": "true" });
    dialog.parentElement = body;
    body.children.push(dialog);
    focusOn(buttons[1]);
    remove(rows[1]);
    expect(buttons[2].focus).not.toHaveBeenCalled();
    expect(doc.activeElement).toBe(doc.body);
  });

  it("never acts for a control that was inside a dialog: the dialog keeps its own restore", () => {
    const { focusOn, remove, doc, el, body, buttons } = setup();
    const confirm = el("BUTTON");
    const dialog = el("DIV", [confirm], { role: "dialog", "aria-modal": "true" });
    const portal = el("DIV", [dialog]);
    portal.parentElement = body;
    body.children.push(portal);
    focusOn(confirm);
    remove(portal);
    expect(buttons.some((button) => button.focus.mock.calls.length > 0)).toBe(false);
    expect(doc.activeElement).toBe(doc.body);
  });

  it("never acts when focus has moved anywhere other than the body", () => {
    const { buttons, rows, focusOn, remove, doc } = setup();
    focusOn(buttons[1]);
    // The page already moved focus to the new control before the old one went.
    doc.activeElement = buttons[0];
    remove(rows[1]);
    expect(buttons[2].focus).not.toHaveBeenCalled();
    expect(doc.activeElement).toBe(buttons[0]);
  });

  it("never acts after the person clicked into the page body on purpose", () => {
    const { buttons, rows, focusOn, remove, pointerDown, doc, main } = setup();
    focusOn(buttons[1]);
    pointerDown(main);
    doc.activeElement = doc.body;
    remove(rows[1]);
    expect(buttons[2].focus).not.toHaveBeenCalled();
    expect(doc.activeElement).toBe(doc.body);
  });

  it("a click on the focused control itself keeps it watched", () => {
    const { buttons, rows, focusOn, remove, pointerDown, doc } = setup();
    focusOn(buttons[1]);
    pointerDown(buttons[1]);
    remove(rows[1]);
    expect(doc.activeElement).toBe(buttons[2]);
  });

  it("a change elsewhere on the page never moves focus that is on the body", () => {
    const { buttons, rows, focusOn, remove, doc } = setup();
    focusOn(buttons[1]);
    doc.activeElement = doc.body;
    remove(rows[2]);
    expect(buttons[1].focus).not.toHaveBeenCalled();
    expect(buttons[0].focus).not.toHaveBeenCalled();
    expect(doc.activeElement).toBe(doc.body);
  });

  it("a control outside main (a toast's button) is left to its own region", () => {
    const { toastButton, focusOn, remove, doc, buttons } = setup();
    focusOn(toastButton);
    remove(toastButton);
    expect(buttons.some((button) => button.focus.mock.calls.length > 0)).toBe(false);
    expect(doc.activeElement).toBe(doc.body);
  });

  it("the fallbacks are read again at the press, so a row added since is the next one", () => {
    const { buttons, rows, focusOn, remove, fire, doc, el } = setup();
    focusOn(buttons[0]);
    const added = el("BUTTON");
    const addedRow = el("LI", [added]);
    const list = rows[0].parentElement!;
    addedRow.parentElement = list;
    list.children.splice(1, 0, addedRow);
    fire("keydown", buttons[0]);
    remove(rows[0]);
    expect(doc.activeElement).toBe(added);
  });

  it("installs once however many times it is mounted, and stops when the last goes", () => {
    const world = makeWorld();
    const { buttons, rows } = page(world);
    const first = installFocusKeeper(world.env);
    const second = installFocusKeeper(world.env);
    expect(world.observed).toHaveLength(1);
    first();
    world.focusOn(buttons[1]);
    world.remove(rows[1]);
    expect(world.doc.activeElement).toBe(buttons[2]);
    second();
    world.focusOn(buttons[0]);
    world.remove(rows[0]);
    expect(world.doc.activeElement).toBe(world.doc.body);
  });
});
