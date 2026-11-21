import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * R58 pages-a-4 L1 and its fix review: a Retry refused with RECONNECT_REQUIRED
 * shows the step the route's `reason` names in place of the Retry button:
 * Connect for a platform with no connection, Reconnect for a flagged one.
 */

vi.mock("next/link", async () => {
  const { createElement: h } = await import("react");
  return { default: ({ href, children, ...rest }: { href: string; children: unknown }) => h("a", { href, ...rest }, children as never) };
});

import { makeDocument, type FakeNode } from "@/components/shell/fakeDom.testkit";
import { ToastProvider } from "@/components/ui/toast";
import type { PostJobDTO } from "@/lib/postsDto";

import { PostJobCard } from "./post-job-card";

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

async function settle() {
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

const failedJob: PostJobDTO = {
  id: "job-1",
  status: "failed",
  createdAt: "2026-11-10T10:00:00.000Z",
  updatedAt: "2026-11-10T10:00:00.000Z",
  scheduledFor: null,
  caption: "Two spots left today",
  platformCaptions: null,
  results: [
    {
      platform: "instagram",
      status: "failed",
      externalPostId: null,
      externalPostUrl: null,
      errorMessage: "Instagram refused the post.",
      deferral: null,
      unconfirmed: false,
      metric: null,
    },
  ],
  media: null,
  mediaCount: 1,
  publish: null,
  createdBy: null,
  approvalState: "none",
};

const retryButton = () =>
  find(container, (n) => n.nodeName === "BUTTON" && String(n.attributes?.["aria-label"] ?? "").startsWith("Retry Instagram"));

const settingsLink = () => find(container, (n) => n.nodeName === "A" && String(n.attributes?.href ?? "").startsWith("/settings"));

/** The step in place of the Retry button: the element holding the Settings link (the toast has none). */
function stepText(): string {
  const link = settingsLink();
  expect(link).not.toBeNull();
  return String((link!.parentNode as FakeNode).textContent).replace(/\s+/g, " ").trim();
}

async function retryRefusedWith(body: Record<string, unknown>) {
  await act(async () => {
    root.render(
      createElement(ToastProvider, null, createElement(PostJobCard, { job: failedJob, workspaceId: "ws-1", onRetryAccepted: () => {} })),
    );
  });
  const button = retryButton();
  expect(button).not.toBeNull();
  fetchMock.mockResolvedValue(Response.json(body, { status: 409 }));
  await act(async () => {
    void props(button!).onClick?.();
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

describe("PostJobCard - a Retry refused for the connection shows the route's step", () => {
  it('reason "connect": Connect Instagram in Settings, with the link, and no Retry', async () => {
    await retryRefusedWith({
      error: "Connect Instagram in Settings, then retry.",
      code: "RECONNECT_REQUIRED",
      platform: "instagram",
      reason: "connect",
    });
    expect(stepText()).toBe("Connect Instagram in Settings");
    expect(retryButton()).toBeNull();
  }, 5_000);

  it('reason "reconnect": Reconnect Instagram in Settings, with the link, and no Retry', async () => {
    await retryRefusedWith({
      error: "Reconnect Instagram in Settings before retrying.",
      code: "RECONNECT_REQUIRED",
      platform: "instagram",
      reason: "reconnect",
    });
    expect(stepText()).toBe("Reconnect Instagram in Settings");
    expect(retryButton()).toBeNull();
  }, 5_000);
});

// R59 publishing-flow L2: a teammate's Retry all won the race. The 409 names what was
// left out for its connection, so the card stops offering Retry for it.
describe("PostJobCard - a lost Retry all race", () => {
  const twoFailed: PostJobDTO = {
    ...failedJob,
    results: [
      failedJob.results[0],
      { ...failedJob.results[0], platform: "facebook_page", errorMessage: "Facebook Page refused the post." },
    ],
  };
  const button = (start: string) =>
    find(container, (n) => n.nodeName === "BUTTON" && String(n.attributes?.["aria-label"] ?? "").startsWith(start));

  async function retryAllRefusedWith(body: Record<string, unknown>) {
    await act(async () => {
      root.render(
        createElement(ToastProvider, null, createElement(PostJobCard, { job: twoFailed, workspaceId: "ws-1", onRetryAccepted: () => {} })),
      );
    });
    const all = button("Retry all failed");
    expect(all).not.toBeNull();
    fetchMock.mockResolvedValue(Response.json(body, { status: 409 }));
    await act(async () => {
      void props(all!).onClick?.();
    });
    await settle();
  }

  it("with leftOut: the left-out platform shows its step instead of Retry", async () => {
    await retryAllRefusedWith({
      error: "Instagram is already being retried or has gone out. Activity now shows where it stands. Facebook Page left out: connect it in Settings.",
      code: "NOTHING_TO_RETRY",
      leftOut: [{ platform: "facebook_page", reason: "connect" }],
    });
    expect(stepText()).toBe("Connect Facebook Page in Settings");
    expect(button("Retry Facebook Page")).toBeNull();
    expect(button("Retry Instagram")).not.toBeNull();
  }, 5_000);

  it("without leftOut (an older server): every Retry stays", async () => {
    await retryAllRefusedWith({ error: "Nothing failed to retry.", code: "NOTHING_TO_RETRY" });
    expect(settingsLink()).toBeNull();
    expect(button("Retry Facebook Page")).not.toBeNull();
    expect(button("Retry Instagram")).not.toBeNull();
  }, 5_000);
});
