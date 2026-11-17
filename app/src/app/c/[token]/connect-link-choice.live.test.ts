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
import { CONNECT_LINK_RATE_LIMIT_MESSAGE } from "@/lib/connectLink";
import { makeFocusable, type FocusDoc } from "@/lib/focusDom.testkit";
import { installKeeperOnFakePage } from "@/lib/focusKeeperDom.testkit";

import { ConnectLinkChoice } from "./connect-link-choice";

const UNCHECKED = "We couldn't check that just now. Nothing was changed. Try again in a minute.";
const READY = { platform: "facebook_page", candidates: [{ id: "a", name: "Surf Co" }, { id: "b", name: "Surf Co Kids" }] };

let doc: FocusDoc;
let made: ReturnType<typeof makeDocument>;
let stopKeeper: (() => void) | null = null;

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
  made = makeDocument();
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
  stopKeeper?.();
  stopKeeper = null;
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

  // R39 lead's last look: the pending route's own 429 (body and header), one instruction, no button.
  it("a 429 with a wait inside the choice's life says to reload in N minutes, with nothing to press", async () => {
    fetchMock.mockReturnValueOnce(
      Promise.resolve(
        Response.json(
          { error: CONNECT_LINK_RATE_LIMIT_MESSAGE, retryAfterSeconds: 300 },
          { status: 429, headers: { "Retry-After": "300" } },
        ),
      ),
    );
    await mount();
    expect(container.textContent).toBe("Too many requests from this network in the last hour. Reload this page in 5 minutes.");
    expect(find(container, (n) => n.nodeName === "BUTTON")).toBeNull();
  });

  // R40 client-journey L3: the choice lives 15 minutes, so reloading after 25 shows it ended.
  it("a 429 whose wait outlasts the choice names Connect as the step after the wait", async () => {
    fetchMock.mockReturnValueOnce(
      Promise.resolve(
        Response.json(
          { error: CONNECT_LINK_RATE_LIMIT_MESSAGE, retryAfterSeconds: 1500 },
          { status: 429, headers: { "Retry-After": "1500" } },
        ),
      ),
    );
    await mount();
    expect(container.textContent).toBe(
      "Too many requests from this network in the last hour. Wait 25 minutes, then press Connect beside the platform you were connecting again.",
    );
    expect(find(container, (n) => n.nodeName === "BUTTON")).toBeNull();
  });

  it("names the platform when the page remembers it", async () => {
    const stored = new Map([["vs-connect-choice:p1", "facebook_page"]]);
    (made.doc.defaultView as Record<string, unknown>).sessionStorage = {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => stored.set(key, value),
    };
    fetchMock.mockReturnValueOnce(
      Promise.resolve(Response.json({ error: CONNECT_LINK_RATE_LIMIT_MESSAGE, retryAfterSeconds: 1500 }, { status: 429 })),
    );
    await mount();
    expect(container.textContent).toBe(
      "Too many requests from this network in the last hour. Wait 25 minutes, then press Connect beside Facebook Page again.",
    );
  });

  it("a 429 without a wait says to reload later", async () => {
    fetchMock.mockReturnValueOnce(answer(429, { error: CONNECT_LINK_RATE_LIMIT_MESSAGE }));
    await mount();
    expect(container.textContent).toBe("Too many requests from this network in the last hour. Reload this page later.");
    expect(find(container, (n) => n.nodeName === "BUTTON")).toBeNull();
  });

  it("a 429 whose wait is only in the header still names it", async () => {
    fetchMock.mockReturnValueOnce(
      Promise.resolve(Response.json({ error: CONNECT_LINK_RATE_LIMIT_MESSAGE }, { status: 429, headers: { "Retry-After": "60" } })),
    );
    await mount();
    expect(container.textContent).toBe("Too many requests from this network in the last hour. Reload this page in 1 minute.");
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
describe("the /c account choice: focus after Try again, with the page's focus keeper", () => {
  // R40 pages L1: the keeper moved focus to the Terms link before the retry's own focus ran.
  let terms: FakeNode;
  beforeEach(() => {
    const keeper = installKeeperOnFakePage(made as never);
    terms = keeper.terms;
    stopKeeper = keeper.stop;
  });

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

  it("goes to the loading line, then to the gone sentence", async () => {
    const gone = "This choice has ended: it expired, or an account was already chosen. The list below shows what is connected.";
    await failedThenRetry(Response.json({ error: gone }, { status: 404 }));
    const active = doc.activeElement as FakeNode;
    expect(active.textContent).toBe(gone);
    expect(active).not.toBe(terms);
  });
});
