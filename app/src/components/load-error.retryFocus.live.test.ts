import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * R41 review L1: pressing Retry swaps the Alert, and the button with it, for a
 * skeleton, so focus fell to the page body. LoadError now keeps it: to the
 * loading status line, then to what the load shows (the list, or the new
 * error's Retry). Mounted with the page's focus keeper, as on the live page.
 *
 * R41 review L3: Team's MemberView and OwnerView are rendered with a failed
 * load, and Retry is driven.
 */

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("next/link", async () => {
  const { createElement: make } = await import("react");
  return {
    default: ({ href, children, prefetch: _prefetch, ...rest }: { href: string; children?: unknown; prefetch?: unknown }) =>
      make("a", { href: String(href), ...rest }, children as never),
  };
});
vi.mock("next-auth/react", () => ({ useSession: () => ({ data: null }), signOut: vi.fn() }));
vi.mock("@/components/ui/toast", () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn() }) }));
vi.mock("@vercel/blob/client", () => ({ upload: vi.fn() }));

import { ActivityView } from "@/app/activity/activity-view";
import { makeDocument, type FakeNode } from "@/components/shell/fakeDom.testkit";
import { makeFocusable, type FocusDoc } from "@/lib/focusDom.testkit";
import { installKeeperOnFakePage } from "@/lib/focusKeeperDom.testkit";

import { UploadLinkPanel } from "./media-library";
import { MEMBERS_LOAD_FAILED_TEXT, TeamSection } from "./team-section";

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

function button(text: string): FakeNode | null {
  return find(container, (n) => n.nodeName === "BUTTON" && (n.textContent as string).trim() === text);
}

function props(node: FakeNode): Record<string, (arg?: unknown) => unknown> {
  const key = Object.keys(node).find((k) => k.startsWith("__reactProps$"));
  return node[key as string] as Record<string, (arg?: unknown) => unknown>;
}

/** Lets React, the fetch and LoadError's checks run (they look every 50 ms). */
async function settle(ms = 120) {
  for (let i = 0; i < 3; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, ms / 3));
    });
  }
}

function deferred() {
  let resolve!: (value: Response) => void;
  const promise = new Promise<Response>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const active = () => doc.activeElement as FakeNode;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const made = makeDocument();
  container = made.container;
  doc = made.doc as unknown as FocusDoc;
  makeFocusable(doc);
  stopKeeper = installKeeperOnFakePage(made as never).stop;
  Object.assign(made.doc.defaultView as object, { addEventListener() {}, removeEventListener() {}, setTimeout, clearTimeout });
  vi.stubGlobal("window", made.doc.defaultView);
  vi.stubGlobal("document", made.doc);
  vi.stubGlobal("navigator", { onLine: true });
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  root = createRoot(container as unknown as HTMLElement);
});

afterEach(async () => {
  await act(async () => root.unmount());
  stopKeeper();
  vi.unstubAllGlobals();
});

/**
 * Presses the focused Retry with the next answer held back; checks focus is
 * on the loading status; then lets `next` arrive.
 */
async function retryThrough(urlPart: string, next: Response, loadingText: string) {
  const later = deferred();
  fetchMock.mockImplementation((url: string) => {
    if (String(url).includes(urlPart)) return later.promise;
    return Promise.resolve(Response.json({}));
  });
  const retry = button("Retry");
  expect(retry).not.toBeNull();
  (retry!.focus as () => void)();
  await act(async () => {
    void props(retry!).onClick({ currentTarget: retry });
  });
  await settle();
  expect(active().textContent).toBe(loadingText);

  await act(async () => {
    later.resolve(next);
  });
  await settle();
}

function failFirst(urlPart: string) {
  fetchMock.mockImplementation((url: string) => {
    if (String(url).includes(urlPart)) return Promise.resolve(Response.json({ error: "Internal error" }, { status: 500 }));
    return Promise.resolve(Response.json({}));
  });
}

describe("Activity (a list site): focus after Retry", () => {
  async function mount() {
    failFirst("/api/posts");
    await act(async () => {
      root.render(createElement(ActivityView, { workspaceId: "ws-1" }));
    });
    await settle();
  }

  it("goes to the loading status, then to the list", async () => {
    await mount();
    await retryThrough(
      "/api/posts",
      Response.json({ jobs: [], nextCursor: null, workspaceMemberCount: 1, workspaceRole: "owner" }),
      "Loading activity…",
    );
    expect(active()).not.toBe(doc.body);
    expect(active().textContent).toContain("No posts yet");
  });

  it("goes to the loading status, then to the new error's Retry", async () => {
    await mount();
    await retryThrough("/api/posts", Response.json({ error: "Internal error" }, { status: 500 }), "Loading activity…");
    expect(active()).toBe(button("Retry"));
  });
});

describe("Team: a failed load, Retry and focus", () => {
  const MEMBERS = [
    { userId: "u1", name: "Ana", email: "ana@example.test", role: "owner", joinedAt: "2026-01-01T00:00:00.000Z" },
  ];

  async function mount(role: "owner" | "member", urlPart: string) {
    failFirst(urlPart);
    await act(async () => {
      root.render(
        createElement(TeamSection, {
          workspaceId: "ws-1",
          role,
          workspaceName: "Surf Co",
          deletion: { memberCount: 1, scheduledCount: 0, refusal: null },
        }),
      );
    });
    await settle();
    expect(container.textContent).toContain(MEMBERS_LOAD_FAILED_TEXT);
  }

  it("MemberView: Retry reads the roster again; focus goes to the status, then to the list", async () => {
    await mount("member", "/api/workspaces/members/roster");
    await retryThrough("/api/workspaces/members/roster", Response.json({ members: [{ name: "Ana", role: "owner" }] }), "Loading members…");
    expect(container.textContent).not.toContain(MEMBERS_LOAD_FAILED_TEXT);
    expect(active().nodeName).toBe("UL");
    expect(active().textContent).toContain("Ana");
  });

  it("OwnerView: Retry reads the members again; focus goes to the status, then to the list", async () => {
    await mount("owner", "/api/workspaces/members?");
    await retryThrough("/api/workspaces/members?", Response.json({ members: MEMBERS }), "Loading members…");
    expect(container.textContent).not.toContain(MEMBERS_LOAD_FAILED_TEXT);
    expect(active().nodeName).toBe("UL");
    expect(active().textContent).toContain("Ana");
  });

  // R41 second look L3: demoted in another tab, the owners' list answers 403.
  it("OwnerView: a 403 says the role or workspace changed, with Reload page", async () => {
    fetchMock.mockImplementation((url: string) =>
      Promise.resolve(
        String(url).includes("/api/workspaces/members?")
          ? Response.json({ error: "Only the workspace owner can do this." }, { status: 403 })
          : Response.json({}),
      ),
    );
    await act(async () => {
      root.render(
        createElement(TeamSection, {
          workspaceId: "ws-1",
          role: "owner",
          workspaceName: "Surf Co",
          deletion: { memberCount: 1, scheduledCount: 0, refusal: null },
        }),
      );
    });
    await settle();
    expect(container.textContent).toContain("Your role or workspace changed. Reload the page.");
    expect(button("Reload page")).not.toBeNull();
    expect(button("Retry")).toBeNull();
  });

  it("OwnerView: a second failure puts focus on the new Retry", async () => {
    await mount("owner", "/api/workspaces/members?");
    await retryThrough("/api/workspaces/members?", Response.json({ error: "Internal error" }, { status: 500 }), "Loading members…");
    expect(active()).toBe(button("Retry"));
  });
});

describe("Media's upload link card: focus after Retry", () => {
  it("goes to the loading status, then to the card", async () => {
    failFirst("/api/workspaces/upload-link");
    await act(async () => {
      root.render(createElement(UploadLinkPanel, { workspaceId: "ws-1" }));
    });
    await settle();
    await retryThrough("/api/workspaces/upload-link", Response.json({ link: null }), "Loading the client upload link…");
    expect(active().textContent).toContain("Client upload link");
    expect(button("Create link")).not.toBeNull();
  });
});
