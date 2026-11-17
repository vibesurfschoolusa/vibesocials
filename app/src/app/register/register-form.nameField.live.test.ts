import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * R44 new-customer L3: the name field's maxLength cut a pasted name short
 * without a word. The paste now stays whole, a count says how long it is, and
 * Create account shows the route's own sentence.
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

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { REGISTER_NAME_MAX_LENGTH, RegisterForm } from "./register-form";

const ROUTE_SENTENCE = "Use a name of up to 48 characters, or leave it empty.";
const PASTED = "Sunrise Surf School and Paddle Board Rentals of South Florida, LLC";

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
  vi.stubGlobal("document", made.doc);
  vi.stubGlobal("window", made.doc.defaultView);
  sent = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown, init?: { method?: string; body?: string }) => {
      if (String(input) === "/api/auth/register") {
        sent.push(JSON.parse(init?.body ?? "{}"));
        return Response.json({ error: ROUTE_SENTENCE }, { status: 400 });
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

  it("stays whole, is counted, and Create account shows the route's sentence", async () => {
    expect(PASTED.length).toBe(66);
    const field = find(container, (n) => n.attributes.id === "name")!;
    expect(props(field).maxLength).toBeUndefined();
    await type("name", PASTED);
    expect(props(find(container, (n) => n.attributes.id === "name")!).value).toBe(PASTED);

    const countId = props(field)["aria-describedby"] as string;
    const count = find(container, (n) => n.attributes.id === countId);
    expect(count?.textContent).toContain("66 of 48 characters");

    await type("email", "owner@example.test");
    await type("password", "a long enough password");
    const form = find(container, (n) => n.nodeName === "FORM")!;
    await act(async () => {
      void props(form).onSubmit({ preventDefault() {} });
    });
    await settle();
    expect(sent).toEqual([{ email: "owner@example.test", password: "a long enough password", name: PASTED }]);
    expect(container.textContent).toContain(ROUTE_SENTENCE);
  });
});
