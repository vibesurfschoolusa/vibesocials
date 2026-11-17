import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * R41 pages L6: the owner's Client upload link card is hidden only for a
 * member's 403. Any other failed read shows the shared LoadError with Retry,
 * in an announced Alert, so an owner never finds the card simply missing.
 */

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock("@/components/ui/toast", () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn() }) }));
vi.mock("@vercel/blob/client", () => ({ upload: vi.fn() }));

import { makeDocument, type FakeNode } from "@/components/shell/fakeDom.testkit";
import { SIGNED_OUT_ERROR } from "@/lib/signedOutMessage";
import { MISSING_WORKSPACE_ID_MESSAGE, renderedWorkspaceRefusal } from "@/lib/workspaceChanged";

import { UPLOAD_LINK_LOAD_FAILED_TEXT, UPLOAD_LINK_LOAD_OFFLINE_TEXT, UploadLinkPanel } from "./media-library";

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

function alertNode(): FakeNode | null {
  return find(container, (n) => n.attributes.role === "alert");
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

async function mount() {
  await act(async () => {
    root.render(createElement(UploadLinkPanel, { workspaceId: "ws-1" }));
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
  vi.stubGlobal("fetch", fetchMock);
  root = createRoot(container as unknown as HTMLElement);
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});

describe("Client upload link card when its read fails", () => {
  it("a member's 403: no card", async () => {
    fetchMock.mockResolvedValue(Response.json({ error: "Only the owner can do this." }, { status: 403 }));
    await mount();
    expect(container.childNodes).toEqual([]);
  });

  it("a 500: the server-problem sentence with Retry, announced; Retry loads the card", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ error: "Internal error" }, { status: 500 }));
    await mount();
    expect(alertNode()?.textContent).toContain(UPLOAD_LINK_LOAD_FAILED_TEXT);
    expect(UPLOAD_LINK_LOAD_FAILED_TEXT).toBe("We couldn't load the client upload link. Try again in a moment.");
    expect(button("Retry")).not.toBeNull();

    fetchMock.mockResolvedValueOnce(Response.json({ link: null }, { status: 200 }));
    await act(async () => {
      void props(button("Retry")!).onClick({ currentTarget: button("Retry") });
    });
    await settle();
    expect(alertNode()).toBeNull();
    expect(button("Create link")).not.toBeNull();
  });

  it("offline: the connection sentence with Retry, announced", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    await mount();
    expect(alertNode()?.textContent).toContain(UPLOAD_LINK_LOAD_OFFLINE_TEXT);
    expect(UPLOAD_LINK_LOAD_OFFLINE_TEXT).toBe(
      "We couldn't reach Vibe Socials to load the client upload link. Check your connection and try again.",
    );
    expect(button("Retry")).not.toBeNull();
  });

  it("a 401: the signed-out sentence", async () => {
    fetchMock.mockResolvedValue(Response.json({ error: "Unauthorized" }, { status: 401 }));
    await mount();
    expect(alertNode()?.textContent).toContain(SIGNED_OUT_ERROR);
  });

  it("a gateway's HTML 502: the server-problem sentence", async () => {
    fetchMock.mockResolvedValue(new Response("<html></html>", { status: 502, headers: { "content-type": "text/html" } }));
    await mount();
    expect(alertNode()?.textContent).toContain(UPLOAD_LINK_LOAD_FAILED_TEXT);
  });

  it("a workspace refusal: the shared sentence, whose step is Reload page", async () => {
    fetchMock.mockResolvedValue(renderedWorkspaceRefusal(undefined, "ws-1") as Response);
    await mount();
    expect(alertNode()?.textContent).toContain(MISSING_WORKSPACE_ID_MESSAGE);
    expect(button("Reload page")).not.toBeNull();
  });

  it("a 429: the server-problem sentence, not a missing card", async () => {
    fetchMock.mockResolvedValue(Response.json({ error: "Too many requests." }, { status: 429 }));
    await mount();
    expect(alertNode()?.textContent).toContain(UPLOAD_LINK_LOAD_FAILED_TEXT);
  });
});
