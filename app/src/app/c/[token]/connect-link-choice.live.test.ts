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
const PRESS =
  "Too many requests from this network in the last hour. Wait 12 minutes, then connect the account again from the list on this page.";
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

async function mount(buttons: Record<string, string> = {}) {
  await act(async () => {
    root.render(createElement(ConnectLinkChoice, { token: "tok", pendingId: "p1", buttons }));
  });
  await settle();
}

/** The tab's storage, with what it already holds. */
function storage(entries: [string, string][] = []): Map<string, string> {
  const stored = new Map(entries);
  (made.doc.defaultView as Record<string, unknown>).sessionStorage = {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => stored.set(key, value),
  };
  return stored;
}

const limited = (seconds: number) =>
  Promise.resolve(
    Response.json(
      { error: CONNECT_LINK_RATE_LIMIT_MESSAGE, retryAfterSeconds: seconds },
      { status: 429, headers: { "Retry-After": String(seconds) } },
    ),
  );

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
  it("a 429 whose wait outlasts the choice names the step after the wait", async () => {
    fetchMock.mockReturnValueOnce(limited(1500));
    await mount();
    expect(container.textContent).toBe(
      "Too many requests from this network in the last hour. Wait 25 minutes, then connect the account again from the list on this page.",
    );
    expect(find(container, (n) => n.nodeName === "BUTTON")).toBeNull();
  });

  // R40 review L: the row shows Connect, or Reconnect when it has a connection.
  it("names the platform and the button its row shows", async () => {
    storage([["vs-connect-choice:p1", "facebook_page"]]);
    fetchMock.mockReturnValueOnce(limited(1500));
    await mount({ facebook_page: "Reconnect" });
    expect(container.textContent).toBe(
      "Too many requests from this network in the last hour. Wait 25 minutes, then press Reconnect beside Facebook Page again.",
    );
  });

  it("a new row names Connect", async () => {
    storage([["vs-connect-choice:p1", "facebook_page"]]);
    fetchMock.mockReturnValueOnce(limited(1500));
    await mount({ facebook_page: "Connect" });
    expect(container.textContent).toBe(
      "Too many requests from this network in the last hour. Wait 25 minutes, then press Connect beside Facebook Page again.",
    );
  });

  // R40 review M: the wait is compared with the life the choice has left.
  describe("the choice's life left", () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("first seen 6 minutes ago, a 12-minute wait: press again", async () => {
      storage([["vs-connect-choice-seen:p1", String(Date.now() - 6 * 60 * 1000)]]);
      fetchMock.mockReturnValueOnce(limited(720));
      await mount();
      expect(container.textContent).toBe(PRESS);
    });

    it("first seen just now, a 12-minute wait: reload", async () => {
      const stored = storage();
      fetchMock.mockReturnValueOnce(limited(720));
      await mount();
      expect(container.textContent).toBe("Too many requests from this network in the last hour. Reload this page in 12 minutes.");
      expect(stored.has("vs-connect-choice-seen:p1")).toBe(true);
    });

    it("without storage, counts from when the page opened", async () => {
      let now = Date.now();
      vi.spyOn(Date, "now").mockImplementation(() => now);
      fetchMock.mockReturnValueOnce(answer(503, { error: UNCHECKED })).mockReturnValueOnce(limited(720));
      await mount();
      now += 6 * 60 * 1000;
      await act(async () => {
        void props(button("Try again")!).onClick();
      });
      await settle();
      expect(container.textContent).toBe(PRESS);
    });
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

// R41 client-journey L1: the limit counts the list, Connect and Cancel together,
// so a press after the list loaded can get the same 429: one instruction, nothing to press.
describe("the /c account choice: a 429 on Connect or Cancel", () => {
  beforeEach(() => {
    // focusAfterPress waits a frame for the page to change; a long one, so
    // the render is in before it under a loaded run (press waits it out).
    const view = made.doc.defaultView as Record<string, unknown>;
    view.requestAnimationFrame = (step: () => void) => setTimeout(step, 50);
    view.setTimeout = setTimeout;
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function pressAfterLoad(text: string, next: Promise<Response>, buttons: Record<string, string> = {}) {
    fetchMock.mockReturnValueOnce(answer(200, READY)).mockReturnValueOnce(next);
    await mount(buttons);
    const pressed = button(text)!;
    (pressed.focus as () => void)();
    await act(async () => {
      void props(pressed).onClick({ currentTarget: pressed });
    });
    await settle();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 80));
    });
  }

  it("Connect: a wait inside the choice's life says to reload in N minutes, with nothing to press", async () => {
    await pressAfterLoad("Connect", limited(300));
    expect(container.textContent).toBe("Too many requests from this network in the last hour. Reload this page in 5 minutes.");
    expect(find(container, (n) => n.nodeName === "BUTTON")).toBeNull();
    const active = doc.activeElement as FakeNode;
    expect(active.attributes.role).toBe("alert");
  });

  it("Connect: a wait the choice won't outlive names the button its platform's row shows", async () => {
    await pressAfterLoad("Connect", limited(1500), { facebook_page: "Reconnect" });
    expect(container.textContent).toBe(
      "Too many requests from this network in the last hour. Wait 25 minutes, then press Reconnect beside Facebook Page again.",
    );
    expect(find(container, (n) => n.nodeName === "BUTTON")).toBeNull();
  });

  it("Connect: the wait is weighed against the life the choice has left", async () => {
    storage([["vs-connect-choice-seen:p1", String(Date.now() - 6 * 60 * 1000)]]);
    await pressAfterLoad("Connect", limited(720), { facebook_page: "Connect" });
    expect(container.textContent).toBe(
      "Too many requests from this network in the last hour. Wait 12 minutes, then press Connect beside Facebook Page again.",
    );
  });

  it("Cancel: a wait inside the choice's life says to reload in N minutes, with nothing to press", async () => {
    await pressAfterLoad("Cancel", limited(300));
    expect(container.textContent).toBe("Too many requests from this network in the last hour. Reload this page in 5 minutes.");
    expect(find(container, (n) => n.nodeName === "BUTTON")).toBeNull();
    const active = doc.activeElement as FakeNode;
    expect(active.attributes.role).toBe("alert");
  });

  it("Cancel: a wait the choice won't outlive says it ends by itself meanwhile", async () => {
    await pressAfterLoad("Cancel", limited(1500));
    expect(container.textContent).toBe(
      "Too many requests from this network in the last hour. Wait 25 minutes, then reload this page: the choice will have ended by itself, with no account connected.",
    );
    expect(find(container, (n) => n.nodeName === "BUTTON")).toBeNull();
  });

  // R43 client-journey L1: the load's own time left wins over this tab's first sighting,
  // which a second tab opened late would overstate.
  describe("the time left the load answered", () => {
    async function pressWithLifeLeft(text: string, lifeLeftSeconds: number, next: Promise<Response>) {
      storage();
      fetchMock.mockReturnValueOnce(answer(200, { ...READY, lifeLeftSeconds })).mockReturnValueOnce(next);
      await mount({ facebook_page: "Connect" });
      const pressed = button(text)!;
      (pressed.focus as () => void)();
      await act(async () => {
        void props(pressed).onClick({ currentTarget: pressed });
      });
      await settle();
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 80));
      });
    }

    it("Connect: 5 minutes left and an 8-minute wait says press again, though the tab first saw it just now", async () => {
      await pressWithLifeLeft("Connect", 300, limited(480));
      expect(container.textContent).toBe(
        "Too many requests from this network in the last hour. Wait 8 minutes, then press Connect beside Facebook Page again.",
      );
    });

    it("Cancel: 5 minutes left and an 8-minute wait says it ends by itself", async () => {
      await pressWithLifeLeft("Cancel", 300, limited(480));
      expect(container.textContent).toBe(
        "Too many requests from this network in the last hour. Wait 8 minutes, then reload this page: the choice will have ended by itself, with no account connected.",
      );
    });

    it("a wait well inside the time left still says reload", async () => {
      await pressWithLifeLeft("Connect", 300, limited(120));
      expect(container.textContent).toBe("Too many requests from this network in the last hour. Reload this page in 2 minutes.");
    });
  });

  // R41 review: "ends by itself" only when the rounded wait reaches the choice's end; Connect keeps its margin.
  describe("the margin: Connect only", () => {
    const seenAgo = (seconds: number) => storage([["vs-connect-choice-seen:p1", String(Date.now() - seconds * 1000)]]);

    it("721 s wait with 830 s left: Cancel says reload", async () => {
      seenAgo(70);
      await pressAfterLoad("Cancel", limited(721));
      expect(container.textContent).toBe("Too many requests from this network in the last hour. Reload this page in 13 minutes.");
    });

    it("721 s wait with 830 s left: Connect says press again", async () => {
      seenAgo(70);
      await pressAfterLoad("Connect", limited(721), { facebook_page: "Connect" });
      expect(container.textContent).toBe(
        "Too many requests from this network in the last hour. Wait 13 minutes, then press Connect beside Facebook Page again.",
      );
    });

    it("a wait beyond the life left: Cancel says it ends by itself", async () => {
      seenAgo(70);
      await pressAfterLoad("Cancel", limited(900));
      expect(container.textContent).toBe(
        "Too many requests from this network in the last hour. Wait 15 minutes, then reload this page: the choice will have ended by itself, with no account connected.",
      );
    });

    it("a wait beyond the life left: Connect says press again", async () => {
      seenAgo(70);
      await pressAfterLoad("Connect", limited(900), { facebook_page: "Connect" });
      expect(container.textContent).toBe(
        "Too many requests from this network in the last hour. Wait 15 minutes, then press Connect beside Facebook Page again.",
      );
    });
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
