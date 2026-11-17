import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * R41 second look L1: Add many's "Loading your platforms" line was a plain
 * <p>, so LoadError's retry focus took it for the result. It is now a status
 * line: after Try again, focus goes to it, then to the platform checkboxes or
 * the new error's Try again. Mounted with the page's focus keeper.
 */

vi.mock("next/link", async () => {
  const { createElement: h } = await import("react");
  return { default: ({ href, children, ...rest }: { href: string; children: unknown }) => h("a", { href, ...rest }, children as never) };
});
vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams(), useRouter: () => ({ push() {}, refresh() {} }) }));
vi.mock("@vercel/blob/client", () => ({ upload: vi.fn() }));

import { makeDocument, type FakeNode } from "@/components/shell/fakeDom.testkit";
import { ToastProvider } from "@/components/ui/toast";
import { makeFocusable, type FocusDoc } from "@/lib/focusDom.testkit";
import { installKeeperOnFakePage } from "@/lib/focusKeeperDom.testkit";

import { BulkPostsForm } from "./bulk-posts-form";

let root: Root;
let container: FakeNode;
let doc: FocusDoc;
let stopKeeper: () => void;
let connections: () => Promise<Response>;

function find(node: FakeNode, test: (n: FakeNode) => boolean): FakeNode | null {
  if (test(node)) return node;
  for (const child of node.childNodes) {
    const hit = find(child, test);
    if (hit) return hit;
  }
  return null;
}

function button(text: string): FakeNode | null {
  return find(container, (n) => n.nodeName === "BUTTON" && (n.textContent as string).trim() === text);
}

function props(node: FakeNode): Record<string, (arg?: unknown) => unknown> {
  const key = Object.keys(node).find((k) => k.startsWith("__reactProps$"));
  return node[key as string] as Record<string, (arg?: unknown) => unknown>;
}

async function settle(ms = 120) {
  for (let i = 0; i < 3; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, ms / 3));
    });
  }
}

const failed = () => Promise.resolve(Response.json({ error: "Internal error" }, { status: 500 }));
const active = () => doc.activeElement as FakeNode;

beforeEach(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const made = makeDocument();
  container = made.container;
  doc = made.doc as unknown as FocusDoc;
  makeFocusable(doc);
  stopKeeper = installKeeperOnFakePage(made as never).stop;
  vi.stubGlobal("window", made.doc.defaultView);
  vi.stubGlobal("document", made.doc);
  vi.stubGlobal("navigator", { onLine: true });
  connections = failed;
  vi.stubGlobal(
    "fetch",
    vi.fn((input: unknown) => (String(input).startsWith("/api/connections") ? connections() : Promise.resolve(Response.json({})))),
  );
  vi.stubGlobal("requestAnimationFrame", (step: () => void) => setTimeout(step, 0));
  vi.stubGlobal("cancelAnimationFrame", (id: number) => clearTimeout(id));
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  Object.assign(made.doc.defaultView as object, {
    matchMedia: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }),
    location: { href: "http://localhost/posts/bulk" },
    localStorage: { getItem: () => null, setItem() {} },
    addEventListener() {},
    removeEventListener() {},
    setTimeout,
    clearTimeout,
  });
  root = createRoot(container as unknown as HTMLElement);
  await act(async () => {
    root.render(createElement(ToastProvider, null, createElement(BulkPostsForm, { workspaceId: "ws-1" })));
  });
  await settle();
});

afterEach(async () => {
  await act(async () => root.unmount());
  stopKeeper();
  vi.unstubAllGlobals();
});

async function tryAgainThrough(next: () => Promise<Response>) {
  let release!: () => void;
  connections = () =>
    new Promise<Response>((resolve) => {
      release = () => void next().then(resolve);
    });
  const retry = button("Try again");
  expect(retry).not.toBeNull();
  (retry!.focus as () => void)();
  await act(async () => {
    void props(retry!).onClick({ currentTarget: retry });
  });
  await settle();
  expect(active().getAttribute?.("role") ?? active().attributes.role).toBe("status");
  expect(active().textContent).toBe("Loading your platforms...");
  await act(async () => {
    release();
  });
  await settle();
}

describe("Add many: focus after Try again on the platforms", () => {
  it("goes to the loading status, then to the platform checkboxes", async () => {
    await tryAgainThrough(() => Promise.resolve(Response.json({ connections: [{ platform: "x", connected: true }] })));
    // The group of platform checkboxes that replaced the error.
    expect(active().nodeName).toBe("DIV");
    expect(find(active(), (n) => n.nodeName === "INPUT")).not.toBeNull();
    expect(active().textContent).toContain("X");
  });

  it("goes to the loading status, then to the new error's Try again", async () => {
    await tryAgainThrough(failed);
    expect(active()).toBe(button("Try again"));
  });
});
