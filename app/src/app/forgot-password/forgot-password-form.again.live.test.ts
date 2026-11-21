import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * R54 pages-a L3: the confirmation said "we sent a reset link", though the
 * route answers the same whether or not an email went out (no oracle). It now
 * says what to do if nothing arrives, and its button brings the form back
 * with the typed address, focus on that field. Mounted with the page's focus
 * keeper, as on the live page.
 */

import { makeDocument, type FakeNode } from "@/components/shell/fakeDom.testkit";
import { makeFocusable, type FocusDoc } from "@/lib/focusDom.testkit";
import { installKeeperOnFakePage } from "@/lib/focusKeeperDom.testkit";

import { ForgotPasswordForm } from "./forgot-password-form";

const CONFIRMATION =
  "If an account exists for that address, a reset link is on its way. If it doesn't arrive in a few minutes, check your spam folder, then press Try again. If you get more than one email, use the newest one: only its link works.";
const TOO_MANY = "Too many requests. Please wait a few minutes and try again.";
const GENERIC = "Something went wrong. Please try again.";

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

const field = () => find(container, (n) => n.nodeName === "INPUT" && n.attributes.id === "email");
const status = () => find(container, (n) => n.attributes.role === "status") as FakeNode;
const tryAgain = () => find(container, (n) => n.nodeName === "BUTTON" && (n.textContent as string).trim() === "Try again");
const active = () => doc.activeElement as FakeNode;
const pageText = () => container.textContent as string;

async function type(value: string) {
  await act(async () => {
    void props(field() as FakeNode).onChange({ target: { value } });
  });
}

async function send() {
  const form = find(container, (n) => n.nodeName === "FORM") as FakeNode;
  await act(async () => {
    void props(form).onSubmit({ preventDefault() {} });
  });
  await settle();
}

const sendButton = () =>
  find(container, (n) => n.nodeName === "BUTTON" && (n.textContent as string).trim() === "Send reset link");

/** Focuses Send reset link and submits, as a keyboard press does. */
async function pressSend() {
  (sendButton()!.focus as () => void)();
  await send();
}

/** Focuses Try again and presses it, as a keyboard press does. */
async function pressTryAgain() {
  const node = tryAgain() as FakeNode;
  (node.focus as () => void)();
  await act(async () => {
    void props(node).onClick({ currentTarget: node, preventDefault() {} });
  });
  await settle();
}

const ok = () => Promise.resolve(Response.json({ ok: true }));

beforeEach(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const made = makeDocument();
  container = made.container;
  doc = made.doc as unknown as FocusDoc;
  makeFocusable(doc);
  stopKeeper = installKeeperOnFakePage(made as never).stop;
  const view = made.doc.defaultView as unknown as Record<string, unknown>;
  view.requestAnimationFrame = (run: () => void) => setTimeout(run, 0);
  view.setTimeout = setTimeout;
  vi.stubGlobal("window", view);
  vi.stubGlobal("document", made.doc);
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  root = createRoot(container as unknown as HTMLElement);
  await act(async () => {
    root.render(createElement(ForgotPasswordForm));
  });
  await settle();
});

afterEach(async () => {
  await act(async () => root.unmount());
  stopKeeper();
  vi.unstubAllGlobals();
});

describe("Forgot password: the confirmation and Try again", () => {
  it("the confirmation claims no sent link and says what to do if nothing arrives, in the status region", async () => {
    fetchMock.mockReturnValueOnce(ok());
    await type("someone@example.test");
    await send();
    expect(status().textContent).toBe(CONFIRMATION);
    expect(pageText()).not.toMatch(/we sent/i);
    expect(field()).toBeNull();
    expect(tryAgain()).not.toBeNull();
  });

  // R55 new-customer L1, pages-a L1: each request cancels the unused link
  // before it, so the confirmation says only the newest email's link works,
  // the same sentence for every address.
  it("the confirmation names the newest-email rule, the same for any address", async () => {
    fetchMock.mockReturnValueOnce(ok()).mockReturnValueOnce(ok());
    await type("someone@example.test");
    await send();
    const first = status().textContent as string;
    expect(first).toContain("If you get more than one email, use the newest one: only its link works.");
    await pressTryAgain();
    await type("nobody@example.test");
    await send();
    expect(status().textContent).toBe(first);
  });

  it("Try again brings the form back with the address kept, focus on the address field", async () => {
    fetchMock.mockReturnValueOnce(ok());
    await type("someone@example.test");
    await send();

    await pressTryAgain();
    const input = field() as FakeNode;
    expect(input).not.toBeNull();
    expect(input.value).toBe("someone@example.test");
    expect(active()).toBe(input);
    expect(status().textContent).toBe("");
    expect(tryAgain()).toBeNull();
  });

  it("a second request goes through the same outcome rules: 429, failure, no answer, then the confirmation", async () => {
    fetchMock
      .mockReturnValueOnce(ok())
      .mockReturnValueOnce(Promise.resolve(Response.json({ error: "Too many requests." }, { status: 429 })))
      .mockReturnValueOnce(Promise.resolve(Response.json({ error: "Internal" }, { status: 500 })))
      .mockImplementationOnce(() => Promise.reject(new TypeError("Failed to fetch")))
      .mockReturnValueOnce(ok());
    await type("someone@example.test");
    await send();
    await pressTryAgain();

    await send();
    expect(pageText()).toContain(TOO_MANY);
    expect(field()).not.toBeNull();

    await send();
    expect(pageText()).toContain(GENERIC);

    await send();
    expect(pageText()).toContain("the request may have gone through");
    expect(field()).not.toBeNull();

    await send();
    expect(status().textContent).toBe(CONFIRMATION);
    expect(pageText()).not.toContain(GENERIC);
    expect(fetchMock).toHaveBeenCalledTimes(5);
    for (const call of fetchMock.mock.calls) {
      expect(JSON.parse(String((call[1] as { body: string }).body))).toEqual({ email: "someone@example.test" });
    }
  });

  it("the 429 and failure answers on a first request are unchanged", async () => {
    fetchMock
      .mockReturnValueOnce(Promise.resolve(Response.json({ error: "Too many requests." }, { status: 429 })))
      .mockReturnValueOnce(Promise.resolve(Response.json({ error: "Internal" }, { status: 500 })));
    await type("someone@example.test");
    await send();
    expect(pageText()).toContain(TOO_MANY);
    expect(status().textContent).toBe("");
    expect(tryAgain()).toBeNull();
    await send();
    expect(pageText()).toContain(GENERIC);
    expect(tryAgain()).toBeNull();
  });
});

// R55 pages-a L2: a successful send replaces the form, and its focused button
// goes with it. Focus goes to the Try again button the confirmation names.
describe("Forgot password: focus after Send reset link", () => {
  it("after a successful send, focus is on Try again", async () => {
    fetchMock.mockReturnValueOnce(ok());
    await type("someone@example.test");
    await pressSend();
    expect(status().textContent).toBe(CONFIRMATION);
    expect(active()).toBe(tryAgain());
  });

  it("after Try again, focus is on the email field, and a second send lands on Try again again", async () => {
    fetchMock.mockReturnValueOnce(ok()).mockReturnValueOnce(ok());
    await type("someone@example.test");
    await pressSend();
    await pressTryAgain();
    expect(active()).toBe(field());
    await pressSend();
    expect(active()).toBe(tryAgain());
  });

  it("after a refused send (429, failure, no answer), focus stays on Send reset link", async () => {
    fetchMock
      .mockReturnValueOnce(Promise.resolve(Response.json({ error: "Too many requests." }, { status: 429 })))
      .mockReturnValueOnce(Promise.resolve(Response.json({ error: "Internal" }, { status: 500 })))
      .mockImplementationOnce(() => Promise.reject(new TypeError("Failed to fetch")));
    await type("someone@example.test");
    for (const expected of [TOO_MANY, GENERIC, "the request may have gone through"]) {
      await pressSend();
      expect(pageText()).toContain(expected);
      expect(active()).toBe(sendButton());
    }
  });
});
