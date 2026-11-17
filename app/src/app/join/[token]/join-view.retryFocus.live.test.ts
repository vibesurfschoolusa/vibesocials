import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * R42 pages-a L2: Join's Try again swaps the whole page for the loading view,
 * then for the invite card, so focus fell to the page body. After the press
 * focus goes to the loading line, then to the card's h1 or the new failure's
 * h1. Mounted with the page's focus keeper, as on the live page.
 */

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }) }));
// next/link's prefetch watch needs a browser; a plain <a> stands in.
vi.mock("next/link", async () => {
  const { createElement: make } = await import("react");
  return {
    default: ({ href, children, className }: { href: string; children?: unknown; className?: string }) =>
      make("a", { href: String(href), className }, children as never),
  };
});
vi.mock("@/components/ui/toast", () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn() }) }));

import { makeDocument, type FakeNode } from "@/components/shell/fakeDom.testkit";
import { makeFocusable, type FocusDoc } from "@/lib/focusDom.testkit";
import { installKeeperOnFakePage } from "@/lib/focusKeeperDom.testkit";

import { JoinView } from "./join-view";

let root: Root;
let container: FakeNode;
let doc: FocusDoc;
let stopKeeper: () => void;
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

async function settle() {
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

const active = () => doc.activeElement as FakeNode;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const made = makeDocument();
  container = made.container;
  doc = made.doc as unknown as FocusDoc;
  makeFocusable(doc);
  stopKeeper = installKeeperOnFakePage(made as never).stop;
  vi.stubGlobal("window", made.doc.defaultView);
  vi.stubGlobal("document", made.doc);
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  root = createRoot(container as unknown as HTMLElement);
});

afterEach(async () => {
  await act(async () => root.unmount());
  stopKeeper();
  vi.unstubAllGlobals();
});

async function failedThenTryAgain(next: Response): Promise<void> {
  let resolve!: (value: Response) => void;
  fetchMock
    .mockReturnValueOnce(Promise.resolve(Response.json({ error: "Internal" }, { status: 500 })))
    .mockReturnValueOnce(new Promise<Response>((done) => (resolve = done)));
  await act(async () => {
    root.render(createElement(JoinView, { token: "tok" }));
  });
  await settle();
  const again = find(container, (n) => n.nodeName === "BUTTON" && (n.textContent as string).trim() === "Try again")!;
  expect(again).not.toBeNull();
  (again.focus as () => void)();
  await act(async () => {
    void props(again).onClick();
  });
  await settle();
  expect(active().attributes.role).toBe("status");
  expect(active().textContent).toBe("Loading the invite…");
  await act(async () => resolve(next));
  await settle();
}

describe("Join: focus after Try again", () => {
  it("goes to the loading line, then to the invite card's heading", async () => {
    await failedThenTryAgain(Response.json({ workspaceId: "ws-1", workspaceName: "Surf Co", alreadyMember: false }));
    expect(active().nodeName).toBe("H1");
    expect(active().textContent).toBe("Join Surf Co?");
  });

  it("goes to the loading line, then to the new failure's heading", async () => {
    await failedThenTryAgain(Response.json({ error: "Internal" }, { status: 500 }));
    expect(active().nodeName).toBe("H1");
    expect(active().textContent).toBe("We couldn't load this invite.");
  });
});
