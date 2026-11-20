import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * R48 pages-b L2: Replace's boxes outlived the link. Replace was pressed, then
 * Turn off's answer was lost with the link really off: the read-again set the
 * link to null but left Replace's state on, so the next Create link's new link
 * came up with the boxes and Cancel, and its Replace opened the confirm at once.
 */

// The confirm shows a button while open that runs onConfirm, as the real one:
// a throw keeps it open, a success closes it.
vi.mock("@/components/ui/dialog", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/ui/dialog")>();
  const { createElement: h } = await import("react");
  return {
    ...actual,
    ConfirmDialog: ({
      open,
      confirmText,
      onConfirm,
      onOpenChange,
    }: {
      open: boolean;
      confirmText?: string;
      onConfirm: () => Promise<void> | void;
      onOpenChange: (open: boolean) => void;
    }): ReactNode =>
      open
        ? h(
            "button",
            {
              type: "button",
              onClick: async () => {
                try {
                  await onConfirm();
                  onOpenChange(false);
                } catch {
                  // Stays open, as the real dialog does.
                }
              },
            },
            `Confirm ${confirmText}`,
          )
        : null,
  };
});
vi.mock("@/components/ui/toast", () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn() }) }));

import { makeDocument, type FakeNode } from "@/components/shell/fakeDom.testkit";
import { makeFocusable, type FocusDoc } from "@/lib/focusDom.testkit";

import { ConnectLinkSection } from "./connect-link-section";

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

async function press(text: string) {
  const node = button(text);
  expect(node, `a "${text}" button`).not.toBeNull();
  await act(async () => {
    void props(node!).onClick({ currentTarget: node });
  });
  await settle();
}

const link = (url: string) => ({
  url,
  platforms: ["tiktok"],
  expiresAt: "2026-12-19T10:00:00.000Z",
  lastUsedAt: null,
  createdAt: "2026-11-19T10:00:00.000Z",
});

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const made = makeDocument();
  container = made.container;
  makeFocusable(made.doc as unknown as FocusDoc);
  Object.assign(made.doc.defaultView as object, { addEventListener() {}, removeEventListener() {}, dispatchEvent: () => true, setTimeout, clearTimeout });
  vi.stubGlobal("window", made.doc.defaultView);
  vi.stubGlobal("document", made.doc);
  vi.stubGlobal("navigator", { onLine: true });
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  root = createRoot(container as unknown as HTMLElement);
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});

describe("Client connect link: Replace's boxes never outlive the link", () => {
  it("Replace, a lost Turn off answer with the link really off, then Create link: no boxes, no Cancel, and Replace starts from the boxes", async () => {
    let current: ReturnType<typeof link> | null = link("https://example.test/c/first");
    fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => {
      if (init?.method === "DELETE") {
        // The link went off, but the answer was lost on the way back.
        current = null;
        return new Response("<html></html>", { status: 502, headers: { "content-type": "text/html" } });
      }
      if (init?.method === "POST") {
        current = link("https://example.test/c/second");
        return Response.json({ link: current });
      }
      return Response.json({ link: current, available: ["tiktok", "instagram"] });
    });

    await act(async () => {
      root.render(createElement(ConnectLinkSection, { workspaceId: "ws-1", isOwner: true }));
    });
    await settle();

    await press("Replace link");
    expect(button("Cancel")).not.toBeNull();

    await press("Turn off");
    await press("Confirm Turn off");
    // The read-again found the link off: Create link is offered.
    expect(button("Create link")).not.toBeNull();

    await press("Create link");
    expect(button("Copy")).not.toBeNull();
    expect(container.textContent).not.toContain("The platforms the new link offers");
    expect(button("Cancel")).toBeNull();

    // Replace starts from the boxes, and does not open the confirm at once.
    await press("Replace link");
    expect(button("Confirm Replace link")).toBeNull();
    expect(container.textContent).toContain("The platforms the new link offers");
    expect(button("Cancel")).not.toBeNull();
  }, 5_000);
});
