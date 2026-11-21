import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * R56 pages-a L5: the approval-limit refusal runs 38-68 words, and the toast
 * that carried it closes after 8 s. A refused Approve now also leaves its
 * sentence as a line under that card's Approve and Reject, until the next
 * press on that card.
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

import { makeDocument, type FakeNode } from "@/components/shell/fakeDom.testkit";
import { ToastProvider } from "@/components/ui/toast";
import type { PostJobDTO } from "@/lib/postsDto";
import { QueueView } from "./queue-view";

let root: Root;
let container: FakeNode;

const LIMIT_TEXT =
  "This workspace has reached its limit of 10 posts a day for that day. Approve it again once that day has room, or reject it and ask the member to schedule it for another day.";
const REJECT_TEXT = "That post can't be rejected right now.";

function pending(id: string, caption: string): PostJobDTO {
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
    approvalState: "pending",
  };
}

type Answer = () => Response | Promise<Response>;
const answers: Answer[] = [];

const fetchMock = vi.fn(async (input: unknown) => {
  const url = String(input);
  if (url.includes("/approval")) {
    const next = answers.shift();
    if (!next) throw new Error("no answer queued");
    return next();
  }
  if (url.startsWith("/api/posts")) {
    return Response.json({
      jobs: [pending("job-a", "First post"), pending("job-b", "Second post")],
      workspaceId: "ws-1",
      workspaceMemberCount: 2,
      workspaceRole: "owner",
      workspaceRequireApproval: true,
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

function buttonLabelled(label: string): FakeNode {
  const button = findAll(container, (n) => n.tagName === "BUTTON" && n.attributes?.["aria-label"] === label)[0];
  if (!button) throw new Error(`no button ${label}`);
  return button;
}

async function press(label: string) {
  const button = buttonLabelled(label);
  await act(async () => {
    // Focus moving on after the press is not under test here.
    void props(button).onClick({ currentTarget: null });
  });
  await settle();
}

const approveButtons = (node: FakeNode) => findAll(node, (n) => n.tagName === "BUTTON" && n.textContent === "Approve");

/**
 * The nearest ancestor that also holds an Approve button, when it holds just
 * one: the card's decision row. The toast's nearest such ancestor is the page,
 * holding every card's.
 */
function cardRow(node: FakeNode): FakeNode | null {
  let at: FakeNode | null = node;
  while (at && approveButtons(at).length === 0) at = at.parentNode as FakeNode | null;
  return at && approveButtons(at).length === 1 ? at : null;
}

// Lines inside a card; the error toast (also role="alert") sits outside every card and may stay.
const lineNodes = (text: string) =>
  findAll(container, (n) => n.attributes?.role === "alert" && n.textContent === text).filter((n) => cardRow(n) !== null);

/** Whether the node sits in the same card as `caption`'s Approve button. */
function sharesCardWith(node: FakeNode, caption: string): boolean {
  const approve = buttonLabelled(`Approve "${caption}"`);
  const row = cardRow(node);
  return !!row && findAll(row, (n) => n === approve).length === 1;
}

async function mount() {
  await act(async () => {
    root.render(createElement(ToastProvider, null, createElement(QueueView as (p: NonNullable<Parameters<typeof QueueView>[0]>) => ReturnType<typeof QueueView>, { workspaceId: "ws-1" })));
  });
  await settle();
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  answers.length = 0;
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

const limitRefusal: Answer = () => Response.json({ error: LIMIT_TEXT, code: "DAILY_POST_LIMIT" }, { status: 429 });
const rejectRefusal: Answer = () => Response.json({ error: REJECT_TEXT, code: "NOT_PENDING" }, { status: 400 });

describe("Queue: a refused Approve keeps its sentence on the card", () => {
  it("a 429 approval refusal shows the line, as an alert, on that card only", async () => {
    await mount();
    answers.push(limitRefusal);
    await press('Approve "First post"');
    const lines = lineNodes(LIMIT_TEXT);
    expect(lines).toHaveLength(1);
    expect(sharesCardWith(lines[0]!, "First post")).toBe(true);
    expect(sharesCardWith(lines[0]!, "Second post")).toBe(false);
  }, 10_000);

  it("the next press on that card clears it", async () => {
    await mount();
    answers.push(limitRefusal);
    await press('Approve "First post"');
    expect(lineNodes(LIMIT_TEXT)).toHaveLength(1);
    let release: (r: Response) => void = () => {};
    answers.push(() => new Promise<Response>((resolve) => (release = resolve)));
    await press('Reject "First post"');
    expect(lineNodes(LIMIT_TEXT)).toHaveLength(0);
    await act(async () => release(Response.json({ ok: true, approvalState: "rejected" })));
    await settle();
  }, 10_000);

  it("a press on another card leaves it", async () => {
    await mount();
    answers.push(limitRefusal);
    await press('Approve "First post"');
    answers.push(rejectRefusal);
    await press('Reject "Second post"');
    const lines = lineNodes(LIMIT_TEXT);
    expect(lines).toHaveLength(1);
    expect(sharesCardWith(lines[0]!, "First post")).toBe(true);
  }, 10_000);

  it("a successful approve shows no line", async () => {
    await mount();
    answers.push(() => Response.json({ ok: true, status: "scheduled", approvalState: "approved" }));
    await press('Approve "First post"');
    // The client review link panel's own load error (no link mocked here) is the only alert left.
    const alerts = findAll(container, (n) => n.attributes?.role === "alert").map((n) => String(n.textContent ?? ""));
    expect(alerts.filter((text) => !text.startsWith("Couldn't load the client review link"))).toEqual([]);
    expect(lineNodes(LIMIT_TEXT)).toHaveLength(0);
  }, 10_000);

  it("a refused Reject leaves no line on the card, as now", async () => {
    await mount();
    answers.push(rejectRefusal);
    await press('Reject "First post"');
    expect(lineNodes(REJECT_TEXT)).toHaveLength(0);
  }, 10_000);
});
