import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * R42 pages-b L1: the Queue's Client review link card and Settings' Client
 * connect link card hid themselves on any failed read, so an owner sent to
 * them found nothing. Each now does what the upload-link card does: a failed
 * read shows LoadError with Retry in an announced Alert; a 409 or a missing
 * workspace id shows Reload page; after Retry focus goes to the loading line,
 * then to the card. Both are drawn only for owners, so a 403 asks for a
 * reload and neither card ever hides.
 */

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("next-auth/react", () => ({ useSession: () => ({ data: null }), signOut: vi.fn() }));
vi.mock("@/components/ui/toast", () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn() }) }));

import { ReviewLinkPanel } from "@/app/queue/queue-view";
import { ROLE_CHANGED_MESSAGE } from "@/components/load-error";
import { makeDocument, type FakeNode } from "@/components/shell/fakeDom.testkit";
import { makeFocusable, type FocusDoc } from "@/lib/focusDom.testkit";
import { installKeeperOnFakePage } from "@/lib/focusKeeperDom.testkit";
import { SIGNED_OUT_ERROR } from "@/lib/signedOutMessage";
import { MISSING_WORKSPACE_ID_MESSAGE, renderedWorkspaceRefusal, WORKSPACE_CHANGED_SAVE_MESSAGE } from "@/lib/workspaceChanged";

import { ConnectLinkSection } from "./connect-link-section";

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

function alertNode(): FakeNode | null {
  return find(container, (n) => n.attributes.role === "alert");
}

function props(node: FakeNode): Record<string, (arg?: unknown) => unknown> {
  const key = Object.keys(node).find((k) => k.startsWith("__reactProps$"));
  return node[key as string] as Record<string, (arg?: unknown) => unknown>;
}

async function settle(ms = 120) {
  for (let i = 0; i < 3; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, ms / 3));
    });
  }
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

const cards = [
  {
    name: "Queue's Client review link",
    mount: () => createElement(ReviewLinkPanel, { workspaceId: "ws-1" }),
    thing: "client review link",
    title: "Client review link",
    ready: () => Response.json({ link: null }),
  },
  {
    name: "Settings' Client connect link",
    mount: () => createElement(ConnectLinkSection, { workspaceId: "ws-1", isOwner: true }),
    thing: "client connect link",
    title: "Client connect link",
    ready: () => Response.json({ link: null, available: ["tiktok"] }),
  },
] as const;

describe.each(cards)("$name card when its read fails", ({ mount, thing, title, ready }) => {
  const failed = `We couldn't load the ${thing}. Try again in a moment.`;
  const offline = `We couldn't reach Vibe Socials to load the ${thing}. Check your connection and try again.`;

  async function render() {
    await act(async () => {
      root.render(mount());
    });
    await settle();
  }

  it("a 5xx: the failed sentence with Retry, announced", async () => {
    fetchMock.mockResolvedValue(Response.json({ error: "Internal error" }, { status: 500 }));
    await render();
    expect(alertNode()?.textContent).toContain(failed);
    expect(button("Retry")).not.toBeNull();
  });

  it("a gateway's HTML 502: the failed sentence", async () => {
    fetchMock.mockResolvedValue(new Response("<html></html>", { status: 502, headers: { "content-type": "text/html" } }));
    await render();
    expect(alertNode()?.textContent).toContain(failed);
  });

  it("offline: the connection sentence with Retry", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    await render();
    expect(alertNode()?.textContent).toContain(offline);
    expect(button("Retry")).not.toBeNull();
  });

  it("a 401: the signed-out sentence", async () => {
    fetchMock.mockResolvedValue(Response.json({ error: "Unauthorized" }, { status: 401 }));
    await render();
    expect(alertNode()?.textContent).toContain(SIGNED_OUT_ERROR);
  });

  it("a 409 (switched in another tab): the switch sentence with Reload page, no Retry", async () => {
    fetchMock.mockResolvedValue(renderedWorkspaceRefusal("ws-1", "ws-2") as Response);
    await render();
    expect(alertNode()?.textContent).toContain(WORKSPACE_CHANGED_SAVE_MESSAGE);
    expect(button("Reload page")).not.toBeNull();
    expect(button("Retry")).toBeNull();
  });

  it("a missing workspace id: its sentence with Reload page", async () => {
    fetchMock.mockResolvedValue(renderedWorkspaceRefusal(undefined, "ws-1") as Response);
    await render();
    expect(alertNode()?.textContent).toContain(MISSING_WORKSPACE_ID_MESSAGE);
    expect(button("Reload page")).not.toBeNull();
  });

  it("Retry: focus goes to the loading line, then to the card", async () => {
    fetchMock.mockResolvedValue(Response.json({ error: "Internal error" }, { status: 500 }));
    await render();
    let resolve!: (value: Response) => void;
    fetchMock.mockImplementation(() => new Promise<Response>((done) => (resolve = done)));
    const retry = button("Retry")!;
    (retry.focus as () => void)();
    await act(async () => {
      void props(retry).onClick({ currentTarget: retry });
    });
    await settle();
    expect(active().textContent).toBe(`Loading the ${thing}…`);
    await act(async () => resolve(ready()));
    await settle();
    expect(alertNode()).toBeNull();
    expect(active().textContent).toContain(title);
    expect(button("Create link")).not.toBeNull();
  });
});

// R42 review: both cards are drawn only for owners, so a 403 (the role or
// workspace changed since) never hides either: the role sentence, Reload page.
describe.each(cards)("$name card: a 403", ({ mount }) => {
  it("shows the role sentence with Reload page", async () => {
    fetchMock.mockResolvedValue(Response.json({ error: "Only the workspace owner can do this." }, { status: 403 }));
    await act(async () => {
      root.render(mount());
    });
    await settle();
    expect(alertNode()?.textContent).toContain(ROLE_CHANGED_MESSAGE);
    expect(button("Reload page")).not.toBeNull();
    expect(button("Retry")).toBeNull();
  });
});
