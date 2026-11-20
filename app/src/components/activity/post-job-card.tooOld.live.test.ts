import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * R50 publishing-flow L1: a card opened before its post's 7-day mark and
 * pressed after it gets the publish route's TOO_OLD 409. The card then shows
 * its too-old sentence and drops Send again, so no press can be made again;
 * any other 409 behaves as before.
 */

vi.mock("next/link", async () => {
  const { createElement: h } = await import("react");
  return { default: ({ href, children, ...rest }: { href: string; children: unknown }) => h("a", { href, ...rest }, children as never) };
});

import { makeDocument, type FakeNode } from "@/components/shell/fakeDom.testkit";
import { ToastProvider } from "@/components/ui/toast";
import { NOT_SENT_MESSAGE } from "@/lib/publishFailureText";
import type { PostJobDTO } from "@/lib/postsDto";
import { tooOldToSendText } from "@/lib/sendAgain";

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

const sendAgainButton = () =>
  find(container, (n) => n.nodeName === "BUTTON" && (n.textContent as string).trim() === "Send again");

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

const job = (overrides: Partial<PostJobDTO>): PostJobDTO => ({
  id: "job-1",
  status: "failed",
  createdAt: "2026-11-10T10:00:00.000Z",
  updatedAt: "2026-11-10T10:00:00.000Z",
  scheduledFor: null,
  caption: "Two spots left today",
  platformCaptions: null,
  results: [],
  media: null,
  mediaCount: 1,
  publish: null,
  createdBy: null,
  approvalState: "none",
  ...overrides,
});

async function mount(value: PostJobDTO) {
  await act(async () => {
    root.render(
      createElement(ToastProvider, null, createElement(PostJobCard, { job: value, workspaceId: "ws-1", onRetryAccepted: () => {} })),
    );
  });
}

async function press() {
  const button = sendAgainButton();
  expect(button).not.toBeNull();
  await act(async () => {
    props(button!).onClick?.();
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
  // Opened inside the post's 7-day window.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-14T12:00:00.000Z"));
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("PostJobCard - Send again pressed after the 7-day mark", () => {
  it("the route's TOO_OLD 409 switches the card to its too-old state: the sentence, no button, no second press", async () => {
    await mount(job({}));
    expect(container.textContent).toContain(NOT_SENT_MESSAGE);

    vi.setSystemTime(new Date("2026-11-18T12:00:00.000Z"));
    fetchMock.mockResolvedValue(Response.json({ error: tooOldToSendText(false), code: "TOO_OLD" }, { status: 409 }));
    await press();

    expect(container.textContent).toContain(tooOldToSendText(false));
    expect(container.textContent).not.toContain(NOT_SENT_MESSAGE);
    expect(sendAgainButton()).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  }, 5_000);

  it("a Story half shows the Story's too-old sentence", async () => {
    const story = job({ storyHalf: true, storyPlatforms: ["instagram"] });
    await mount(story);

    vi.setSystemTime(new Date("2026-11-18T12:00:00.000Z"));
    const sentence = tooOldToSendText(true);
    fetchMock.mockResolvedValue(Response.json({ error: sentence, code: "TOO_OLD" }, { status: 409 }));
    await press();

    expect(container.textContent).toContain(sentence);
    expect(container.textContent).not.toContain("This Story was not sent. Use Send again");
    expect(sendAgainButton()).toBeNull();
  }, 5_000);

  it("any other 409 behaves as before: the post is read again, and while it is unsent the button comes back", async () => {
    await mount(job({}));
    fetchMock
      .mockResolvedValueOnce(Response.json({ error: "An owner needs to approve this post first.", code: "AWAITING_APPROVAL" }, { status: 409 }))
      .mockResolvedValueOnce(Response.json({ postJob: { id: "job-1", status: "failed" }, results: [] }));
    await press();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain(NOT_SENT_MESSAGE);
    expect(sendAgainButton()).not.toBeNull();
  }, 5_000);
});
