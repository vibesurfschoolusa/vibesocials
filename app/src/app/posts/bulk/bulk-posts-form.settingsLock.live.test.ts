import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * R67 pages-a L1: while Schedule all sends, the settings block it disables
 * looks disabled too, as Create's do since #309: the "Post every row to"
 * choices and the Story settings show the locked look, with no hover. Enabled,
 * their classes are as before.
 * R68 pages-b L2: the "Use my posting times" label too.
 */

vi.mock("next/link", async () => {
  const { createElement: h } = await import("react");
  return { default: ({ href, children, ...rest }: { href: string; children: unknown }) => h("a", { href, ...rest }, children as never) };
});
vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams(), useRouter: () => ({ push() {}, refresh() {} }) }));
vi.mock("@/hooks/useConnections", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/useConnections")>()),
  useConnections: () => ({
    connections: [
      { platform: "x", connected: true },
      { platform: "instagram", connected: true },
      { platform: "facebook_page", connected: true },
    ],
    loading: false,
    error: null,
    reload: () => {},
  }),
}));
vi.mock("@/lib/prepareUploadFile", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/prepareUploadFile")>()),
  prepareUploadFile: (file: File) => Promise.resolve(file),
}));
vi.mock("@vercel/blob/client", () => ({
  upload: (key: string) => Promise.resolve({ url: `https://blob.example/${key}` }),
}));

import { makeDocument, type FakeNode } from "@/components/shell/fakeDom.testkit";
import { ToastProvider } from "@/components/ui/toast";
import { BulkPostsForm } from "./bulk-posts-form";

let root: Root;
let container: FakeNode;
let posts: number;
/** Each POST waits here until the test answers it. */
const waiting: (() => void)[] = [];

const fetchMock = vi.fn((input: unknown, init?: { method?: string }) => {
  const url = String(input);
  if (url === "/api/posts" && init?.method === "POST") {
    posts += 1;
    const id = `post-${posts}`;
    return new Promise<Response>((resolve) => waiting.push(() => resolve(Response.json({ postJob: { id } }))));
  }
  // One posting time, so "Use my posting times" shows.
  if (url.startsWith("/api/posts/scheduled-times")) {
    return Promise.resolve(Response.json({ times: [], slots: [{ day: 1, time: "09:00" }] }));
  }
  return Promise.resolve(Response.json({}));
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
function byId(id: string): FakeNode {
  const hit = findAll(container, (n) => n.attributes?.id === id)[0];
  if (!hit) throw new Error(`no #${id}`);
  return hit;
}
function button(label: string): FakeNode {
  const hit = findAll(container, (n) => n.nodeName === "BUTTON" && (n.textContent as string).trim() === label)[0];
  if (!hit) throw new Error(`no ${label} button`);
  return hit;
}

async function settle() {
  for (let i = 0; i < 8; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}
async function run(step: () => unknown) {
  await act(async () => {
    void step();
  });
  await settle();
}

const photo = (name: string) => new File([name], `${name}.jpg`, { type: "image/jpeg" });

async function mountWithTwoPhotos() {
  await act(async () => {
    root.render(createElement(ToastProvider, null, createElement(BulkPostsForm, { workspaceId: "ws-1" })));
  });
  await settle();
  await run(() => props(byId("bulk-ai-captions")).onChange({ target: { checked: false } }));
  await run(() => props(byId("bulk-files")).onChange({ target: { files: [photo("a"), photo("b")] } }));
  const boxes = findAll(container, (n) => n.nodeName === "TEXTAREA");
  for (const [index, box] of boxes.entries()) {
    await run(() => props(box).onChange({ target: { value: `Caption ${index + 1}` } }));
  }
}

const classesOf = (node: FakeNode) => String(node.attributes.class ?? "").split(/\s+/).filter(Boolean);
const bareHover = (node: FakeNode) => classesOf(node).filter((c) => c.startsWith("hover:"));
const isDisabled = (node: FakeNode) => (props(node).disabled as unknown) === true;
/** Disabled itself, or inside a disabled fieldset (which disables every control in it). */
function locked(node: FakeNode): boolean {
  if (isDisabled(node)) return true;
  for (let at: FakeNode | null = node.parentNode; at; at = at.parentNode) {
    if (at.nodeName === "FIELDSET" && isDisabled(at)) return true;
  }
  return false;
}
function labelsUnder(legendText: string): FakeNode[] {
  const legend = findAll(container, (n) => n.nodeName === "LEGEND" && n.textContent === legendText)[0];
  const all = legend?.parentNode ? findAll(legend.parentNode, (n) => n.nodeName === "LABEL") : [];
  if (all.length === 0) throw new Error(`no labels under ${legendText}`);
  return all;
}
const inputIn = (label: FakeNode) => findAll(label, (n) => n.nodeName === "INPUT")[0]!;
/** The "Post every row to" choices: the labels holding a platform checkbox (the Story radios sit in the same fieldset). */
const platformChoices = () =>
  labelsUnder("Post every row to").filter((label) => (props(inputIn(label))?.type as unknown) === "checkbox");
const STORY_LEGENDS = ["Instagram: post to", "Facebook Page: post to"];
const storyLabels = () => STORY_LEGENDS.flatMap(labelsUnder);
/** The Story settings' own fieldsets: their `disabled` draws the locked look. */
const storyFieldsets = () =>
  STORY_LEGENDS.map((text) => findAll(container, (n) => n.nodeName === "LEGEND" && n.textContent === text)[0]!.parentNode!);

function slotsLabel(): FakeNode {
  const hit = findAll(container, (n) => n.nodeName === "LABEL" && (n.textContent as string).includes("Use my posting times"))[0];
  if (!hit) throw new Error("no Use my posting times label");
  return hit;
}
const SLOTS_AS_NOW = "flex items-center gap-2 text-sm text-foreground";

const CHOICE_AS_NOW = "flex min-h-11 cursor-pointer items-center gap-2 rounded-[var(--radius)] border border-input px-3 text-sm";
const STORY_BASE = "inline-flex items-center gap-2 rounded-[var(--radius)] border px-3 py-1.5 text-sm transition-colors";
const STORY_CHECKED = `${STORY_BASE} cursor-pointer border-primary/40 bg-primary/10 text-foreground`;
const STORY_UNCHECKED = `${STORY_BASE} cursor-pointer border-input text-muted-foreground hover:text-foreground`;

function expectAsNow() {
  const choices = platformChoices();
  expect(choices.length).toBe(3);
  for (const choice of choices) {
    expect(locked(inputIn(choice)), choice.textContent as string).toBe(false);
    expect(choice.attributes.class, choice.textContent as string).toBe(CHOICE_AS_NOW);
  }
  for (const fieldset of storyFieldsets()) expect(isDisabled(fieldset)).toBe(false);
  for (const label of storyLabels()) {
    expect(locked(inputIn(label))).toBe(false);
    const checked = (props(inputIn(label)).checked as unknown) === true;
    expect(label.attributes.class, label.textContent as string).toBe(checked ? STORY_CHECKED : STORY_UNCHECKED);
  }
  expect(locked(inputIn(slotsLabel()))).toBe(false);
  expect(slotsLabel().attributes.class).toBe(SLOTS_AS_NOW);
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
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  Object.assign(made.doc.defaultView as object, {
    matchMedia: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }),
    location: { href: "http://localhost/posts/bulk" },
    localStorage: { getItem: () => null, setItem() {} },
  });
  posts = 0;
  waiting.length = 0;
  root = createRoot(container as unknown as HTMLElement);
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});

const scheduleAll = () => run(() => props(button("Schedule all")).onClick({ currentTarget: null }));
async function answerEveryPost() {
  for (let i = 0; i < 10 && waiting.length > 0; i += 1) await run(() => waiting.shift()!());
}

describe("Add many: the settings Schedule all locks look locked (R67 pages-a L1)", () => {
  it("with no send: the choices and Story settings are as now", async () => {
    await mountWithTwoPhotos();
    expectAsNow();
  }, 10_000);

  it("during Schedule all: each choice and Story setting is disabled with the locked look, and no hover", async () => {
    await mountWithTwoPhotos();
    await scheduleAll();
    expect(posts).toBeGreaterThan(0);

    for (const choice of platformChoices()) {
      expect(locked(inputIn(choice)), choice.textContent as string).toBe(true);
      expect(classesOf(choice), choice.textContent as string).toEqual(expect.arrayContaining(["cursor-not-allowed", "opacity-50"]));
      expect(classesOf(choice)).not.toContain("cursor-pointer");
      expect(bareHover(choice)).toEqual([]);
    }
    for (const fieldset of storyFieldsets()) expect(isDisabled(fieldset)).toBe(true);
    for (const label of storyLabels()) {
      expect(locked(inputIn(label)), label.textContent as string).toBe(true);
      expect(classesOf(label), label.textContent as string).toEqual(expect.arrayContaining(["cursor-not-allowed", "opacity-50"]));
      expect(classesOf(label)).not.toContain("cursor-pointer");
      expect(bareHover(label)).toEqual([]);
    }
    expect(locked(inputIn(slotsLabel()))).toBe(true);
    expect(classesOf(slotsLabel())).toEqual(expect.arrayContaining(["cursor-not-allowed", "opacity-50"]));
    expect(bareHover(slotsLabel())).toEqual([]);
    await answerEveryPost();
  }, 10_000);

  it("after the send: each is enabled, with its classes as now", async () => {
    await mountWithTwoPhotos();
    await scheduleAll();
    expect(posts).toBeGreaterThan(0);
    await answerEveryPost();
    expect(waiting).toHaveLength(0);
    expectAsNow();
  }, 10_000);
});
