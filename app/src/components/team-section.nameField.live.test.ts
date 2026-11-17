import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * R44 new-customer L3: the rename field's maxLength cut a pasted name short
 * without a word. The paste now stays whole, a count says how long it is, and
 * Save shows the route's own sentence.
 */

const { toastError } = vi.hoisted(() => ({ toastError: vi.fn() }));

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock("next-auth/react", () => ({ useSession: () => ({ data: null }), signOut: vi.fn() }));
vi.mock("@/components/ui/toast", () => ({ useToast: () => ({ success: vi.fn(), error: toastError }) }));

import { makeDocument, type FakeNode } from "@/components/shell/fakeDom.testkit";

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { TeamSection, WORKSPACE_NAME_MAX_LENGTH } from "./team-section";

const ROUTE_SENTENCE = "Name must be 1-60 characters.";
const PASTED = "Sunrise Surf School and Paddle Board Rentals of South Florida, LLC";

let root: Root;
let container: FakeNode;
let renames: unknown[];

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

beforeEach(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const made = makeDocument();
  container = made.container;
  vi.stubGlobal("document", made.doc);
  vi.stubGlobal("window", made.doc.defaultView);
  renames = [];
  toastError.mockReset();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown, init?: { method?: string; body?: string }) => {
      if (String(input) === "/api/workspaces/active" && init?.method === "PATCH") {
        renames.push(JSON.parse(init.body ?? "{}"));
        return Response.json({ error: ROUTE_SENTENCE }, { status: 400 });
      }
      return Response.json({});
    }),
  );
  root = createRoot(container as unknown as HTMLElement);
  await act(async () => {
    root.render(createElement(TeamSection, { workspaceId: "ws-1", role: "owner", workspaceName: "Surf Co" }));
  });
  await settle();
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});

describe("Team: a pasted workspace name longer than the limit", () => {
  it("counts against the rename route's own limit", () => {
    const route = readFileSync(join(__dirname, "../app/api/workspaces/active/route.ts"), "utf8");
    expect(route).toContain(`const NAME_MAX_LENGTH = ${WORKSPACE_NAME_MAX_LENGTH};`);
  });

  it("stays whole, is counted, and Save shows the route's sentence", async () => {
    expect(PASTED.length).toBe(66);
    const field = find(container, (n) => n.attributes.id === "workspace-name")!;
    expect(props(field).maxLength).toBeUndefined();
    await act(async () => {
      props(field).onChange({ target: { value: PASTED } });
    });
    expect(props(field).value).toBe(PASTED);

    const countId = props(field)["aria-describedby"] as string;
    const count = find(container, (n) => n.attributes.id === countId);
    expect(count?.textContent).toContain("66 of 60 characters");

    const save = find(container, (n) => n.nodeName === "BUTTON" && (n.textContent as string).trim() === "Save")!;
    await act(async () => {
      void props(save).onClick({ currentTarget: save });
    });
    await settle();
    expect(renames).toEqual([{ name: PASTED, workspaceId: "ws-1" }]);
    expect(toastError).toHaveBeenCalledWith(ROUTE_SENTENCE);
  });
});
