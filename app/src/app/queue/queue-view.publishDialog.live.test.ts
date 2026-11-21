import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * R58 publishing-flow L3: the Queue's Publish now dialog names the platforms
 * the post targets; only a post with no targets says "your connected platforms".
 */

vi.mock("next/link", async () => {
  const { createElement: h } = await import("react");
  return { default: ({ href, children, ...rest }: { href: string; children: unknown }) => h("a", { href, ...rest }, children as never) };
});
vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams(), useRouter: () => ({ push() {}, refresh() {} }) }));
vi.mock("@/hooks/useConnections", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/useConnections")>()),
  useConnections: () => ({ connections: [], loading: false, error: null, reload: () => {} }),
}));
// The real dialog renders into a portal; this one shows its description in place.
vi.mock("@/components/ui/dialog", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/ui/dialog")>();
  const { createElement: h } = await import("react");
  return {
    ...actual,
    ConfirmDialog: ({ open, title, description }: { open: boolean; title: string; description?: string }): ReactNode =>
      open ? h("div", { "data-dialog": title }, description ?? "") : null,
  };
});

import { makeDocument, type FakeNode } from "@/components/shell/fakeDom.testkit";
import { ToastProvider } from "@/components/ui/toast";
import type { PostJobDTO } from "@/lib/postsDto";
import type { Platform } from "@prisma/client";
import { QueueView } from "./queue-view";

let root: Root;
let container: FakeNode;

function draft(id: string, caption: string, targetPlatforms: Platform[] | null): PostJobDTO {
  return {
    id,
    status: "draft",
    createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-01T00:00:00.000Z",
    scheduledFor: null,
    caption,
    platformCaptions: null,
    results: [],
    media: null,
    mediaCount: 1,
    publish: targetPlatforms
      ? { targetPlatforms, youtubePrivacy: null, tiktokPrivacy: null, googlePostType: null, googleButton: null }
      : null,
    createdBy: null,
    approvalState: "none",
  };
}

const fetchMock = vi.fn(async (input: unknown) => {
  if (String(input).startsWith("/api/posts")) {
    return Response.json({
      jobs: [
        draft("job-a", "Instagram only", ["instagram"]),
        draft("job-b", "No targets", null),
        { ...draft("job-c", "Instagram Story", ["instagram"]), storyPlatforms: ["instagram"] },
        { ...draft("job-d", "Scheduled one", ["instagram"]), status: "scheduled", scheduledFor: "2099-11-30T15:00:00.000Z" },
        // R62 pages-a-3 L1: the client asked for a change, so it is a draft that keeps its time.
        {
          ...draft("job-e", "Sent back", ["instagram"]),
          scheduledFor: "2099-11-30T15:00:00.000Z",
          clientChangeRequestedAt: "2026-11-02T00:00:00.000Z",
          clientNote: "Use the other photo.",
        },
      ],
      workspaceId: "ws-1",
      workspaceMemberCount: 1,
      workspaceRole: "owner",
      workspaceRequireApproval: false,
      nextCursor: null,
    });
  }
  return Response.json({});
});

function findAll(node: FakeNode, test: (n: FakeNode) => boolean, hits: FakeNode[] = []): FakeNode[] {
  if (test(node)) hits.push(node);
  for (const child of node.childNodes) findAll(child, test, hits);
  return hits;
}

function props(node: FakeNode): Record<string, (arg?: unknown) => unknown> {
  const key = Object.keys(node).find((k) => k.startsWith("__reactProps$"));
  return node[key as string] as Record<string, (arg?: unknown) => unknown>;
}

async function settle() {
  for (let i = 0; i < 8; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

// A card's name is its caption and the Saved time it shows (queueCardName).
const SAVED = new Date("2026-11-01T00:00:00.000Z").toLocaleString(undefined, {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

async function pressPublish(caption: string) {
  // A draft's card is named by its Saved time; a card with a time, by that time.
  const label = `Publish "${caption}, ${SAVED}" now`;
  const named = (n: FakeNode) => {
    const aria = String(n.attributes?.["aria-label"] ?? "");
    return aria === label || (aria.startsWith(`Publish "${caption}, `) && aria.endsWith('" now'));
  };
  const button = findAll(container, (n) => n.tagName === "BUTTON" && named(n))[0];
  if (!button) throw new Error(`no button ${label}`);
  await act(async () => {
    void props(button).onClick({ currentTarget: null });
  });
  await settle();
}

function dialogText(): string {
  const dialog = findAll(container, (n) => n.attributes?.["data-dialog"] === "Publish this post now?")[0];
  if (!dialog) throw new Error("no Publish now dialog");
  return String(dialog.textContent);
}

async function mount() {
  await act(async () => {
    root.render(createElement(ToastProvider, null, createElement(QueueView as (p: NonNullable<Parameters<typeof QueueView>[0]>) => ReturnType<typeof QueueView>, { workspaceId: "ws-1" })));
  });
  await settle();
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const made = makeDocument();
  container = made.container;
  vi.stubGlobal("window", made.doc.defaultView);
  vi.stubGlobal("document", made.doc);
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("requestAnimationFrame", (step: () => void) => setTimeout(step, 0));
  vi.stubGlobal("cancelAnimationFrame", (id: number) => clearTimeout(id));
  Object.assign(made.doc.defaultView as object, {
    matchMedia: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }),
    location: { href: "http://localhost/queue" },
    localStorage: { getItem: () => null, setItem() {} },
  });
  root = createRoot(container as unknown as HTMLElement);
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});

describe("Queue: the Publish now dialog names the post's platforms", () => {
  it("a draft that targets Instagram: the dialog names Instagram", async () => {
    await mount();
    await pressPublish("Instagram only");
    expect(dialogText()).toContain("It will be sent to Instagram right away.");
  }, 10_000);

  // R59 publishing-flow L3: the dialog says Story, as the card does.
  it("a Story-only Instagram draft: the dialog says Instagram (Story)", async () => {
    await mount();
    await pressPublish("Instagram Story");
    expect(dialogText()).toContain("It will be sent to Instagram (Story) right away.");
  }, 10_000);

  it("a draft with no targets: your connected platforms", async () => {
    await mount();
    await pressPublish("No targets");
    expect(dialogText()).toContain("It will be sent to your connected platforms right away.");
  }, 10_000);

  // R62 pages-a-3 L1: only a scheduled post was waiting for anything.
  it("a scheduled post: right away instead of waiting for its scheduled time", async () => {
    await mount();
    await pressPublish("Scheduled one");
    expect(dialogText()).toContain("It will be sent to Instagram right away instead of waiting for its scheduled time.");
  }, 10_000);

  it("a draft: right away, with no waiting named", async () => {
    await mount();
    await pressPublish("Instagram only");
    expect(dialogText()).toContain("It will be sent to Instagram right away.");
    expect(dialogText()).not.toContain("instead of waiting");
  }, 10_000);

  it("a draft the client sent back with a time: right away, with no waiting named", async () => {
    await mount();
    await pressPublish("Sent back");
    expect(dialogText()).toContain("It will be sent to Instagram right away.");
    expect(dialogText()).not.toContain("instead of waiting");
  }, 10_000);
});
