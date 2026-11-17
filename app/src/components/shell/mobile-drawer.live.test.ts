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
  vi.stubGlobal("document", made.doc);
  vi.stubGlobal("window", win);
  vi.stubGlobal("HTMLElement", class {});
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

  it("stays open while the width stays narrow", async () => {
    await act(async () => root.render(createElement(Harness)));
    await turnTo(false);
    expect(html(body)).toContain('aria-label="Navigation"');
    expect(body.style.overflow).toBe("hidden");
  });
});
