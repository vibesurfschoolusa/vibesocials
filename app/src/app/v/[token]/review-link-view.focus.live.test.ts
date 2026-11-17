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
import { installKeeperOnFakePage } from "@/lib/focusKeeperDom.testkit";

import { ReviewLinkView } from "./review-link-view";

const UNCHECKED = "We couldn't check that just now. Nothing was changed. Try again in a minute.";

let root: Root;
let container: FakeNode;
let doc: FocusDoc;
let stopKeeper: () => void;
let made: ReturnType<typeof makeDocument>;
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
  made = makeDocument();
  container = made.container;
  doc = made.doc as unknown as FocusDoc;
  makeFocusable(doc);
  // R40: with the page's focus keeper, as on the live page.
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

// R40 client-journey L2: a 429 lasts its window, so there is nothing to press.
describe("/v: the network limit", () => {
  it("shows one instruction from Retry-After and no button", async () => {
    fetchMock.mockReturnValueOnce(
      Promise.resolve(
        Response.json(
          { error: "Too many requests from this network in the last hour. Try again later.", retryAfterSeconds: 1500 },
          { status: 429, headers: { "Retry-After": "1500" } },
        ),
      ),
    );
    await act(async () => {
      root.render(createElement(ReviewLinkView, { token: "tok" }));
    });
    await settle();
    expect(container.textContent).toBe("Too many requests from this network in the last hour. Reload this page in 25 minutes.");
    expect(find(container, (n) => n.nodeName === "BUTTON")).toBeNull();
  });
});

// R41 client-journey L2: the decisions share the network limit with the list,
// so every press within the window fails the same way: one instruction, no live button.
describe("/v: a card decision's 429", () => {
  beforeEach(() => {
    // focusAfterPress waits a frame for the page to change.
    const view = made.doc.defaultView as Record<string, unknown>;
    view.requestAnimationFrame = (step: () => void) => setTimeout(step, 0);
    view.setTimeout = setTimeout;
  });

  const card = (id: string) => ({
    id,
    scheduledFor: "2026-11-20T15:00:00.000Z",
    platforms: ["Instagram"],
    caption: `Post ${id}`,
    platformCaptions: [],
    media: null,
    mediaCount: 0,
    state: "pending",
    note: null,
    version: "v1",
  });

  function buttons(text: string): FakeNode[] {
    const found: FakeNode[] = [];
    const walk = (node: FakeNode) => {
      if (node.nodeName === "BUTTON" && (node.textContent as string).trim() === text) found.push(node);
      node.childNodes.forEach(walk);
    };
    walk(container);
    return found;
  }

  async function press(node: FakeNode) {
    (node.focus as () => void)();
    await act(async () => {
      void props(node).onClick({ currentTarget: node, preventDefault: () => {} });
    });
    await settle();
  }

  it("Looks good: the card says when to reload, and no decision can be pressed on any card", async () => {
    fetchMock
      .mockReturnValueOnce(Promise.resolve(Response.json({ posts: [card("a"), card("b")], more: false })))
      .mockReturnValueOnce(
        Promise.resolve(
          Response.json(
            { error: "Too many requests from this network in the last hour. Try again later.", retryAfterSeconds: 1500 },
            { status: 429, headers: { "Retry-After": "1500" } },
          ),
        ),
      );
    await act(async () => {
      root.render(createElement(ReviewLinkView, { token: "tok" }));
    });
    await settle();
    await press(buttons("Looks good")[0]);

    expect(container.textContent).toContain("Too many requests from this network in the last hour. Reload this page in 25 minutes.");
    expect(container.textContent).not.toContain("Try again later");
    for (const label of ["Looks good", "Ask for a change"]) {
      const found = buttons(label);
      expect(found).toHaveLength(2);
      for (const node of found) expect(props(node).disabled).toBe(true);
    }
    const active = doc.activeElement as FakeNode;
    expect(active.attributes.role).toBe("alert");
    expect(active.textContent).toBe("Too many requests from this network in the last hour. Reload this page in 25 minutes.");
  });

  it("Send: the typed note stays, and Send can't be pressed again", async () => {
    fetchMock
      .mockReturnValueOnce(Promise.resolve(Response.json({ posts: [card("a")], more: false })))
      .mockReturnValueOnce(
        Promise.resolve(
          Response.json(
            { error: "Too many requests from this network in the last hour. Try again later.", retryAfterSeconds: 300 },
            { status: 429, headers: { "Retry-After": "300" } },
          ),
        ),
      );
    await act(async () => {
      root.render(createElement(ReviewLinkView, { token: "tok" }));
    });
    await settle();
    await press(buttons("Ask for a change")[0]);
    const box = find(container, (n) => n.nodeName === "TEXTAREA")!;
    await act(async () => {
      void props(box).onChange({ target: { value: "Use the other photo" } });
    });
    const form = find(container, (n) => n.nodeName === "FORM")!;
    await act(async () => {
      void props(form).onSubmit({ preventDefault: () => {} });
    });
    await settle();

    expect(container.textContent).toContain("Too many requests from this network in the last hour. Reload this page in 5 minutes.");
    expect(props(find(container, (n) => n.nodeName === "TEXTAREA")!).value).toBe("Use the other photo");
    expect(props(buttons("Send")[0]).disabled).toBe(true);
  });
});
