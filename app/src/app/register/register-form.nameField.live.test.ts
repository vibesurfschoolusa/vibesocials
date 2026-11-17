import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * R44 new-customer L3: the name field's maxLength cut a pasted name short
 * without a word. The paste now stays whole, a count says how long it is, and
 * Create account shows the route's own sentence. R45 new-customer L1: without
 * sending it, since the route counts the network's sign-up try first.
 */

vi.mock("next/link", async () => {
  const { createElement: h } = await import("react");
  return { default: ({ href, children, ...rest }: { href: string; children: unknown }) => h("a", { href, ...rest }, children as never) };
});
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("next-auth/react", () => ({ signIn: vi.fn() }));
vi.mock("@/components/signed-in-swap", () => ({ useFreshSignedInAccount: () => null }));
vi.mock("@/components/google-sign-in-button", () => ({ GoogleSignInButton: () => null }));

import { makeDocument, type FakeNode } from "@/components/shell/fakeDom.testkit";
import { makeFocusable, type FocusDoc } from "@/lib/focusDom.testkit";

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { REGISTER_NAME_MAX_LENGTH, REGISTER_NAME_TOO_LONG_TEXT, RegisterForm } from "./register-form";

const ROUTE_SENTENCE = "Use a name of up to 48 characters, or leave it empty.";
const PASTED = "Sunrise Surf School and Paddle Board Rentals of South Florida, LLC";
let doc: FocusDoc;

let root: Root;
let container: FakeNode;
let sent: unknown[];

function find(node: FakeNode, test: (n: FakeNode) => boolean): FakeNode | null {
  if (test(node)) return node;
  for (const child of node.childNodes) {
    const hit = find(child, test);
    if (hit) return hit;
  }
  return null;
}

function props(node: FakeNode): Record<string, (arg?: unknown) => unknown> & Record<string, unknown> {
  const key = Object.keys(node).find((k) => k.startsWith("__reactProps$"));
  return node[key as string] as Record<string, (arg?: unknown) => unknown> & Record<string, unknown>;
}

async function settle() {
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function type(id: string, value: string) {
  const field = find(container, (n) => n.attributes.id === id)!;
  await act(async () => {
    props(field).onChange({ target: { value } });
  });
}

beforeEach(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const made = makeDocument();
  container = made.container;
  doc = made.doc as unknown as FocusDoc;
  makeFocusable(doc);
  vi.stubGlobal("document", made.doc);
  vi.stubGlobal("window", made.doc.defaultView);
  sent = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown, init?: { method?: string; body?: string }) => {
      if (String(input) === "/api/auth/register") {
        sent.push(JSON.parse(init?.body ?? "{}"));
        return Response.json({ error: "refused" }, { status: 400 });
      }
      return Response.json({});
    }),
  );
  root = createRoot(container as unknown as HTMLElement);
  await act(async () => {
    root.render(createElement(RegisterForm, { billing: { trialLine: null, agreement: { before: "", terms: "", between: "", privacy: "", after: "" } } }));
  });
  await settle();
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});

describe("Register: a pasted name longer than the limit", () => {
  it("counts against the route's own limit", () => {
    const route = readFileSync(join(__dirname, "../api/auth/register/route.ts"), "utf8");
    expect(route).toContain(`const REGISTER_NAME_MAX_LENGTH = ${REGISTER_NAME_MAX_LENGTH};`);
  });

  it("the sentence is the route's own", () => {
    const route = readFileSync(join(__dirname, "../api/auth/register/route.ts"), "utf8");
    expect(route).toContain("`Use a name of up to ${REGISTER_NAME_MAX_LENGTH} characters, or leave it empty.`");
    expect(REGISTER_NAME_TOO_LONG_TEXT).toBe(ROUTE_SENTENCE);
  });

  async function submit() {
    const form = find(container, (n) => n.nodeName === "FORM")!;
    await act(async () => {
      void props(form).onSubmit({ preventDefault() {} });
    });
    await settle();
  }

  it("stays whole, is counted, and Create account sends nothing: the route's sentence shows and Name takes the focus", async () => {
    expect(PASTED.length).toBe(66);
    const field = find(container, (n) => n.attributes.id === "name")!;
    expect(props(field).maxLength).toBeUndefined();
    await type("name", PASTED);
    expect(props(find(container, (n) => n.attributes.id === "name")!).value).toBe(PASTED);

    const countId = String(props(field)["aria-describedby"]);
    const count = find(container, (n) => n.attributes.id === countId);
    expect(count?.textContent).toContain("66 of 48 characters");

    await type("email", "owner@example.test");
    await type("password", "a long enough password");
    await submit();
    expect(sent).toEqual([]);
    const alert = find(container, (n) => n.attributes.role === "alert");
    expect(alert?.textContent).toContain(ROUTE_SENTENCE);
    expect(doc.activeElement).toBe(find(container, (n) => n.attributes.id === "name"));
  });

  it("52 characters: nothing is sent, and the hint names Create account's action", async () => {
    const name = "x".repeat(52);
    await type("name", name);
    await type("email", "owner@example.test");
    await type("password", "a long enough password");
    expect(find(container, (n) => n.attributes.id === "name-count")?.textContent).toBe(
      "52 of 48 characters (4 over). Shorten it to create your account.",
    );
    await submit();
    expect(sent).toEqual([]);
    expect(container.textContent).toContain(ROUTE_SENTENCE);
    expect(doc.activeElement).toBe(find(container, (n) => n.attributes.id === "name"));
  });

  it("under the limit: the name is sent as before", async () => {
    await type("name", "x".repeat(48));
    await type("email", "owner@example.test");
    await type("password", "a long enough password");
    await submit();
    expect(sent).toEqual([{ email: "owner@example.test", password: "a long enough password", name: "x".repeat(48) }]);
    expect(container.textContent).not.toContain(ROUTE_SENTENCE);
  });
});
