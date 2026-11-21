import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * R60 pages-b L1: a removal (and a demotion that turned off links) clears the
 * invite the card shows, so a failed invite read's "a link you already sent
 * may be active" is no longer true and goes with it.
 */

const { confirmProps, toast } = vi.hoisted(() => ({
  confirmProps: [] as Record<string, unknown>[],
  toast: { success: () => {}, error: () => {}, info: () => {} },
}));

vi.mock("@/components/ui/dialog", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/ui/dialog")>();
  return {
    ...actual,
    ConfirmDialog: (props: Record<string, unknown>) => {
      confirmProps.push(props);
      return null;
    },
  };
});
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock("next-auth/react", () => ({ useSession: () => ({ data: { user: { id: "u-ana" } } }), signOut: vi.fn() }));
vi.mock("@/components/ui/toast", () => ({ useToast: () => toast }));

import { makeDocument, type FakeNode } from "@/components/shell/fakeDom.testkit";
import { makeFocusable, type FocusDoc } from "@/lib/focusDom.testkit";
import { installKeeperOnFakePage } from "@/lib/focusKeeperDom.testkit";

import { INVITE_UNREAD_TEXT, TeamSection } from "./team-section";

const MEMBERS = [
  { userId: "u-ana", email: "ana@example.com", name: "Ana", role: "owner", joinedAt: "2026-11-01T10:00:00.000Z" },
  { userId: "u-ben", email: "ben@example.com", name: "Ben", role: "owner", joinedAt: "2026-11-02T10:00:00.000Z" },
  { userId: "u-cy", email: "cy@example.com", name: "Cy", role: "member", joinedAt: "2026-11-03T10:00:00.000Z" },
];

let root: Root;
let container: FakeNode;
let stopKeeper: () => void;
let writeAnswer: Record<string, unknown>;

function all(node: FakeNode, test: (n: FakeNode) => boolean, hits: FakeNode[] = []): FakeNode[] {
  if (test(node)) hits.push(node);
  for (const child of node.childNodes) all(child, test, hits);
  return hits;
}

const button = (text: string) => all(container, (n) => n.nodeName === "BUTTON" && String(n.textContent).trim() === text)[0];
const labelled = (label: string) => all(container, (n) => n.nodeName === "BUTTON" && n.attributes?.["aria-label"] === label)[0];
const text = () => String(container.textContent);

function props(node: FakeNode): Record<string, (arg?: unknown) => unknown> {
  const key = Object.keys(node).find((k) => k.startsWith("__reactProps$"));
  return node[key as string] as Record<string, (arg?: unknown) => unknown>;
}

async function settle() {
  for (let i = 0; i < 6; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

/** Opens the row's dialog, then confirms it as ConfirmDialog would. */
async function confirmThrough(label: string, title: RegExp) {
  const opener = labelled(label);
  expect(opener, label).toBeDefined();
  await act(async () => {
    void props(opener).onClick({ currentTarget: opener });
  });
  await settle();
  const dialog = [...confirmProps].reverse().find((p) => title.test(String(p.title)) && p.open);
  expect(dialog, String(title)).toBeDefined();
  await act(async () => {
    await (dialog!.onConfirm as () => Promise<void>)();
  });
  await settle();
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const made = makeDocument();
  container = made.container;
  makeFocusable(made.doc as unknown as FocusDoc);
  stopKeeper = installKeeperOnFakePage(made as never).stop;
  vi.stubGlobal("document", made.doc);
  vi.stubGlobal("window", made.doc.defaultView);
  const frames = {
    requestAnimationFrame: (step: () => void) => setTimeout(step, 0),
    cancelAnimationFrame: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
    setTimeout,
    clearTimeout,
    // A demotion tells the connect link card (client-links-refresh.ts); nothing listens here.
    dispatchEvent: () => true,
  };
  Object.assign(made.doc.defaultView as object, frames);
  vi.stubGlobal("requestAnimationFrame", frames.requestAnimationFrame);
  vi.stubGlobal("cancelAnimationFrame", frames.cancelAnimationFrame);
  confirmProps.length = 0;
  writeAnswer = {};
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown, init?: { method?: string }) => {
      const url = String(input);
      // The invite read fails at load: a gateway page.
      if (url.startsWith("/api/workspaces/invites")) {
        return new Response("<html>Bad gateway</html>", { status: 502, headers: { "Content-Type": "text/html" } });
      }
      if (url.startsWith("/api/workspaces/members/u-")) return Response.json(writeAnswer);
      if (url.startsWith("/api/workspaces/members")) return Response.json({ members: MEMBERS });
      void init;
      return Response.json({});
    }),
  );
  root = createRoot(container as unknown as HTMLElement);
});

afterEach(async () => {
  await act(async () => root.unmount());
  stopKeeper();
  vi.unstubAllGlobals();
});

async function mount() {
  await act(async () => {
    root.render(createElement(TeamSection, { workspaceId: "ws-1", role: "owner", workspaceName: "Surf Co" }));
  });
  await settle();
  expect(text()).toContain(INVITE_UNREAD_TEXT);
}

describe("Team: the unread invite state after a removal or a demotion", () => {
  it("a failed read, then a removal: the card offers Create invite link", async () => {
    writeAnswer = { invitesRevoked: 1 };
    await mount();
    await confirmThrough("Remove Cy", /^Remove /);
    expect(text()).not.toContain(INVITE_UNREAD_TEXT);
    expect(button("Create invite link")).toBeDefined();
    expect(button("Create new invite link")).toBeUndefined();
  }, 5_000);

  it("a failed read, then a demotion that revoked links: the card offers Create invite link", async () => {
    writeAnswer = { joinLinksRevoked: 1 };
    await mount();
    await confirmThrough("Make member Ben", /a member\?$/);
    expect(text()).not.toContain(INVITE_UNREAD_TEXT);
    expect(button("Create invite link")).toBeDefined();
  }, 5_000);

  it("a demotion with none revoked: the unread state is kept", async () => {
    writeAnswer = { joinLinksRevoked: 0 };
    await mount();
    await confirmThrough("Make member Ben", /a member\?$/);
    expect(text()).toContain(INVITE_UNREAD_TEXT);
    expect(button("Create new invite link")).toBeDefined();
  }, 5_000);
});
