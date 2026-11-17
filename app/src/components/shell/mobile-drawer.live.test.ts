import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * R44 new-customer L4: the drawer and its menu button are md:hidden, so a
 * phone turned sideways with the drawer open hid it while its scroll lock
 * stayed, with no Close button or Esc in sight. The drawer closes when the
 * md width starts to match.
 */

vi.mock("next/navigation", () => ({ usePathname: () => "/" }));
vi.mock("./brand", () => ({ Brand: () => null }));
vi.mock("./nav-item", () => ({ NavItem: () => null }));

import { MobileDrawer } from "./mobile-drawer";
import { html, makeDocument, type FakeNode } from "./fakeDom.testkit";

let root: Root;
let container: FakeNode;
let body: FakeNode & { style: Record<string, unknown> };
let wide: boolean;
let queries: string[];
let mediaListeners: Set<(event: { matches: boolean }) => void>;
let keyListeners: Set<(event: { key: string; preventDefault: () => void }) => void>;

/** Something focusable: the menu button that opened the drawer, or a sidebar link. */
class FocusTarget {
  focus = vi.fn();
}
let menuButton: FocusTarget;
let sidebarCurrent: FocusTarget | null;
let sidebarFirst: FocusTarget;
let selectors: string[];

function Harness() {
  const [open, setOpen] = useState(true);
  return createElement(MobileDrawer, { open, onClose: () => setOpen(false) });
}

async function turnTo(matches: boolean) {
  wide = matches;
  await act(async () => {
    for (const listener of [...mediaListeners]) listener({ matches });
  });
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const made = makeDocument();
  container = made.container;
  body = made.doc.body as typeof body;
  body.style.overflow = "";
  // The drawer's focus handling asks its panel for a control; the fake DOM has none.
  const createElementPlain = made.doc.createElement as (tag: string) => FakeNode;
  made.doc.createElement = (tag: string) =>
    Object.assign(createElementPlain(tag), { querySelector: () => null, querySelectorAll: () => [], focus() {} });
  wide = false;
  queries = [];
  mediaListeners = new Set();
  const win = made.doc.defaultView as Record<string, unknown>;
  win.matchMedia = (query: string) => {
    queries.push(query);
    return {
      get matches() {
        return wide;
      },
      addEventListener: (_type: string, listener: (event: { matches: boolean }) => void) => mediaListeners.add(listener),
      removeEventListener: (_type: string, listener: (event: { matches: boolean }) => void) => mediaListeners.delete(listener),
    };
  };
  keyListeners = new Set();
  made.doc.addEventListener = (type: string, listener: (event: { key: string; preventDefault: () => void }) => void) => {
    if (type === "keydown") keyListeners.add(listener);
  };
  made.doc.removeEventListener = (type: string, listener: (event: { key: string; preventDefault: () => void }) => void) => {
    if (type === "keydown") keyListeners.delete(listener);
  };
  menuButton = new FocusTarget();
  sidebarCurrent = new FocusTarget();
  sidebarFirst = new FocusTarget();
  selectors = [];
  made.doc.activeElement = menuButton;
  // The sidebar, as the app frame renders it beside the drawer.
  made.doc.querySelector = (selector: string) => {
    selectors.push(selector);
    if (selector === 'aside nav[aria-label="Main"] a[aria-current="page"]') return sidebarCurrent;
    if (selector === 'aside nav[aria-label="Main"] a[href]') return sidebarFirst;
    return null;
  };
  vi.stubGlobal("document", made.doc);
  vi.stubGlobal("window", win);
  vi.stubGlobal("HTMLElement", FocusTarget);
  root = createRoot(container as unknown as HTMLElement);
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});

describe("MobileDrawer: the phone turns sideways while it is open", () => {
  it("closes, and the body scrolls again, when the md width starts to match", async () => {
    await act(async () => root.render(createElement(Harness)));
    expect(html(body)).toContain('aria-label="Navigation"');
    expect(body.style.overflow).toBe("hidden");
    expect(queries).toContain("(min-width: 768px)");

    await turnTo(true);
    expect(html(body)).not.toContain('aria-label="Navigation"');
    expect(body.style.overflow).toBe("");
    expect(mediaListeners.size).toBe(0);
  });

  // R44 review: the menu button is md:hidden at that width, so focus would land on the body.
  it("puts focus on the sidebar's current link, not the hidden menu button", async () => {
    await act(async () => root.render(createElement(Harness)));
    await turnTo(true);
    expect(sidebarCurrent!.focus).toHaveBeenCalledTimes(1);
    expect(menuButton.focus).not.toHaveBeenCalled();
  });

  it("with no current link, on the sidebar's first link", async () => {
    sidebarCurrent = null;
    await act(async () => root.render(createElement(Harness)));
    await turnTo(true);
    expect(sidebarFirst.focus).toHaveBeenCalledTimes(1);
    expect(menuButton.focus).not.toHaveBeenCalled();
  });

  it("an Escape close still returns focus to the menu button", async () => {
    await act(async () => root.render(createElement(Harness)));
    await act(async () => {
      for (const listener of [...keyListeners]) listener({ key: "Escape", preventDefault() {} });
    });
    expect(html(body)).not.toContain('aria-label="Navigation"');
    expect(menuButton.focus).toHaveBeenCalledTimes(1);
    expect(sidebarCurrent!.focus).not.toHaveBeenCalled();
  });

  it("stays open while the width stays narrow", async () => {
    await act(async () => root.render(createElement(Harness)));
    await turnTo(false);
    expect(html(body)).toContain('aria-label="Navigation"');
    expect(body.style.overflow).toBe("hidden");
  });
});
