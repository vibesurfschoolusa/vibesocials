import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * R60 publishing-flow L1 = pages-a L1: a lost race on Edit answered "This post
 * changed in the meantime. Try again." and the dialog added its copy step with
 * Save turned off, so "Try again" pointed at a button that no longer worked.
 * The dialog keys its line by the answer's code (POST_CHANGED): copy, Cancel,
 * open Edit again. Other moved-on answers keep editMovedOnText.
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
// Focus after the press has its own suite (focusAfter.test.ts); the fake DOM has no layout for it.
vi.mock("@/lib/focusAfter", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/focusAfter")>()),
  focusAfterPress: () => () => {},
}));
// The dialog drawn in place (no portal), so its text can be read.
vi.mock("@/components/ui/dialog", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/ui/dialog")>();
  const { createElement: h } = await import("react");
  return {
    ...actual,
    Dialog: ({ open, children }: { open: boolean; children: ReactNode }): ReactNode => (open ? h("div", { "data-dialog": "edit" }, children) : null),
    DialogTitle: ({ children }: { children: ReactNode }): ReactNode => h("h2", null, children),
  };
});

import { makeDocument, type FakeNode } from "@/components/shell/fakeDom.testkit";
import { ToastProvider } from "@/components/ui/toast";
import type { PostJobDTO } from "@/lib/postsDto";
import { QueueView } from "./queue-view";

let root: Root;
let container: FakeNode;

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

type Answer = () => Response;
/** The answers to the PATCH and to the publish request, in order. */
const patchAnswers: Answer[] = [];
const publishAnswers: Answer[] = [];
const sent: string[] = [];

const fetchMock = vi.fn(async (input: unknown, init?: { method?: string }) => {
  const url = String(input);
  const method = init?.method ?? "GET";
  if (method !== "GET") sent.push(`${method} ${url.split("?")[0]}`);
  if (method === "PATCH") return (patchAnswers.shift() ?? (() => Response.json({ ok: true })))();
  if (method === "POST" && url.includes("/publish")) {
    const next = publishAnswers.shift();
    if (!next) throw new Error("no publish answer queued");
    return next();
  }
  if (url.startsWith("/api/posts")) {
    return Response.json({
      jobs: [draft("job-a", "First post")],
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

const SAVED = new Date("2026-11-01T00:00:00.000Z").toLocaleString(undefined, {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

function dialog(): FakeNode {
  const found = findAll(container, (n) => n.attributes?.["data-dialog"] === "edit")[0];
  if (!found) throw new Error("no Edit dialog");
  return found;
}

async function click(node: FakeNode) {
  await act(async () => {
    void props(node).onClick({ currentTarget: null });
  });
  await settle();
}

async function change(node: FakeNode, value: string) {
  await act(async () => {
    props(node).onChange({ target: { value } });
  });
}

async function openEdit() {
  const label = `Edit "First post, ${SAVED}"`;
  const button = findAll(container, (n) => n.tagName === "BUTTON" && n.attributes?.["aria-label"] === label)[0];
  if (!button) throw new Error(`no button ${label}`);
  await click(button);
}

function dialogButton(text: string): FakeNode {
  const button = findAll(dialog(), (n) => n.tagName === "BUTTON" && n.textContent === text)[0];
  if (!button) throw new Error(`no ${text} button`);
  return button;
}

/** The dialog's moved-on line. */
function line(): string | null {
  const alert = findAll(dialog(), (n) => n.attributes?.role === "alert")[0];
  return alert ? String(alert.textContent) : null;
}

async function mount() {
  await act(async () => {
    root.render(createElement(ToastProvider, null, createElement(QueueView as (p: NonNullable<Parameters<typeof QueueView>[0]>) => ReturnType<typeof QueueView>, { workspaceId: "ws-1" })));
  });
  await settle();
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  patchAnswers.length = 0;
  publishAnswers.length = 0;
  sent.length = 0;
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

const CHANGED: Answer = () => Response.json({ error: "This post changed in the meantime. Try again.", code: "POST_CHANGED" }, { status: 409 });

describe("Queue: the Edit dialog after a lost race", () => {
  it("a lost Save: copy your text, press Cancel, then open Edit again; Save stays off", async () => {
    await mount();
    await openEdit();
    patchAnswers.push(CHANGED);
    await click(dialogButton("Save changes"));
    expect(line()).toBe("This post changed in the meantime. Copy your text, press Cancel, then open Edit again.");
    expect(props(dialogButton("Save changes")).disabled).toBe(true);
  }, 10_000);

  it("a lost Save and schedule, its caption save lost: the same line", async () => {
    await mount();
    await openEdit();
    await change(findAll(dialog(), (n) => n.attributes?.id === "queue-edit-time")[0]!, "2099-01-01T10:00");
    patchAnswers.push(CHANGED);
    await click(dialogButton("Save and schedule"));
    expect(sent).toEqual(["PATCH /api/posts/job-a"]);
    expect(line()).toBe("This post changed in the meantime. Copy your text, press Cancel, then open Edit again.");
  }, 10_000);

  it("a lost Save and schedule after the caption was saved: nothing to copy", async () => {
    await mount();
    await openEdit();
    await change(findAll(dialog(), (n) => n.attributes?.id === "queue-edit-caption")[0]!, "A new caption");
    await change(findAll(dialog(), (n) => n.attributes?.id === "queue-edit-time")[0]!, "2099-01-01T10:00");
    publishAnswers.push(CHANGED);
    await click(dialogButton("Save and schedule"));
    expect(sent).toEqual(["PATCH /api/posts/job-a", "POST /api/posts/job-a/publish"]);
    expect(line()).toBe("This post changed in the meantime. Your caption changes were saved. Press Cancel, then open Edit again.");
  }, 10_000);

  it("a post that really moved on keeps its sentence and the copy step", async () => {
    await mount();
    await openEdit();
    patchAnswers.push(() =>
      Response.json(
        { error: "This post has started publishing, so it can't be edited. Check Activity to see how it goes.", code: "NOT_EDITABLE" },
        { status: 409 },
      ),
    );
    await click(dialogButton("Save changes"));
    expect(line()).toBe(
      "This post has started publishing, so it can't be edited. Check Activity to see how it goes. Copy your text if you want to keep it, then press Cancel.",
    );
  }, 10_000);
});
