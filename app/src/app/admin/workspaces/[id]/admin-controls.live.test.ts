import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * R41 pages L7: Pause and Resume say what they did in the status line, as
 * Limits ("Limits saved.") and Billing ("Trial ended.") do. Before, a
 * successful change left the line empty and only swapped the button.
 */

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));

import { makeDocument, type FakeNode } from "@/components/shell/fakeDom.testkit";

import { AdminPauseControls } from "./admin-controls";

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

function props(node: FakeNode): Record<string, (arg?: unknown) => unknown> {
  const key = Object.keys(node).find((k) => k.startsWith("__reactProps$"));
  return node[key as string] as Record<string, (arg?: unknown) => unknown>;
}

function statusText(): string {
  return find(container, (n) => n.attributes.role === "status")!.textContent as string;
}

async function settle() {
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function press(text: string) {
  const node = find(container, (n) => n.nodeName === "BUTTON" && (n.textContent as string).trim() === text)!;
  await act(async () => {
    void props(node).onClick();
  });
  await settle();
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const made = makeDocument();
  container = made.container;
  vi.stubGlobal("window", made.doc.defaultView);
  vi.stubGlobal("document", made.doc);
  fetchMock.mockReset();
  fetchMock.mockImplementation(() => Promise.resolve(Response.json({ changed: true })));
  vi.stubGlobal("fetch", fetchMock);
  root = createRoot(container as unknown as HTMLElement);
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});

describe("Pause and Resume are announced", () => {
  it("Pause says Workspace paused.", async () => {
    await act(async () => root.render(createElement(AdminPauseControls, { workspaceId: "ws-1", paused: false })));
    const reason = find(container, (n) => n.nodeName === "TEXTAREA")!;
    await act(async () => {
      props(reason).onChange({ target: { value: "Spam reports" } });
    });
    await press("Pause workspace");
    expect(statusText()).toBe("Workspace paused.");
  });

  it("Resume says Workspace resumed.", async () => {
    await act(async () => root.render(createElement(AdminPauseControls, { workspaceId: "ws-1", paused: true })));
    await press("Resume workspace");
    expect(statusText()).toBe("Workspace resumed.");
  });

  it("no change keeps its own sentence", async () => {
    fetchMock.mockImplementation(() => Promise.resolve(Response.json({ changed: false })));
    await act(async () => root.render(createElement(AdminPauseControls, { workspaceId: "ws-1", paused: true })));
    await press("Resume workspace");
    expect(statusText()).toBe("It was not paused.");
  });
});

// R46 pages-a L4: the pause reason has no maxLength that cuts a paste short.
// Its count says when it is over, and the press is refused with the route's
// own sentence (validatePauseBody), as every other counted field is.
describe("the pause reason is never cut short", () => {
  it("a 400-character paste stays whole, the count shows it, and the press is refused with the route's sentence", async () => {
    const { PAUSE_REASON_MAX_LENGTH, validatePauseBody } = await import("@/server/admin/actions");
    await act(async () => root.render(createElement(AdminPauseControls, { workspaceId: "ws-1", paused: false })));
    const reason = find(container, (n) => n.nodeName === "TEXTAREA")!;
    const focus = vi.fn();
    reason.focus = focus;
    const pasted = "r".repeat(400);
    await act(async () => {
      props(reason).onChange({ target: { value: pasted } });
    });
    expect(props(reason).maxLength).toBeUndefined();
    expect(props(reason).value).toBe(pasted);
    const countId = reason.attributes["aria-describedby"];
    expect(countId).toBeTruthy();
    const count = find(container, (n) => n.attributes.id === countId)!;
    expect(count.textContent).toBe(
      `400 of ${PAUSE_REASON_MAX_LENGTH} characters (100 over). Shorten it to pause the workspace.`,
    );
    await press("Pause workspace");
    const refusal = validatePauseBody({ reason: pasted });
    expect(refusal.ok).toBe(false);
    expect(statusText()).toBe((refusal as { error: string }).error);
    expect(statusText()).toBe("Keep the reason to 300 characters.");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(focus).toHaveBeenCalledTimes(1);
    expect(props(reason).value).toBe(pasted);
  });
});

// R56 security-billing-2 L1: the field and validatePauseBody share one rule,
// so the route refuses nothing the field let through.
describe("the pause reason field", () => {
  it("turns a pasted tab into a space, and line breaks into one space as before", async () => {
    await act(async () => root.render(createElement(AdminPauseControls, { workspaceId: "ws-1", paused: false })));
    const reason = find(container, (n) => n.nodeName === "TEXTAREA")!;
    await act(async () => {
      props(reason).onChange({ target: { value: "Spam\treports" } });
    });
    expect(props(reason).value).toBe("Spam reports");
    await act(async () => {
      props(reason).onChange({ target: { value: "Spam\r\nreports\u0007" } });
    });
    expect(props(reason).value).toBe("Spam reports ");
    const { validatePauseBody } = await import("@/server/admin/actions");
    expect(validatePauseBody({ reason: "Spam\r\nreports\u0007" })).toEqual({ ok: true, reason: "Spam reports" });
  });
});
