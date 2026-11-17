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

import { html, makeDocument, type FakeNode } from "@/components/shell/fakeDom.testkit";
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

/**
 * R36 client-journey L1: a reviews call started after mount (the listing came
 * with the Connections card's Retry) keeps the loaded card instead of the
 * skeleton, and never says "You're all caught up" until it settles; a quiet
 * "Checking Google reviews…" line stands in.
 */
describe("Needs you: a reviews call started after mount", () => {
  const QUIET = { problemsLast7Days: 0, awaitingYourApproval: 0, clientChangesRequested: 0, nextScheduled: null };
  let summaryBody: Record<string, unknown> = QUIET;
  let settleReviews: (outcome: { reviews: unknown[] } | "fail") => void = () => {};

  beforeEach(() => {
    summaryBody = QUIET;
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).startsWith("/api/reviews")) {
        return new Promise<Response>((resolve, reject) => {
          settleReviews = (outcome) =>
            outcome === "fail"
              ? reject(new TypeError("Failed to fetch"))
              : resolve({ ok: true, status: 200, json: async () => outcome } as unknown as Response);
        });
      }
      return { ok: true, status: 200, json: async () => summaryBody } as unknown as Response;
    });
  });

  afterEach(() => {
    fetchMock.mockReset();
  });

  const text = () => container.textContent as string;
  const skeleton = () => html(container).includes("animate-pulse");
  async function settle(outcome: { reviews: unknown[] } | "fail") {
    await act(async () => {
      settleReviews(outcome);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  it("listing at mount: the skeleton until the reviews settle (unchanged)", async () => {
    await show(true);
    expect(skeleton()).toBe(true);
    expect(text()).toContain("Loading what needs you…");
    expect(text()).not.toContain("all caught up");
    await settle({ reviews: [] });
    expect(skeleton()).toBe(false);
    expect(text()).toContain("You're all caught up");
  });

  it("listing later with other rows: the loaded rows stay, with the checking line", async () => {
    summaryBody = { ...QUIET, awaitingYourApproval: 1 };
    await show(false);
    expect(text()).toContain("1 post is waiting for your approval");
    await show(true);
    expect(skeleton()).toBe(false);
    expect(text()).not.toContain("Loading what needs you…");
    expect(text()).toContain("Needs you");
    expect(text()).toContain("1 post is waiting for your approval");
    expect(text()).toContain("Checking Google reviews…");
  });

  it("listing later with no rows: no caught-up heading while checking", async () => {
    await show(false);
    expect(text()).toContain("You're all caught up");
    await show(true);
    expect(skeleton()).toBe(false);
    expect(text()).not.toContain("all caught up");
    expect(text()).toContain("Checking Google reviews…");
    expect(text()).toContain("Plan the next few weeks with Add many.");
  });

  it("settled with reviews: the reviews row is added and the checking line goes", async () => {
    await show(false);
    await show(true);
    await settle({ reviews: [{ reviewReply: null }, { reviewReply: { comment: "Thanks" } }] });
    expect(text()).toContain("Needs you");
    expect(text()).toContain("1 Google review needs a reply");
    expect(text()).not.toContain("Checking Google reviews…");
  });

  it("settled with none: the caught-up heading comes back", async () => {
    await show(false);
    await show(true);
    await settle({ reviews: [] });
    expect(text()).toContain("You're all caught up");
    expect(text()).not.toContain("Checking Google reviews…");
  });

  it("the reviews call fails: no reviews row, the card as it was", async () => {
    summaryBody = { ...QUIET, awaitingYourApproval: 2 };
    await show(false);
    await show(true);
    await settle("fail");
    expect(text()).toContain("2 posts are waiting for your approval");
    expect(text()).not.toContain("Google review");
    expect(text()).not.toContain("Checking Google reviews…");
  });
});
