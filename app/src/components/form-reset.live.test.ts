import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * R41 pages L4: Cancel (or any close) clears a form's or dialog's error and
 * typed text, so reopening starts clean. Before, Change email reopened with the
 * old alert (read out as new) and the old address, and the two delete dialogs
 * kept their error and what was typed.
 */

// The dialog shows its content only while open, as the real one does.
vi.mock("@/components/ui/dialog", () => {
  const pass = ({ children }: { children?: ReactNode }) => children ?? null;
  return {
    Dialog: ({ open, children }: { open: boolean; children?: ReactNode }) => (open ? children : null),
    DialogBody: pass,
    DialogDescription: pass,
    DialogFooter: pass,
    DialogHeader: pass,
    DialogTitle: pass,
    ConfirmDialog: () => null,
  };
});
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock("next-auth/react", () => ({ useSession: () => ({ data: null }), signOut: vi.fn() }));
vi.mock("@/components/ui/toast", () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn() }) }));

import { makeDocument, type FakeNode } from "@/components/shell/fakeDom.testkit";

import { AccountSection } from "./account-section";
import { DeleteWorkspace } from "./team-section";

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

function button(text: string): FakeNode {
  const hit = find(container, (n) => n.nodeName === "BUTTON" && (n.textContent as string).trim() === text);
  if (!hit) throw new Error(`no button ${text}`);
  return hit;
}

function input(id: string): FakeNode | null {
  return find(container, (n) => n.nodeName === "INPUT" && n.attributes.id === id);
}

function alertText(): string | null {
  const hit = find(container, (n) => n.attributes.role === "alert");
  return hit ? (hit.textContent as string) : null;
}

function props(node: FakeNode): Record<string, (arg?: unknown) => unknown> & { value?: unknown } {
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
  await act(async () => {
    void props(node).onClick({ currentTarget: node, preventDefault() {} });
  });
  await settle();
}

async function type(id: string, value: string) {
  const node = input(id)!;
  await act(async () => {
    props(node).onChange({ target: { value } });
  });
}

const refused = (body: unknown) => Promise.resolve(Response.json(body, { status: 400 }));

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const made = makeDocument();
  container = made.container;
  Object.assign(made.doc.defaultView as object, { requestAnimationFrame: (run: () => void) => setTimeout(run, 0), cancelAnimationFrame: clearTimeout, setTimeout, clearTimeout });
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

function mountAccount() {
  return act(async () => {
    root.render(
      createElement(AccountSection, {
        email: "owner@example.test",
        hasPassword: true,
        deletion: { deleteWorkspaces: [], leaveWorkspaces: [], refusal: null },
      }),
    );
  });
}

describe("Cancel resets the form or dialog", () => {
  it("Change email: Cancel then Change email opens empty, with no old alert", async () => {
    fetchMock.mockImplementation(() => refused({ error: "That password isn't right." }));
    await mountAccount();
    await press("Change email");
    await type("new-email", "new@example.test");
    await type("change-email-password", "wrong");
    const form = find(container, (n) => n.nodeName === "FORM")!;
    await act(async () => {
      void props(form).onSubmit({ preventDefault() {} });
    });
    await settle();
    expect(alertText()).toBe("That password isn't right.");

    await press("Cancel");
    await press("Change email");
    expect(alertText()).toBeNull();
    expect(props(input("new-email")!).value).toBe("");
    expect(props(input("change-email-password")!).value).toBe("");
  });

  it("Delete account: Cancel then Delete account opens empty, with no old alert", async () => {
    fetchMock.mockImplementation(() => refused({ error: "That password isn't right." }));
    await mountAccount();
    await press("Delete account");
    await type("delete-account-confirm", "wrong");
    // The dialog's own Delete account button is the second one.
    const buttons: FakeNode[] = [];
    find(container, (n) => {
      if (n.nodeName === "BUTTON" && (n.textContent as string).trim() === "Delete account") buttons.push(n);
      return false;
    });
    await act(async () => {
      void props(buttons[1]).onClick();
    });
    await settle();
    expect(alertText()).toBe("That password isn't right.");

    await press("Cancel");
    await press("Delete account");
    expect(alertText()).toBeNull();
    expect(props(input("delete-account-confirm")!).value).toBe("");
  });

  it("Delete workspace: Cancel then Delete this workspace opens empty, with no old alert", async () => {
    fetchMock.mockImplementation(() => refused({ error: "Type the workspace name exactly." }));
    await act(async () => {
      root.render(
        createElement(DeleteWorkspace, {
          workspaceId: "ws-1",
          workspaceName: "Surf Co",
          deletion: { memberCount: 1, scheduledCount: 0, refusal: null },
        }),
      );
    });
    await press("Delete this workspace");
    await type("delete-workspace-confirm", "Surf Co");
    await press("Delete workspace");
    expect(alertText()).not.toBeNull();

    await press("Cancel");
    await press("Delete this workspace");
    expect(alertText()).toBeNull();
    expect(props(input("delete-workspace-confirm")!).value).toBe("");
  });
});
