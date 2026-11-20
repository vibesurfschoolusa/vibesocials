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
  let stored: Map<string, string>;
  beforeEach(() => {
    // focusAfterPress waits a frame for the page to change; a long one, so
    // the render is in before it under a loaded run (press waits it out).
    const view = made.doc.defaultView as Record<string, unknown>;
    view.requestAnimationFrame = (step: () => void) => setTimeout(step, 50);
    view.setTimeout = setTimeout;
    view.clearTimeout = clearTimeout;
    stored = new Map();
    view.sessionStorage = {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => stored.set(key, value),
      removeItem: (key: string) => stored.delete(key),
    };
  });

  const HOURLY = "Too many requests from this network in the last hour. Try again later.";
  const DAILY = "This link has reached today's limit. Try again tomorrow.";
  const NOTE = "Use the other photo";

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

  const listed = (...ids: string[]) => Promise.resolve(Response.json({ posts: ids.map(card), more: false }));
  const refused = (error: string, seconds?: number) =>
    Promise.resolve(
      Response.json(
        seconds === undefined ? { error } : { error, retryAfterSeconds: seconds },
        seconds === undefined ? { status: 429 } : { status: 429, headers: { "Retry-After": String(seconds) } },
      ),
    );

  function buttons(text: string): FakeNode[] {
    const found: FakeNode[] = [];
    const walk = (node: FakeNode) => {
      if (node.nodeName === "BUTTON" && (node.textContent as string).trim() === text) found.push(node);
      node.childNodes.forEach(walk);
    };
    walk(container);
    return found;
  }

  function all(test: (n: FakeNode) => boolean): FakeNode[] {
    const found: FakeNode[] = [];
    const walk = (node: FakeNode) => {
      if (test(node)) found.push(node);
      node.childNodes.forEach(walk);
    };
    walk(container);
    return found;
  }

  async function wait(ms: number) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, ms));
    });
  }

  async function press(node: FakeNode) {
    (node.focus as () => void)();
    await act(async () => {
      void props(node).onClick({ currentTarget: node, preventDefault: () => {} });
    });
    await settle();
    await wait(80);
  }

  async function open() {
    await act(async () => {
      root.render(createElement(ReviewLinkView, { token: "tok" }));
    });
    await settle();
  }

  /** Ask for a change on the first card, type the note, and Send. */
  async function typeAndSend() {
    await press(buttons("Ask for a change")[0]);
    const box = find(container, (n) => n.nodeName === "TEXTAREA")!;
    await act(async () => {
      void props(box).onChange({ target: { value: NOTE } });
    });
    const form = find(container, (n) => n.nodeName === "FORM")!;
    await act(async () => {
      void props(form).onSubmit({ preventDefault: () => {} });
    });
    await settle();
    await wait(80);
  }

  const noteBox = () => find(container, (n) => n.nodeName === "TEXTAREA");
  const isLimitText = (n: FakeNode) =>
    (n.textContent as string).startsWith("Too many") || (n.textContent as string).startsWith("This link");
  /** Inside a card's list item, or not. */
  const inCard = (n: FakeNode) => {
    for (let at: FakeNode | null = n; at; at = at.parentNode as FakeNode | null) if (at.nodeName === "LI") return true;
    return false;
  };
  /** The line atop the list: outside every card. */
  const pageLine = () => all((n) => n.nodeName === "P" && isLimitText(n) && !inCard(n))[0];
  /** R41 second look: a live region (alert, status, aria-live) whose own text is the sentence. */
  const liveWith = (text: string) =>
    all(
      (n) =>
        (n.attributes?.role === "alert" || n.attributes?.role === "status" || n.attributes?.["aria-live"] !== undefined) &&
        (n.textContent as string) === text,
    );

  it("Looks good: one sentence on the card and atop the list, and no decision on any card can be pressed", async () => {
    fetchMock.mockReturnValueOnce(listed("a", "b", "c")).mockReturnValueOnce(refused(HOURLY, 1500));
    await open();
    await press(buttons("Looks good")[0]);

    const sentence = "Too many requests from this network in the last hour. You can send again in 25 minutes.";
    expect(container.textContent).not.toContain("Try again later");
    expect(container.textContent).not.toContain("Reload");
    for (const label of ["Looks good", "Ask for a change"]) {
      const found = buttons(label);
      expect(found).toHaveLength(3);
      for (const node of found) expect(props(node).disabled).toBe(true);
    }
    // R41 review: card 3's greyed buttons have a reason in sight, atop the list.
    expect(pageLine()?.textContent).toBe(sentence);
    // R41 second look: read out once, by the pressed card's line; the top line is plain.
    expect(liveWith(sentence)).toHaveLength(1);
    expect(inCard(liveWith(sentence)[0])).toBe(true);
    const active = doc.activeElement as FakeNode;
    expect(active.attributes.role).toBe("alert");
    expect(active.textContent).toBe(sentence);
  });

  it("hourly: the decisions come back by themselves when the wait ends, with the note kept", async () => {
    fetchMock.mockReturnValueOnce(listed("a", "b")).mockReturnValueOnce(refused(HOURLY, 1));
    await open();
    await typeAndSend();

    expect(container.textContent).toContain("Too many requests from this network in the last hour. You can send again in 1 minute.");
    expect(props(noteBox()!).value).toBe(NOTE);
    expect(props(buttons("Send")[0]).disabled).toBe(true);
    expect(props(buttons("Looks good")[0]).disabled).toBe(true);

    await wait(1200);
    expect(props(buttons("Send")[0]).disabled).toBe(false);
    expect(props(buttons("Looks good")[0]).disabled).toBe(false);
    expect(props(noteBox()!).value).toBe(NOTE);
    expect(container.textContent).toContain("You can send again.");
    expect(container.textContent).not.toContain("You can send again in");
    expect(pageLine()).toBeUndefined();
  });

  it("a reload keeps the typed note, and Ask for a change opens it", async () => {
    fetchMock.mockReturnValueOnce(listed("a")).mockReturnValueOnce(refused(DAILY));
    await open();
    await typeAndSend();
    await act(async () => root.unmount());

    root = createRoot(container as unknown as HTMLElement);
    fetchMock.mockReturnValueOnce(listed("a"));
    await open();
    expect(noteBox()).toBeNull();
    await press(buttons("Ask for a change")[0]);
    expect(props(noteBox()!).value).toBe(NOTE);
  });

  // R41 second look: an approved card's Ask for a change must not reopen old text.
  it("a Looks good that went clears the kept note too", async () => {
    stored.set("vs-review-note:tok:a", NOTE);
    fetchMock
      .mockReturnValueOnce(listed("a"))
      .mockReturnValueOnce(Promise.resolve(Response.json({ state: "approved", version: "v2" })));
    await open();
    await press(buttons("Looks good")[0]);
    expect(container.textContent).toContain("You approved this");
    expect(stored.has("vs-review-note:tok:a")).toBe(false);
    await press(buttons("Ask for a change")[0]);
    expect(props(noteBox()!).value).toBe("");
  });

  it("a send that went clears the kept note", async () => {
    stored.set("vs-review-note:tok:a", NOTE);
    fetchMock
      .mockReturnValueOnce(listed("a"))
      .mockReturnValueOnce(Promise.resolve(Response.json({ state: "change_requested", note: NOTE })));
    await open();
    await press(buttons("Ask for a change")[0]);
    expect(props(noteBox()!).value).toBe(NOTE);
    await act(async () => {
      void props(find(container, (n) => n.nodeName === "FORM")!).onSubmit({ preventDefault: () => {} });
    });
    await settle();
    expect(String(fetchMock.mock.calls[1][1].body)).toContain(NOTE);
    expect(container.textContent).toContain("Change requested");
    expect(stored.has("vs-review-note:tok:a")).toBe(false);
  });

  // R42 client-journey L1: the list, the report and the decisions share the
  // network's hourly limit, so a list reload refused with 429 while the list
  // is on screen turns every decision off too, with one instruction that
  // lifts by itself.
  describe("a list reload refused by the network limit", () => {
    const alreadyApproved = () => Promise.resolve(Response.json({ state: "approved", already: true }));

    it("turns every card's decisions off, with one instruction, read out by the page line", async () => {
      fetchMock
        .mockReturnValueOnce(listed("a", "b", "c"))
        .mockReturnValueOnce(alreadyApproved())
        .mockReturnValueOnce(refused(HOURLY, 1500));
      await open();
      await press(buttons("Looks good")[0]);
      expect(fetchMock).toHaveBeenCalledTimes(3);

      const sentence = "Too many requests from this network in the last hour. You can send again in 25 minutes.";
      expect(pageLine()?.textContent).toBe(sentence);
      expect((container.textContent as string).match(/Too many requests/g)).toHaveLength(1);
      expect(container.textContent).not.toContain("Reload");
      for (const label of ["Looks good", "Ask for a change"]) {
        const found = buttons(label);
        expect(found).toHaveLength(3);
        for (const node of found) expect(props(node).disabled).toBe(true);
      }
      // R42 review: no card owns it, so the page line is the one live region,
      // and focus, which the turned-off button would drop, goes to it.
      expect(liveWith(sentence)).toHaveLength(1);
      expect(inCard(liveWith(sentence)[0])).toBe(false);
      expect(liveWith(sentence)[0]).toBe(pageLine());
      expect(doc.activeElement).toBe(pageLine());
    });

    it("after Reload the list: the same one live line, with focus on it", async () => {
      fetchMock
        .mockReturnValueOnce(listed("a", "b"))
        .mockReturnValueOnce(alreadyApproved())
        .mockReturnValueOnce(Promise.resolve(Response.json({ error: UNCHECKED }, { status: 503 })));
      await open();
      await press(buttons("Looks good")[0]);
      const reload = buttons("Reload the list")[0];
      expect(reload).toBeDefined();
      fetchMock.mockReturnValueOnce(refused(HOURLY, 1500));
      await press(reload);
      await wait(150);

      const sentence = "Too many requests from this network in the last hour. You can send again in 25 minutes.";
      expect(buttons("Reload the list")).toHaveLength(0);
      expect(liveWith(sentence)).toHaveLength(1);
      expect(liveWith(sentence)[0]).toBe(pageLine());
      expect(doc.activeElement).toBe(pageLine());
    });

    it("the end of the wait turns them back on, and says so once", async () => {
      fetchMock
        .mockReturnValueOnce(listed("a", "b"))
        .mockReturnValueOnce(alreadyApproved())
        .mockReturnValueOnce(refused(HOURLY, 1));
      await open();
      await press(buttons("Looks good")[0]);
      expect(props(buttons("Looks good")[1]).disabled).toBe(true);

      await wait(1200);
      for (const node of buttons("Looks good")) expect(props(node).disabled).toBe(false);
      expect(liveWith("You can send again.")).toHaveLength(1);
      expect(inCard(liveWith("You can send again.")[0])).toBe(false);
      expect((container.textContent as string).match(/You can send again/g)).toHaveLength(1);
      expect(container.textContent).not.toContain("Too many requests");
    });

    it("a card's own 429 keeps one live line, the card's, and its end is said once there", async () => {
      fetchMock.mockReturnValueOnce(listed("a", "b")).mockReturnValueOnce(refused(HOURLY, 1));
      await open();
      await press(buttons("Looks good")[0]);
      const sentence = "Too many requests from this network in the last hour. You can send again in 1 minute.";
      expect(liveWith(sentence)).toHaveLength(1);
      expect(inCard(liveWith(sentence)[0])).toBe(true);

      await wait(1200);
      expect(liveWith("You can send again.")).toHaveLength(1);
      expect(inCard(liveWith("You can send again.")[0])).toBe(true);
    });
  });

  // R41 lead: the per-link daily limit refuses every decision until it ends, the same rule.
  // R52 fix review: a reload that fails with the list on screen says the list
  // couldn't be refreshed, why, and names the button that is there (Reload
  // the list). The first load keeps its own sentences (below).
  describe("a list reload that fails with the list showing", () => {
    const OFFLINE = "Couldn't refresh the list. Check your connection, then press Reload the list.";
    const FAILED = "Couldn't refresh the list: something went wrong on our side. Press Reload the list in a minute.";
    const alreadyApproved = () => Promise.resolve(Response.json({ state: "approved", already: true }));

    async function reloadAnswers(answer: () => Promise<Response>): Promise<string> {
      fetchMock.mockReturnValueOnce(listed("a", "b")).mockReturnValueOnce(alreadyApproved()).mockImplementationOnce(answer);
      await open();
      await press(buttons("Looks good")[0]);
      expect(fetchMock).toHaveBeenCalledTimes(3);
      const alert = all((n) => n.attributes?.role === "alert" && n.nodeName === "DIV")[0];
      return alert ? (alert.textContent as string) : "";
    }

    it("a fetch that threw: check your connection, then Reload the list", async () => {
      const text = await reloadAnswers(async () => {
        throw new TypeError("Failed to fetch");
      });
      expect(text).toBe(`${OFFLINE}Reload the list`);
      expect(buttons("Reload the list")).toHaveLength(1);
    });

    it("a JSON 500 with its own error text: on our side, then Reload the list (not Try again)", async () => {
      const text = await reloadAnswers(async () => Response.json({ error: UNCHECKED }, { status: 500 }));
      expect(text).toBe(`${FAILED}Reload the list`);
      expect(text).not.toContain("Try again");
    });

    it("an HTML 5xx: on our side, then Reload the list", async () => {
      const text = await reloadAnswers(
        async () => new Response("<html>Gateway Timeout</html>", { status: 504, headers: { "content-type": "text/html" } }),
      );
      expect(text).toBe(`${FAILED}Reload the list`);
    });

    it("a 429: the wait, and no button that can't work yet", async () => {
      await reloadAnswers(() => refused(HOURLY, 1500));
      expect(container.textContent).toContain(
        "Too many requests from this network in the last hour. You can send again in 25 minutes.",
      );
      expect(buttons("Reload the list")).toHaveLength(0);
      expect(container.textContent).not.toContain("Couldn't refresh the list");
    });
  });

  describe("the link's daily limit", () => {
    it("Looks good: the wait from Retry-After, on the card and atop the list, and no decision can be pressed", async () => {
      fetchMock.mockReturnValueOnce(listed("a", "b")).mockReturnValueOnce(refused(DAILY, 5 * 3600));
      await open();
      await press(buttons("Looks good")[0]);

      const sentence = "This link has reached today's limit. Reload this page in 5 hours.";
      expect(container.textContent).toContain(sentence);
      expect(pageLine()?.textContent).toBe(sentence);
      for (const label of ["Looks good", "Ask for a change"]) {
        const found = buttons(label);
        expect(found).toHaveLength(2);
        for (const node of found) expect(props(node).disabled).toBe(true);
      }
      const active = doc.activeElement as FakeNode;
      expect(active.attributes.role).toBe("alert");
    });

    it("Send with no wait named: the route's sentence, the note stays, Send is off, and Cancel can reopen it", async () => {
      fetchMock.mockReturnValueOnce(listed("a", "b")).mockReturnValueOnce(refused(DAILY));
      await open();
      await typeAndSend();

      expect(container.textContent).toContain(DAILY);
      expect(props(noteBox()!).value).toBe(NOTE);
      expect(props(buttons("Send")[0]).disabled).toBe(true);

      await press(buttons("Cancel")[0]);
      expect(noteBox()).toBeNull();
      // The note with text can be opened again; the other card has none to open.
      const asks = buttons("Ask for a change");
      expect(props(asks[0]).disabled).toBe(false);
      expect(props(asks[1]).disabled).toBe(true);
      await press(asks[0]);
      expect(props(noteBox()!).value).toBe(NOTE);
      expect(props(buttons("Send")[0]).disabled).toBe(true);
    });
  });
});

// R52 pages-a L5: only no answer at all says to check the connection. A
// server failure came over a working connection, and a 429 says its wait.
describe("/v: why the first load failed", () => {
  const OFFLINE = "Couldn't load the posts. Check your connection and try again.";
  const FAILED = "Couldn't load the posts: something went wrong on our side. Try again in a minute.";

  async function firstLoad(answer: () => Promise<Response>): Promise<string> {
    fetchMock.mockImplementationOnce(answer);
    await act(async () => {
      root.render(createElement(ReviewLinkView, { token: "tok" }));
    });
    await settle();
    const alert = find(container, (n) => n.attributes?.role === "alert");
    return alert ? (alert.textContent as string) : (container.textContent as string);
  }

  it("a fetch that threw: check your connection", async () => {
    expect(
      await firstLoad(async () => {
        throw new TypeError("Failed to fetch");
      }),
    ).toBe(OFFLINE);
  });

  it("a 500 with JSON: the route's own sentence, as before", async () => {
    expect(await firstLoad(async () => Response.json({ error: UNCHECKED }, { status: 500 }))).toBe(UNCHECKED);
  });

  it("a 500 with JSON but no sentence: it failed on our side", async () => {
    expect(await firstLoad(async () => Response.json({}, { status: 500 }))).toBe(FAILED);
  });

  it("a 5xx that isn't JSON (a gateway page): it failed on our side, not the connection", async () => {
    expect(
      await firstLoad(
        async () => new Response("<html>Gateway Timeout</html>", { status: 504, headers: { "content-type": "text/html" } }),
      ),
    ).toBe(FAILED);
  });

  it("a 429 with retryAfterSeconds: the shared wait words, no button", async () => {
    expect(
      await firstLoad(async () =>
        Response.json({ error: "Too many requests from this network in the last hour. Try again later.", retryAfterSeconds: 600 }, { status: 429 }),
      ),
    ).toContain("Too many requests from this network in the last hour. Reload this page in 10 minutes.");
    expect(find(container, (n) => n.nodeName === "BUTTON")).toBeNull();
  });

  it("a 429 without a wait: reload later", async () => {
    expect(await firstLoad(async () => new Response("", { status: 429 }))).toContain(
      "Too many requests from this network in the last hour. Reload this page later.",
    );
  });

  it("a 404 and a 401: the route's own sentence, unchanged", async () => {
    expect(await firstLoad(async () => Response.json({ error: "This link has expired." }, { status: 404 }))).toBe(
      "This link has expired.",
    );
    await act(async () => root.unmount());
    root = createRoot(container as unknown as HTMLElement);
    expect(await firstLoad(async () => Response.json({ error: "Signed out." }, { status: 401 }))).toBe("Signed out.");
  });

  it("OK: shows what it loaded", async () => {
    await firstLoad(async () => Response.json({ posts: [], more: false }));
    expect(container.textContent).toContain("Nothing is scheduled for the next 60 days.");
    expect(find(container, (n) => n.attributes?.role === "alert")).toBeNull();
  });
});
