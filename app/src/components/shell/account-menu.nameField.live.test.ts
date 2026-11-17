import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * R44 new-customer L3: New workspace's maxLength cut a pasted name short
 * without a word. The paste now stays whole, a count says how long it is, and
 * Create shows the route's own sentence.
 */

const { toastError } = vi.hoisted(() => ({ toastError: vi.fn() }));

vi.mock("next/link", async () => {
  const { createElement: h } = await import("react");
  return { default: ({ href, children, ...rest }: { href: string; children: unknown }) => h("a", { href, ...rest }, children as never) };
});
vi.mock("next-auth/react", () => ({ useSession: () => ({ status: "authenticated" }) }));
vi.mock("@/components/signed-in-swap", () => ({ useSignedInAccount: () => ({ name: "Owner", email: "owner@example.test" }) }));
vi.mock("@/components/ui/toast", () => ({ useToast: () => ({ success: vi.fn(), error: toastError }) }));
vi.mock("./install-app", () => ({ InstallInstructionsDialog: () => null, useInstallApp: () => ({ available: false, instructionsOpen: false, setInstructionsOpen() {}, install() {} }) }));
vi.mock("./theme-toggle", () => ({ ThemeToggle: () => null }));

import { makeFocusable, type FocusDoc } from "@/lib/focusDom.testkit";

import { makeDocument, type FakeNode } from "./fakeDom.testkit";

import { WORKSPACE_NAME_MAX_LENGTH } from "@/app/api/workspaces/route";

import { AccountMenu, NEW_WORKSPACE_NAME_MAX_LENGTH } from "./account-menu";

const ROUTE_SENTENCE = "Give the workspace a name of up to 60 characters.";
const PASTED = "Sunrise Surf School and Paddle Board Rentals of South Florida, LLC";

let root: Root;
let container: FakeNode;
let created: unknown[];

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

function button(text: string): FakeNode {
  const hit = find(container, (n) => n.nodeName === "BUTTON" && (n.textContent as string).trim().endsWith(text));
  if (!hit) throw new Error(`no ${text} button`);
  return hit;
}

async function settle() {
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function click(node: FakeNode) {
  await act(async () => {
    void props(node).onClick({ currentTarget: node, preventDefault() {} });
  });
  await settle();
}

beforeEach(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const made = makeDocument();
  container = made.container;
  makeFocusable(made.doc as unknown as FocusDoc);
  vi.stubGlobal("document", made.doc);
  vi.stubGlobal("window", made.doc.defaultView);
  created = [];
  toastError.mockReset();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown, init?: { method?: string; body?: string }) => {
      if (String(input) === "/api/workspaces" && init?.method === "POST") {
        created.push(JSON.parse(init.body ?? "{}"));
        return Response.json({ error: ROUTE_SENTENCE }, { status: 400 });
      }
      if (String(input) === "/api/workspaces") {
        return Response.json({ workspaces: [{ id: "ws-1", name: "Surf Co", role: "owner", isActive: true }] });
      }
      return Response.json({});
    }),
  );
  root = createRoot(container as unknown as HTMLElement);
  await act(async () => {
    root.render(createElement(AccountMenu));
  });
  await settle();
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});

describe("Account menu: a pasted New workspace name longer than the limit", () => {
  it("counts against the create route's own limit", () => {
    expect(NEW_WORKSPACE_NAME_MAX_LENGTH).toBe(WORKSPACE_NAME_MAX_LENGTH);
  });

  it("stays whole, is counted, and Create shows the route's sentence", async () => {
    expect(PASTED.length).toBe(66);
    await click(find(container, (n) => n.nodeName === "BUTTON" && n.attributes["aria-expanded"] !== undefined)!);
    await click(button("New workspace"));

    const field = find(container, (n) => n.nodeName === "INPUT" && n.attributes["aria-label"] === "New workspace name")!;
    expect(props(field).maxLength).toBeUndefined();
    await act(async () => {
      props(field).onChange({ target: { value: PASTED } });
    });
    expect(props(field).value).toBe(PASTED);

    const countId = props(field)["aria-describedby"] as string;
    const count = find(container, (n) => n.attributes.id === countId);
    expect(count?.textContent).toContain("66 of 60 characters");

    const form = find(container, (n) => n.nodeName === "FORM")!;
    await act(async () => {
      void props(form).onSubmit({ preventDefault() {} });
    });
    await settle();
    expect(created).toEqual([{ name: PASTED }]);
    expect(toastError).toHaveBeenCalledWith(ROUTE_SENTENCE);
  });
});
