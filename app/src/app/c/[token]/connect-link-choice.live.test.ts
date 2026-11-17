import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * R39 pages L2: a client back from Facebook whose choice couldn't be loaded
 * (the limit store failed) reads "Try again in a minute" and gets a Try
 * again button that loads the choice again, as /v does.
 */

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));

import { html, makeDocument, type FakeNode } from "@/components/shell/fakeDom.testkit";
import { makeFocusable, type FocusDoc } from "@/lib/focusDom.testkit";

import { ConnectLinkChoice } from "./connect-link-choice";

const UNCHECKED = "We couldn't check that just now. Nothing was changed. Try again in a minute.";
const READY = { platform: "facebook_page", candidates: [{ id: "a", name: "Surf Co" }, { id: "b", name: "Surf Co Kids" }] };

let doc: FocusDoc;

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

function button(text: string): FakeNode | null {
  return find(container, (n) => n.nodeName === "BUTTON" && (n.textContent as string).trim() === text);
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

const answer = (status: number, body: unknown) => Promise.resolve(Response.json(body, { status }));

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const made = makeDocument();
  container = made.container;
  doc = made.doc as unknown as FocusDoc;
  makeFocusable(doc);
  vi.stubGlobal("window", made.doc.defaultView);
  vi.stubGlobal("document", made.doc);
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  root = createRoot(container as unknown as HTMLElement);
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});

async function mount() {
  await act(async () => {
    root.render(createElement(ConnectLinkChoice, { token: "tok", pendingId: "p1" }));
  });
  await settle();
}

describe("the /c account choice after a failed load", () => {
  it("a 503 shows the sentence with Try again, and Try again loads the choice", async () => {
    fetchMock.mockReturnValueOnce(answer(503, { error: UNCHECKED })).mockReturnValueOnce(answer(200, READY));
    await mount();

    expect(container.textContent).toContain(UNCHECKED);
    const retry = button("Try again");
    expect(retry).not.toBeNull();

    await act(async () => {
      void props(retry!).onClick();
    });
    await settle();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1][0])).toBe("/api/connect-link/tok/pending/p1");
    expect(html(container)).toContain("Surf Co Kids");
    expect(container.textContent).not.toContain(UNCHECKED);
    expect(button("Try again")).toBeNull();
  });

  it("a 404 keeps the gone sentence with nothing to press", async () => {
    const gone = "This choice has ended: it expired, or an account was already chosen. The list below shows what is connected.";
    fetchMock.mockReturnValueOnce(answer(404, { error: gone }));
    await mount();

    expect(container.textContent).toContain(gone);
    expect(find(container, (n) => n.nodeName === "BUTTON")).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

// R39 lead review: Try again removes itself, so focus fell to the page body.
describe("the /c account choice: focus after Try again", () => {
  function deferred() {
    let resolve!: (value: Response) => void;
    const promise = new Promise<Response>((done) => {
      resolve = done;
    });
    return { promise, resolve };
  }

  async function failedThenRetry(next: Response) {
    const later = deferred();
    fetchMock.mockReturnValueOnce(answer(503, { error: UNCHECKED })).mockReturnValueOnce(later.promise);
    await mount();
    const retry = button("Try again")!;
    (retry.focus as () => void)();
    await act(async () => {
      void props(retry).onClick();
    });
    await settle();
    const status = doc.activeElement as FakeNode;
    expect((status.textContent as string).trim()).toBe("Loading the accounts…");
    await act(async () => {
      later.resolve(next);
    });
    await settle();
    return status;
  }

  it("goes to the loading line, then to the accounts", async () => {
    await failedThenRetry(Response.json(READY));
    const active = doc.activeElement as FakeNode;
    expect(active.nodeName).toBe("H2");
    expect(active.textContent).toBe("Choose the account to connect");
  });

  it("goes to the loading line, then to the new error", async () => {
    await failedThenRetry(Response.json({ error: UNCHECKED }, { status: 503 }));
    const active = doc.activeElement as FakeNode;
    expect(active.attributes.role).toBe("alert");
    expect(active.textContent).toBe(UNCHECKED);
  });
});
