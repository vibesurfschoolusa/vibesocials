import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * R43 pages-b L2: after a failed Cancel the ready footer had only Cancel and
 * Connect, so the only way out was Escape or the hidden backdrop. While the
 * cancel failure shows, the footer also has a Close that leaves.
 */

const replace = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace, push: vi.fn() }),
  useSearchParams: () => new URLSearchParams("choose=pc-1"),
}));
// The dialog's portal and focus trap need a browser; its parts pass through.
vi.mock("@/components/ui/dialog", () => {
  const pass = ({ children }: { children?: ReactNode }) => children ?? null;
  return {
    Dialog: pass,
    DialogBody: pass,
    DialogDescription: pass,
    DialogFooter: ({ children }: { children?: ReactNode }) => createElement("footer", null, children),
    DialogHeader: pass,
    DialogTitle: pass,
  };
});

import { makeDocument, type FakeNode } from "@/components/shell/fakeDom.testkit";

import { PendingConnectionDialog } from "./pending-connection-dialog";

let root: Root;
let container: FakeNode;
const fetchMock = vi.fn();

function find(node: FakeNode, test: (n: FakeNode) => boolean): FakeNode | null {
  if (test(node)) return node;
  for (const child of node.childNodes) {
    const hit = find(child, test);
    if (hit) return hit;
  }
  return null;
}

function props(node: FakeNode): Record<string, (arg?: unknown) => unknown> {
  const key = Object.keys(node).find((k) => k.startsWith("__reactProps$"));
  return node[key as string] as Record<string, (arg?: unknown) => unknown>;
}

function footerButtons(): string[] {
  const footer = find(container, (n) => n.nodeName === "FOOTER");
  const names: string[] = [];
  const walk = (node: FakeNode) => {
    if (node.nodeName === "BUTTON") names.push((node.textContent as string).trim());
    node.childNodes.forEach(walk);
  };
  if (footer) walk(footer);
  return names;
}

async function settle() {
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function press(text: string) {
  const node = find(container, (n) => n.nodeName === "BUTTON" && (n.textContent as string).trim() === text);
  if (!node) throw new Error(`no button ${text}`);
  await act(async () => {
    void props(node).onClick({ currentTarget: node, preventDefault() {} });
  });
  await settle();
}

const READY = { platform: "facebook_page", candidates: [{ id: "a", name: "Surf Shop" }, { id: "b", name: "Surf Club" }] };
const CANCEL_FAILED = "Couldn't cancel the choice just now. You can leave it: it ends by itself in 12 minutes.";

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const made = makeDocument();
  container = made.container;
  vi.stubGlobal("window", made.doc.defaultView);
  vi.stubGlobal("document", made.doc);
  vi.stubGlobal("navigator", { onLine: true });
  fetchMock.mockReset();
  replace.mockReset();
  fetchMock.mockImplementation((_url: string, init?: RequestInit) =>
    Promise.resolve(
      init?.method === "DELETE"
        ? Response.json({ error: CANCEL_FAILED }, { status: 503 })
        : Response.json(READY),
    ),
  );
  vi.stubGlobal("fetch", fetchMock);
  root = createRoot(container as unknown as HTMLElement);
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});

async function mount() {
  await act(async () => {
    root.render(createElement(PendingConnectionDialog, { workspaceId: "ws-1" }));
  });
  await settle();
}

const deletes = () => fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === "DELETE").length;

describe("PendingConnectionDialog: a way out after a failed Cancel", () => {
  it("before any failure the ready footer is Cancel and Connect only", async () => {
    await mount();
    expect(footerButtons()).toEqual(["Cancel", "Connect"]);
  });

  it("after a failed Cancel the footer has Close, which leaves without cancelling again", async () => {
    await mount();
    await press("Cancel");
    expect(deletes()).toBe(1);
    expect(replace).not.toHaveBeenCalled();
    expect(footerButtons()).toEqual(["Close", "Cancel", "Connect"]);

    await press("Close");
    expect(deletes()).toBe(1);
    expect(replace).toHaveBeenCalledWith("/settings");
  });
});
