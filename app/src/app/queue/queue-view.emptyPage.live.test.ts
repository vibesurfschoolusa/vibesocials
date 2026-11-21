import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * R60 client-journey-2 L1: the first page holds the 50 newest posts, and
 * Cancel, Delete, Publish now and Reject remove a card locally. Once every
 * loaded card was gone the Queue said "Nothing queued" (or showed an empty
 * month) and dropped Load more, while older posts were still scheduled. The
 * empty state now waits for the last page (nextCursor null), as Media does.
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
// The confirm step drawn as one button that confirms (its own suite covers the dialog).
vi.mock("@/components/ui/dialog", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/ui/dialog")>();
  const { createElement: h } = await import("react");
  return {
    ...actual,
    ConfirmDialog: ({ open, title, onConfirm }: { open: boolean; title: string; onConfirm: () => unknown }): ReactNode =>
      open ? h("button", { "data-confirm": title, onClick: () => onConfirm() }, "Confirm") : null,
  };
});

import { makeDocument, type FakeNode } from "@/components/shell/fakeDom.testkit";
import { ToastProvider } from "@/components/ui/toast";
import type { PostJobDTO } from "@/lib/postsDto";
import { QueueView } from "./queue-view";

let root: Root;
let container: FakeNode;
/** The list's next page token, as the server answers it. */
let nextCursor: string | null = null;

function draft(id: string, caption: string): PostJobDTO {
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
    publish: null,
    createdBy: null,
    approvalState: "none",
  };
}

const fetchMock = vi.fn(async (input: unknown, init?: { method?: string }) => {
  const url = String(input);
  if ((init?.method ?? "GET") === "DELETE") return Response.json({ ok: true });
  if (url.startsWith("/api/posts")) {
    return Response.json({
      jobs: [draft("job-a", "First post")],
      workspaceId: "ws-1",
      workspaceMemberCount: 1,
      workspaceRole: "member",
      workspaceRequireApproval: false,
      nextCursor,
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

const SAVED = new Date("2026-11-01T00:00:00.000Z").toLocaleString(undefined, {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

async function click(node: FakeNode | undefined, what: string) {
  if (!node) throw new Error(`no ${what}`);
  await act(async () => {
    void props(node).onClick({ currentTarget: null });
  });
  await settle();
}

const buttons = (test: (n: FakeNode) => boolean) => findAll(container, (n) => n.tagName === "BUTTON" && test(n));

/** Deletes the only loaded card, so the page holds none. */
async function deleteTheLoadedCard() {
  await click(buttons((n) => n.attributes?.["aria-label"] === `Delete "First post, ${SAVED}"`)[0], "Delete button");
  await click(buttons((n) => n.attributes?.["data-confirm"] !== undefined)[0], "confirm button");
  expect(String(container.textContent)).not.toContain("First post");
}

async function showCalendar() {
  await click(buttons((n) => n.textContent === "Calendar")[0], "Calendar toggle");
}

const calendarShown = () => buttons((n) => n.attributes?.["aria-label"] === "Previous month").length === 1;
const loadMore = () => buttons((n) => String(n.textContent).includes("Load more"));
const text = () => String(container.textContent);

async function mount() {
  await act(async () => {
    root.render(createElement(ToastProvider, null, createElement(QueueView as (p: NonNullable<Parameters<typeof QueueView>[0]>) => ReturnType<typeof QueueView>, { workspaceId: "ws-1" })));
  });
  await settle();
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  nextCursor = null;
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

describe("Queue: every loaded card removed", () => {
  it("list, older posts on the next page: Load more stays and no Nothing queued", async () => {
    nextCursor = "older";
    await mount();
    await deleteTheLoadedCard();
    expect(loadMore()).toHaveLength(1);
    expect(text()).not.toContain("Nothing queued");
    expect(text()).toContain("Older posts may be on the next page.");
  }, 10_000);

  it("list, the last page: Nothing queued, as now", async () => {
    await mount();
    await deleteTheLoadedCard();
    expect(text()).toContain("Nothing queued");
    expect(loadMore()).toHaveLength(0);
  }, 10_000);

  it("calendar, older posts on the next page: Load more stays", async () => {
    nextCursor = "older";
    await mount();
    await deleteTheLoadedCard();
    await showCalendar();
    expect(calendarShown()).toBe(true);
    expect(loadMore()).toHaveLength(1);
  }, 10_000);

  it("calendar, the last page: the empty month and no Load more, as now", async () => {
    await mount();
    await deleteTheLoadedCard();
    await showCalendar();
    expect(loadMore()).toHaveLength(0);
    expect(text()).not.toContain("Nothing queued");
    expect(calendarShown()).toBe(true);
  }, 10_000);
});
