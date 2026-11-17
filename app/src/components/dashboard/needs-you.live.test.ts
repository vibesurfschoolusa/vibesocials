import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * R35 new-customer L2: Needs you mounts once the dashboard's connections read
 * has finished, even when it failed. The Connections card's Retry can then
 * load a Google listing; the reviews call starts the first time
 * hasGoogleListing is true (at mount or later), and at most once per visit.
 */

vi.mock("next/link", async () => {
  const { createElement: h } = await import("react");
  return { default: ({ href, children, ...rest }: { href: string; children: unknown }) => h("a", { href, ...rest }, children as never) };
});

import { makeDocument, type FakeNode } from "@/components/shell/fakeDom.testkit";
import { NeedsYou } from "./needs-you";

let root: Root;
let container: FakeNode;

const fetchMock = vi.fn(async (url: string) => {
  const body = String(url).startsWith("/api/reviews") ? { reviews: [] } : null;
  return { ok: body !== null, status: body ? 200 : 500, json: async () => body } as unknown as Response;
});

function reviewCalls(): number {
  return fetchMock.mock.calls.filter(([url]) => String(url).startsWith("/api/reviews")).length;
}

async function show(hasGoogleListing: boolean) {
  await act(async () => {
    root.render(createElement(NeedsYou, { workspaceId: "ws-1", hasGoogleListing }));
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const made = makeDocument();
  container = made.container;
  vi.stubGlobal("window", made.doc.defaultView);
  fetchMock.mockClear();
  vi.stubGlobal("fetch", fetchMock);
  root = createRoot(container as unknown as HTMLElement);
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});

describe("Needs you: the Google reviews call", () => {
  it("connections not loaded at mount, then loaded with a Google listing: one call", async () => {
    await show(false);
    expect(reviewCalls()).toBe(0);
    await show(true);
    expect(reviewCalls()).toBe(1);
    expect(fetchMock).toHaveBeenCalledWith("/api/reviews?workspaceId=ws-1");
  });

  it("a Google listing at mount: one call", async () => {
    await show(true);
    expect(reviewCalls()).toBe(1);
  });

  it("later rerenders, with or without the listing: no more calls", async () => {
    await show(false);
    await show(true);
    await show(true);
    await show(false);
    await show(true);
    expect(reviewCalls()).toBe(1);
  });

  it("no Google listing: no call", async () => {
    await show(false);
    await show(false);
    expect(reviewCalls()).toBe(0);
  });
});
