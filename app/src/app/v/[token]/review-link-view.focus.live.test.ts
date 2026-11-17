import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * R39 lead review: /v's Try again goes with the failure it answers, so focus
 * fell to the page body. It now goes to the loading line, then to what the
 * load shows: the list, or the new failure.
 */

import { makeDocument, type FakeNode } from "@/components/shell/fakeDom.testkit";
import { makeFocusable, type FocusDoc } from "@/lib/focusDom.testkit";

import { ReviewLinkView } from "./review-link-view";

const UNCHECKED = "We couldn't check that just now. Nothing was changed. Try again in a minute.";

let root: Root;
let container: FakeNode;
let doc: FocusDoc;
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

function deferred() {
  let resolve!: (value: Response) => void;
  const promise = new Promise<Response>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

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

async function failedThenRetry(next: Response): Promise<FakeNode> {
  const later = deferred();
  fetchMock
    .mockReturnValueOnce(Promise.resolve(Response.json({ error: UNCHECKED }, { status: 503 })))
    .mockReturnValueOnce(later.promise);
  await act(async () => {
    root.render(createElement(ReviewLinkView, { token: "tok" }));
  });
  await settle();

  const retry = find(container, (n) => n.nodeName === "BUTTON" && (n.textContent as string).trim() === "Try again")!;
  expect(retry).not.toBeNull();
  (retry.focus as () => void)();
  await act(async () => {
    void props(retry).onClick();
  });
  await settle();

  const status = doc.activeElement as FakeNode;
  expect(status.attributes.role).toBe("status");
  expect(status.textContent).toBe("Loading the posts…");

  await act(async () => {
    later.resolve(next);
  });
  await settle();
  return status;
}

describe("/v: focus after Try again", () => {
  it("goes to the loading line, then to the list", async () => {
    await failedThenRetry(Response.json({ posts: [], more: false }));
    const active = doc.activeElement as FakeNode;
    expect(active.textContent).toBe("Nothing is scheduled for the next 60 days.");
  });

  it("goes to the loading line, then to the new failure", async () => {
    await failedThenRetry(Response.json({ error: UNCHECKED }, { status: 503 }));
    const active = doc.activeElement as FakeNode;
    expect(active.attributes.role).toBe("alert");
    expect(active.textContent).toBe(UNCHECKED);
  });
});
