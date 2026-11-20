import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * R49 pages-a L4: /workspaces is drawn by the server, so after someone is
 * removed its list can be out of date. Open shows the switch route's refusal
 * as sent, and that sentence gives the step.
 */

vi.mock("@/lib/afterWorkspaceChange", () => ({ afterWorkspaceChange: vi.fn() }));
const { findFirstMock } = vi.hoisted(() => ({ findFirstMock: vi.fn() }));
vi.mock("@/lib/db", () => ({ prisma: { workspaceMember: { findFirst: findFirstMock } } }));
vi.mock("@/lib/workspace", () => ({
  ACTIVE_WORKSPACE_COOKIE: "vs_active_workspace",
  getWorkspaceContext: async () => ({ user: { id: "user-1" }, workspace: { id: "ws-1" }, role: "owner", memberCount: 1 }),
}));
vi.mock("@/lib/rateLimit", () => ({ checkRateLimit: async () => ({ allowed: true }) }));
vi.mock("next/headers", () => ({ cookies: async () => ({ set: vi.fn(), get: vi.fn() }) }));

import { makeDocument, type FakeNode } from "@/components/shell/fakeDom.testkit";
import { ToastProvider } from "@/components/ui/toast";

import { OpenWorkspaceButton } from "./open-workspace-button";

let root: Root;
let container: FakeNode;

function findAll(node: FakeNode, test: (n: FakeNode) => boolean, out: FakeNode[] = []): FakeNode[] {
  if (test(node)) out.push(node);
  for (const child of node.childNodes) findAll(child, test, out);
  return out;
}

function props(node: FakeNode): Record<string, (arg?: unknown) => unknown> {
  const key = Object.keys(node).find((k) => k.startsWith("__reactProps$"));
  return (node[key as string] ?? {}) as Record<string, (arg?: unknown) => unknown>;
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const made = makeDocument();
  container = made.container;
  Object.assign(made.doc.defaultView as object, { setTimeout, clearTimeout });
  vi.stubGlobal("window", made.doc.defaultView);
  vi.stubGlobal("document", made.doc);
  root = createRoot(container as unknown as HTMLElement);
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});

describe("Workspaces page Open: refused as no longer a member", () => {
  it("shows the switch route's own sentence, with its step", async () => {
    // The route's real answer for someone who is no longer a member.
    const { POST } = await import("@/app/api/workspaces/switch/route");
    findFirstMock.mockResolvedValue(null);
    const routeAnswer = await POST(
      new Request("http://localhost/api/workspaces/switch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspaceId: "ws-gone" }),
      }) as never,
    );
    expect(routeAnswer.status).toBe(403);
    vi.stubGlobal("fetch", vi.fn(async () => routeAnswer));

    await act(async () => {
      root.render(createElement(ToastProvider, null, createElement(OpenWorkspaceButton, { workspaceId: "ws-gone", name: "Old shop" })));
    });
    const button = findAll(container, (n) => n.nodeName === "BUTTON")[0]!;
    await act(async () => {
      void props(button).onClick();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(container.textContent).toContain(
      "You're no longer a member of that workspace. Reload the page to see your workspaces.",
    );
  });
});
