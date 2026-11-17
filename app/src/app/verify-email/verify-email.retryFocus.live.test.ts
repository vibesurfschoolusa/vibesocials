import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * R43 pages-a L2: Verify-email's Try again swapped the whole card for the
 * loading card, and the new-address page swapped its card for the answer, so
 * the focus keeper fell back to the logo link. Focus now goes to the loading
 * line while the answer is awaited (where the press left it free), then to the
 * result's heading. Mounted with the page's focus keeper, as on the live page.
 */

vi.mock("next/link", async () => {
  const { createElement: make } = await import("react");
  return {
    default: ({ href, children, className }: { href: string; children?: unknown; className?: string }) =>
      make("a", { href: String(href), className }, children as never),
  };
});
vi.mock("@/lib/signOutChecked", () => ({ signOutChecked: vi.fn(async () => ({ ok: true })) }));

import { makeDocument, type FakeNode } from "@/components/shell/fakeDom.testkit";
import { makeFocusable, type FocusDoc } from "@/lib/focusDom.testkit";
import { installKeeperOnFakePage } from "@/lib/focusKeeperDom.testkit";

import { NewAddressClient } from "./new-address/new-address-client";
import { UndoClient } from "./undo/undo-client";
import { VerifyEmailClient } from "./verify-email-client";

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

function button(text: string): FakeNode {
  const hit = find(container, (n) => n.nodeName === "BUTTON" && (n.textContent as string).trim() === text);
  if (!hit) throw new Error(`no button ${text}`);
  return hit;
}

async function settle() {
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

/** Focuses the button and presses it, as a keyboard press does. */
async function press(text: string) {
  const node = button(text);
  (node.focus as () => void)();
  await act(async () => {
    void props(node).onClick({ currentTarget: node, preventDefault() {} });
  });
  await settle();
}

const active = () => doc.activeElement as FakeNode;

/** A fetch answer the test gives later. */
function held(): { promise: Promise<Response>; give: (response: Response) => Promise<void> } {
  let resolve!: (value: Response) => void;
  const promise = new Promise<Response>((done) => (resolve = done));
  return {
    promise,
    give: async (response) => {
      await act(async () => resolve(response));
      await settle();
    },
  };
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const made = makeDocument();
  container = made.container;
  doc = made.doc as unknown as FocusDoc;
  makeFocusable(doc);
  stopKeeper = installKeeperOnFakePage(made as never).stop;
  Object.assign(made.doc.defaultView as object, { location: { hash: "#tok" } });
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

const account = () => Promise.resolve(Response.json({ emailVerified: false }));

describe("Verify email: focus after Try again", () => {
  it("goes to the loading line, then to the result's heading", async () => {
    const second = held();
    fetchMock
      .mockReturnValueOnce(Promise.resolve(Response.json({ error: "Internal" }, { status: 500 })))
      .mockReturnValueOnce(account())
      .mockReturnValueOnce(second.promise)
      .mockReturnValueOnce(account());
    await act(async () => {
      root.render(createElement(VerifyEmailClient));
    });
    await settle();

    await press("Try again");
    expect(active().attributes.role).toBe("status");
    expect(active().textContent).toBe("Verifying your email…");

    await second.give(Response.json({ ok: true }));
    expect(active().nodeName).toBe("H1");
    expect(active().textContent).toBe("Email verified");
  });

  it("a second failure: focus goes to its heading", async () => {
    const second = held();
    fetchMock
      .mockReturnValueOnce(Promise.resolve(Response.json({ error: "Internal" }, { status: 500 })))
      .mockReturnValueOnce(account())
      .mockReturnValueOnce(second.promise)
      .mockReturnValueOnce(account());
    await act(async () => {
      root.render(createElement(VerifyEmailClient));
    });
    await settle();

    await press("Try again");
    expect(active().attributes.role).toBe("status");
    await second.give(Response.json({ error: "Internal" }, { status: 500 }));
    expect(active().nodeName).toBe("H1");
    expect(active().textContent).toBe("Something went wrong on our side");
  });
});

describe("New address: focus after Use this email address and Try again", () => {
  it("the status line says it is working, then focus goes to the result's heading", async () => {
    const answer = held();
    fetchMock.mockReturnValueOnce(answer.promise);
    await act(async () => {
      root.render(createElement(NewAddressClient));
    });
    await settle();

    await press("Use this email address");
    const status = find(container, (n) => n.attributes.role === "status");
    expect(status?.textContent).toBe("Confirming your new email…");
    // The pressed button stays, busy, and keeps focus (components/ui/button.tsx).
    expect(active().nodeName).toBe("BUTTON");

    await answer.give(Response.json({ email: "new@example.test", viewer: "other_account" }));
    expect(active().nodeName).toBe("H1");
    expect(active().textContent).toBe("Your sign-in email was changed");
    expect(status?.textContent).toBe("");
  });

  it("Try again whose answer removes it: focus goes to the result's heading", async () => {
    const second = held();
    fetchMock
      .mockReturnValueOnce(Promise.resolve(Response.json({ error: "Internal" }, { status: 500 })))
      .mockReturnValueOnce(second.promise);
    await act(async () => {
      root.render(createElement(NewAddressClient));
    });
    await settle();
    await press("Use this email address");
    expect(active().nodeName).toBe("H1");
    expect(active().textContent).toBe("Something went wrong on our side");

    await press("Try again");
    expect(find(container, (n) => n.attributes.role === "status")?.textContent).toBe("Confirming your new email…");
    await second.give(Response.json({ used: true, error: "This link was already used." }, { status: 410 }));
    expect(active().nodeName).toBe("H1");
    expect(active().textContent).toBe("This link was already used");
  });
});

// R44 pages-a L1: a Try again that got the same answer back changed nothing on
// the page, so nothing was read out and focus stayed on Try again. The loading
// card now takes the answer's place while it runs, so the answer is new each time.
describe("a Try again that gets the same 429 back is announced", () => {
  const tooMany = () =>
    Promise.resolve(
      Response.json(
        { error: "Too many tries. Wait 15 minutes, then try again.", retryAfterSeconds: 900 },
        { status: 429, headers: { "Retry-After": "900" } },
      ),
    );

  for (const page of [
    { name: "New address", client: NewAddressClient, button: "Use this email address", loading: "Confirming your new email…", title: "Your email wasn't changed" },
    { name: "Undo", client: UndoClient, button: "Undo the change", loading: "Undoing the email change…", title: "The change wasn't undone" },
  ]) {
    it(`${page.name}: the loading line, then focus on the answer's heading again`, async () => {
      const second = held();
      fetchMock.mockReturnValueOnce(tooMany()).mockReturnValueOnce(second.promise);
      await act(async () => {
        root.render(createElement(page.client));
      });
      await settle();
      await press(page.button);
      const firstHeading = active();
      expect(firstHeading.nodeName).toBe("H1");
      expect(firstHeading.textContent).toBe(page.title);

      await press("Try again");
      const status = find(container, (n) => n.attributes.role === "status");
      expect(status?.textContent).toBe(page.loading);
      expect(active()).toBe(status);
      expect(find(container, (n) => n.nodeName === "BUTTON" && (n.textContent as string).trim() === "Try again")).toBeNull();

      await second.give(await tooMany());
      expect(active().nodeName).toBe("H1");
      expect(active().textContent).toBe(page.title);
      expect(active()).not.toBe(firstHeading);
      expect(status?.textContent).toBe("");
    });
  }
});
