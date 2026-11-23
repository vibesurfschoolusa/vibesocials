import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * R68 publishing-flow-2 L2: a quiet reload (a series cancel, a refusal, a lost
 * answer, the calendar) read page 1 again and replaced the list with it, so
 * every page pulled in with Load more went away. It now reads as many pages as
 * are loaded, and the next-page marker is the last one read.
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
vi.mock("@/lib/focusAfter", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/focusAfter")>()),
  focusAfterPress: () => () => {},
}));
// The Edit dialog drawn in place; the confirm step as one button with its confirm text.
vi.mock("@/components/ui/dialog", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/ui/dialog")>();
  const { createElement: h } = await import("react");
  return {
    ...actual,
    Dialog: ({ open, children }: { open: boolean; children: ReactNode }): ReactNode => (open ? h("div", { "data-dialog": "edit" }, children) : null),
    DialogTitle: ({ children }: { children: ReactNode }): ReactNode => h("h2", null, children),
    ConfirmDialog: ({
      open,
      description,
      confirmText,
      onConfirm,
    }: {
      open: boolean;
      description?: ReactNode;
      confirmText?: string;
      onConfirm: () => unknown;
    }): ReactNode =>
      open
        ? h("div", { "data-confirm-dialog": "" }, description, h("button", { "data-confirm": confirmText, onClick: () => void Promise.resolve(onConfirm()).catch(() => {}) }, confirmText))
        : null,
  };
});

import { makeDocument, type FakeNode } from "@/components/shell/fakeDom.testkit";
import { ToastProvider } from "@/components/ui/toast";
import type { PostJobDTO } from "@/lib/postsDto";
import { QueueView } from "./queue-view";

let root: Root;
let container: FakeNode;

/** Next month, so every post is in the future and the calendar finds it one month on. */
function at(day: number): string {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth() + 1, day, 12, 0).toISOString();
}

function scheduled(n: number, seriesId?: string): PostJobDTO {
  return {
    id: `job-${n}`,
    status: "scheduled",
    createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-01T00:00:00.000Z",
    scheduledFor: at(n),
    caption: `Post ${n}`,
    platformCaptions: null,
    results: [],
    media: null,
    mediaCount: 1,
    publish: null,
    createdBy: null,
    approvalState: "none",
    ...(seriesId ? { seriesId } : {}),
  } as PostJobDTO;
}

const PAGE = 2;
/** The server's posts, in list order; a page is PAGE of them, its cursor the offset. */
let store: PostJobDTO[] = [];
/** How the next cancel is answered: null cancels on the server. */
let cancelAnswer: (() => Response) | null = null;
let patchAnswer: (() => Response) | null = null;
const reads: string[] = [];
/** A page read at this cursor fails. */
let failCursor: string | null = null;
/** A page read at this cursor waits here until the test lets it go. */
let holdCursor: string | null = null;
const heldReads: (() => void)[] = [];

const fetchMock = vi.fn(async (input: unknown, init?: { method?: string }) => {
  const url = String(input);
  const method = init?.method ?? "GET";
  const path = url.split("?")[0]!;
  if (method === "GET" && path === "/api/posts") {
    reads.push(url);
    const cursor = new URLSearchParams(url.split("?")[1]).get("cursor");
    if (cursor !== null && cursor === failCursor) return Response.json({ error: "Something went wrong." }, { status: 500 });
    if (cursor !== null && cursor === holdCursor) await new Promise<void>((resolve) => heldReads.push(resolve));
    const from = cursor ? Number(cursor) : 0;
    return Response.json({
      jobs: store.slice(from, from + PAGE),
      workspaceId: "ws-1",
      workspaceMemberCount: 1,
      workspaceRole: "owner",
      workspaceRequireApproval: false,
      nextCursor: from + PAGE < store.length ? String(from + PAGE) : null,
    });
  }
  const id = path.split("/")[3];
  if (method === "POST" && path.endsWith("/cancel-series")) {
    if (cancelAnswer) return cancelAnswer();
    const target = store.find((job) => job.id === id)!;
    const gone = store.filter((job) => job.seriesId === target.seriesId && job.scheduledFor! >= target.scheduledFor!);
    store = store.filter((job) => !gone.includes(job));
    return Response.json({ cancelled: gone.length, notCancelled: 0 });
  }
  if (method === "POST" && path.endsWith("/cancel")) {
    if (cancelAnswer) return cancelAnswer();
    store = store.filter((job) => job.id !== id);
    return Response.json({ ok: true });
  }
  if (method === "PATCH") return (patchAnswer ?? (() => Response.json({ ok: true })))();
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
  for (let i = 0; i < 10; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}
async function click(node: FakeNode | undefined, what: string) {
  if (!node) throw new Error(`no ${what}`);
  await act(async () => {
    void props(node).onClick({ currentTarget: null });
  });
  await settle();
}
const buttons = (test: (n: FakeNode) => boolean) => findAll(container, (n) => n.tagName === "BUTTON" && test(n));
const labelled = (prefix: string) => buttons((n) => String(n.attributes?.["aria-label"] ?? "").startsWith(prefix))[0];
const text = () => String(container.textContent);
const loadMoreButton = () => buttons((n) => String(n.textContent).includes("Load more"))[0];
/** The posts on the page, by caption: cards in the list, chips in the calendar. */
const shown = () => [1, 2, 3, 4, 5, 6, 7, 8].filter((n) => text().includes(`Post ${n}`));

async function mount() {
  await act(async () => {
    root.render(createElement(ToastProvider, null, createElement(QueueView as (p: NonNullable<Parameters<typeof QueueView>[0]>) => ReturnType<typeof QueueView>, { workspaceId: "ws-1" })));
  });
  await settle();
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  cancelAnswer = null;
  patchAnswer = null;
  reads.length = 0;
  failCursor = null;
  holdCursor = null;
  heldReads.length = 0;
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

describe("Queue: a quiet reload keeps the pages loaded with Load more (R68 publishing-flow-2 L2)", () => {
  it("Load more, then a series cancel from a page-2 card: page 2 stays, the cancelled posts are gone", async () => {
    // Pages: [1, 2], [3, 4], [5, 6]; posts 4 and 6 are one series.
    store = [scheduled(1), scheduled(2), scheduled(3), scheduled(4, "s1"), scheduled(5), scheduled(6, "s1")];
    await mount();
    await click(loadMoreButton(), "Load more");
    expect(shown()).toEqual([1, 2, 3, 4]);

    await click(labelled('Cancel "Post 4'), "Cancel on Post 4");
    const rest = findAll(container, (n) => n.tagName === "INPUT" && (props(n).name as unknown) === "cancel-scope")[1];
    await act(async () => {
      props(rest!).onChange();
    });
    await click(buttons((n) => n.attributes?.["data-confirm"] === "Cancel posts")[0], "Cancel posts");

    expect(text()).toContain("cancelled");
    // Two pages read again: post 3 stays, post 5 moved up into page 2, 4 and 6 are gone.
    expect(shown()).toEqual([1, 2, 3, 5]);
    // The marker is the last page read: nothing is left to load.
    expect(loadMoreButton()).toBeUndefined();
  }, 15_000);

  it("Load more, then a refused cancel (409) that reloads: page 2 stays, and Load more still reads page 3", async () => {
    store = [1, 2, 3, 4, 5, 6].map((n) => scheduled(n));
    await mount();
    await click(loadMoreButton(), "Load more");
    cancelAnswer = () => Response.json({ error: "This post changed in the meantime. Try again." }, { status: 409 });

    await click(labelled('Cancel "Post 3'), "Cancel on Post 3");
    await click(buttons((n) => n.attributes?.["data-confirm"] === "Cancel post")[0], "Cancel post");

    expect(shown()).toEqual([1, 2, 3, 4]);
    await click(loadMoreButton(), "Load more");
    expect(shown()).toEqual([1, 2, 3, 4, 5, 6]);
    expect(loadMoreButton()).toBeUndefined();
  }, 15_000);

  it("the calendar: Load more, then an Edit save on a page-2 chip whose answer is lost: the page-2 chips stay", async () => {
    store = [1, 2, 3, 4, 5, 6].map((n) => scheduled(n));
    await mount();
    await click(buttons((n) => n.textContent === "Calendar")[0], "Calendar toggle");
    await click(loadMoreButton(), "Load more");
    await click(labelled("Next month"), "Next month");
    expect(shown()).toEqual([1, 2, 3, 4]);

    const chip = buttons((n) => String(n.textContent).includes("Post 4"))[0];
    await click(chip, "Post 4 chip");
    patchAnswer = () => new Response("Bad gateway", { status: 502 });
    const dialog = findAll(container, (n) => n.attributes?.["data-dialog"] === "edit")[0];
    if (!dialog) throw new Error("no Edit dialog");
    await click(findAll(dialog, (n) => n.tagName === "BUTTON" && n.textContent === "Save changes")[0], "Save changes");

    // The lost answer read the Queue again.
    expect(reads.length).toBeGreaterThan(2);
    expect(shown()).toEqual([1, 2, 3, 4]);
    expect(loadMoreButton()).toBeDefined();
  }, 15_000);

  // R68 BD1 review L1: a later page that fails no longer throws away the pages read.
  it("two pages loaded, a series cancel, and the page-2 read fails: page 1 is fresh, and Load more brings page 2", async () => {
    // Pages: [1, 2], [3, 4], [5, 6]; posts 2 and 3 are one series, from page 1 onto page 2.
    store = [scheduled(1), scheduled(2, "s1"), scheduled(3, "s1"), scheduled(4), scheduled(5), scheduled(6)];
    await mount();
    await click(loadMoreButton(), "Load more");
    expect(shown()).toEqual([1, 2, 3, 4]);
    failCursor = "2";

    await click(labelled('Cancel "Post 2'), "Cancel on Post 2");
    const rest = findAll(container, (n) => n.tagName === "INPUT" && (props(n).name as unknown) === "cancel-scope")[1];
    await act(async () => {
      props(rest!).onChange();
    });
    await click(buttons((n) => n.attributes?.["data-confirm"] === "Cancel posts")[0], "Cancel posts");

    // Page 1 as read again: post 2 is gone, post 4 moved up; the failed page 2 is not shown.
    expect(shown()).toEqual([1, 4]);
    failCursor = null;
    await click(loadMoreButton(), "Load more");
    expect(shown()).toEqual([1, 4, 5, 6]);
    expect(loadMoreButton()).toBeUndefined();
  }, 15_000);

  // R68 BD1 review L2: a Load more pressed while a quiet reload runs is kept.
  it("three pages loaded, Load more pressed during a quiet reload: page 4 stays", async () => {
    store = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => scheduled(n));
    await mount();
    await click(loadMoreButton(), "Load more");
    await click(loadMoreButton(), "Load more");
    expect(shown()).toEqual([1, 2, 3, 4, 5, 6]);
    cancelAnswer = () => Response.json({ error: "This post changed in the meantime. Try again." }, { status: 409 });
    // The reload's page-2 read waits, after it has counted the pages loaded.
    holdCursor = "2";

    await click(labelled('Cancel "Post 1'), "Cancel on Post 1");
    await click(buttons((n) => n.attributes?.["data-confirm"] === "Cancel post")[0], "Cancel post");
    expect(heldReads).toHaveLength(1);
    await click(loadMoreButton(), "Load more");
    expect(shown()).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);

    holdCursor = null;
    await act(async () => heldReads.shift()!());
    await settle();
    expect(shown()).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(loadMoreButton()).toBeUndefined();
  }, 15_000);

  // R69 pages-a L1: a Load more that lands after a quiet reload whose later
  // page failed must not skip the failed page.
  it("two pages loaded, Load more and a quiet reload at once; the reload's page-2 read fails and Load more's page-3 read lands after: page 2 is not skipped", async () => {
    // Pages: [1, 2], [3, 4], [5, 6], [7, 8].
    store = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => scheduled(n));
    await mount();
    await click(loadMoreButton(), "Load more");
    expect(shown()).toEqual([1, 2, 3, 4]);

    // Load more's page-3 read waits until the reload is over.
    holdCursor = "4";
    await click(loadMoreButton(), "Load more");
    expect(heldReads).toHaveLength(1);
    holdCursor = null;

    cancelAnswer = () => Response.json({ error: "This post changed in the meantime. Try again." }, { status: 409 });
    failCursor = "2";
    await click(labelled('Cancel "Post 1'), "Cancel on Post 1");
    await click(buttons((n) => n.attributes?.["data-confirm"] === "Cancel post")[0], "Cancel post");
    // The reload kept page 1 only: its page-2 read failed.
    expect(shown()).toEqual([1, 2]);
    failCursor = null;

    await act(async () => heldReads.shift()!());
    await settle();
    // The late page 3 is dropped, so page 2 is not skipped.
    expect(shown()).toEqual([1, 2]);

    const before = reads.length;
    await click(loadMoreButton(), "Load more");
    expect(reads[before]).toContain("cursor=2");
    expect(shown()).toEqual([1, 2, 3, 4]);
    await click(loadMoreButton(), "Load more");
    await click(loadMoreButton(), "Load more");
    expect(shown()).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    // No page twice: every card once.
    for (const n of [1, 2, 3, 4, 5, 6, 7, 8]) {
      expect(buttons((b) => String(b.attributes?.["aria-label"] ?? "").startsWith(`Cancel "Post ${n}`))).toHaveLength(1);
    }
    expect(loadMoreButton()).toBeUndefined();
  }, 15_000);

  it("one page loaded: the quiet reload reads page 1 only, as now", async () => {
    store = [1, 2, 3, 4, 5, 6].map((n) => scheduled(n));
    await mount();
    cancelAnswer = () => Response.json({ error: "This post changed in the meantime. Try again." }, { status: 409 });
    const before = reads.length;

    await click(labelled('Cancel "Post 2'), "Cancel on Post 2");
    await click(buttons((n) => n.attributes?.["data-confirm"] === "Cancel post")[0], "Cancel post");

    expect(reads.slice(before)).toHaveLength(1);
    expect(reads[before]).not.toContain("cursor=");
    expect(shown()).toEqual([1, 2]);
    expect(loadMoreButton()).toBeDefined();
  }, 15_000);
});
