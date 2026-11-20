import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * R45 pages-a L3: Add many's photo description had maxLength 1000, so a paste
 * was cut without a word. It now stays whole with a count, and a row whose
 * description is over is not sent: its line says why.
 */

vi.mock("next/link", async () => {
  const { createElement: h } = await import("react");
  return { default: ({ href, children, ...rest }: { href: string; children: unknown }) => h("a", { href, ...rest }, children as never) };
});
vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams(), useRouter: () => ({ push() {}, refresh() {} }) }));
vi.mock("@/hooks/useConnections", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/useConnections")>()),
  useConnections: () => ({ connections: [{ platform: "x", connected: true }], loading: false, error: null, reload: () => {} }),
}));
vi.mock("@/lib/prepareUploadFile", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/prepareUploadFile")>()),
  prepareUploadFile: (file: File) => Promise.resolve(file),
}));
vi.mock("@vercel/blob/client", () => ({
  upload: (key: string) => Promise.resolve({ url: `https://blob.example/${key}` }),
}));

import { makeDocument, type FakeNode } from "@/components/shell/fakeDom.testkit";
import { makeFocusable, type FocusDoc } from "@/lib/focusDom.testkit";
import { ToastProvider } from "@/components/ui/toast";
import { BulkPostsForm } from "./bulk-posts-form";
import { ALT_TEXT_TOO_LONG_TEXT } from "./bulk-post-row";
import { BULK_CAPTION_TOO_LONG_MESSAGE } from "@/lib/bulkPosts";

let root: Root;
let doc: FocusDoc;
let container: FakeNode;
/** The posting times the workspace has; none means the box is not offered. */
let slots: { day: number; time: string }[];
let posts: number;
/** POSTs sent whose answer has not come yet. */
let inFlight = 0;
let sentBodies: { baseCaption?: string; altText?: string }[];

const fetchMock = vi.fn(async (input: unknown, init?: { method?: string }) => {
  const url = String(input);
  if (url.startsWith("/api/posts/scheduled-times")) return Response.json({ times: [], slots });
  if (url === "/api/posts" && init?.method === "POST") {
    posts += 1;
    sentBodies.push(JSON.parse(String((init as { body?: string }).body)));
    // An answer takes a turn, so the rows are locked (disabled) while it comes.
    inFlight += 1;
    await new Promise((resolve) => setTimeout(resolve, 0));
    inFlight -= 1;
    return Response.json({ postJob: { id: `post-${posts}` } });
  }
  return Response.json({});
});

function findAll(node: FakeNode, test: (n: FakeNode) => boolean, hits: FakeNode[] = []): FakeNode[] {
  if (test(node)) hits.push(node);
  for (const child of node.childNodes) findAll(child, test, hits);
  return hits;
}

function props(node: FakeNode): Record<string, (arg?: unknown) => unknown> & { value?: string } {
  const key = Object.keys(node).find((k) => k.startsWith("__reactProps$"));
  return node[key as string] as Record<string, (arg?: unknown) => unknown> & { value?: string };
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

function rowInput(index: number, nodeName: "TEXTAREA" | "INPUT"): FakeNode {
  const rows = findAll(container, (n) => n.nodeName === "LI" && findAll(n, (m) => m.nodeName === "TEXTAREA").length > 0);
  return findAll(rows[index]!, (n) =>
    nodeName === "TEXTAREA" ? n.nodeName === "TEXTAREA" : n.nodeName === "INPUT" && props(n)?.type === ("datetime-local" as never),
  )[0]!;
}

/** As a browser does: a field that is disabled loses the focus, to the body. */
function dropFocusFromDisabled() {
  const active = doc.activeElement as FakeNode | null;
  if (active && active !== doc.body && (props(active) as { disabled?: unknown } | undefined)?.disabled) {
    doc.activeElement = doc.body;
  }
}

async function settle() {
  for (let i = 0; i < 8; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    dropFocusFromDisabled();
  }
}

async function run(step: () => unknown) {
  await act(async () => {
    void step();
  });
  await settle();
}

const photo = (name: string) => new File([name], `${name}.jpg`, { type: "image/jpeg" });

async function mountWithThreePhotos() {
  await act(async () => {
    root.render(createElement(ToastProvider, null, createElement(BulkPostsForm, { workspaceId: "ws-1" })));
  });
  await settle();
  await run(() => props(byId("bulk-ai-captions")).onChange({ target: { checked: false } }));
  await run(() => props(byId("bulk-files")).onChange({ target: { files: [photo("a"), photo("b"), photo("c")] } }));
  for (const [index, caption] of ["One", "Two", "Three"].entries()) {
    await run(() => props(rowInput(index, "TEXTAREA")).onChange({ target: { value: caption } }));
  }
}

const saveAllAsDrafts = () => run(() => props(button("Save all as drafts")).onClick({ currentTarget: null }));

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const made = makeDocument();
  container = made.container;
  doc = made.doc as unknown as FocusDoc;
  makeFocusable(doc);
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
  slots = [];
  posts = 0;
  sentBodies = [];
  root = createRoot(container as unknown as HTMLElement);
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});

function altField(index: number): FakeNode {
  return byId(`bulk-alt-${rowIds()[index]}`);
}

function rowIds(): string[] {
  return findAll(container, (n) => n.nodeName === "INPUT" && String(n.attributes?.id ?? "").startsWith("bulk-alt-")).map((n) =>
    String(n.attributes.id).slice("bulk-alt-".length),
  );
}

const LONG = `${"A surfer rides a green wave at sunrise near the pier. ".repeat(19)}`.trim();

describe("Add many: a photo description longer than 1,000 characters", () => {
  it("a paste stays whole, and the count says how long it is", async () => {
    expect(LONG.length).toBeGreaterThan(1000);
    await mountWithThreePhotos();
    const field = altField(0);
    expect(props(field).maxLength).toBeUndefined();
    await run(() => props(field).onChange({ target: { value: LONG } }));
    expect(props(altField(0)).value).toBe(LONG);
    const count = byId(String(props(altField(0))["aria-describedby"]));
    const over = (LONG.length - 1000).toLocaleString("en-US");
    expect(count.textContent).toBe(`${LONG.length.toLocaleString("en-US")} of 1,000 characters (${over} over). Shorten it to schedule or save this photo.`);
  });

  it("its row is not sent, and says why; the other rows are sent", async () => {
    await mountWithThreePhotos();
    await run(() => props(altField(1)).onChange({ target: { value: LONG } }));
    // When the focus moves: the rows are locked (their fields disabled) until
    // every send has its answer, and a disabled field loses the focus.
    const focusedAt: { posts: number; inFlight: number }[] = [];
    const field = altField(1) as FakeNode & { focus: () => void };
    const focus = field.focus;
    field.focus = () => {
      focusedAt.push({ posts, inFlight });
      focus();
    };
    await saveAllAsDrafts();
    expect(focusedAt).toEqual([{ posts: 2, inFlight: 0 }]);
    expect(sentBodies.map((b) => b.baseCaption)).toEqual(["One", "Three"]);
    expect(container.textContent).toContain(ALT_TEXT_TOO_LONG_TEXT);
    // R45 lead review: the press takes the person to the field to shorten;
    // second review: once the other rows' sends are done and the fields are
    // enabled again, so the focus is not lost to a disabled field.
    expect(doc.activeElement).toBe(altField(1));
  });

  it("with nothing else to send, the description takes the focus at once", async () => {
    await mountWithThreePhotos();
    for (const index of [0, 1, 2]) {
      await run(() => props(altField(index)).onChange({ target: { value: LONG } }));
    }
    await saveAllAsDrafts();
    expect(posts).toBe(0);
    expect(doc.activeElement).toBe(altField(0));
  });

  it("Schedule all too: the row is held and its description takes the focus", async () => {
    await mountWithThreePhotos();
    await run(() => props(altField(2)).onChange({ target: { value: LONG } }));
    await run(() => props(button("Schedule all")).onClick({ currentTarget: null }));
    expect(sentBodies.map((b) => b.baseCaption)).toEqual(["One", "Two"]);
    expect(doc.activeElement).toBe(altField(2));
  });

  it("under the limit: sent as before", async () => {
    await mountWithThreePhotos();
    await run(() => props(altField(1)).onChange({ target: { value: "a".repeat(1000) } }));
    await saveAllAsDrafts();
    expect(sentBodies.map((b) => b.baseCaption)).toEqual(["One", "Two", "Three"]);
    expect(container.textContent).not.toContain(ALT_TEXT_TOO_LONG_TEXT);
    expect(doc.activeElement).not.toBe(altField(1));
  });
});

// R52 pages-a L3, publishing-flow L1: a caption over 10,000 characters is held
// on its row before sending, so no route refusal names "baseCaption".
describe("Add many: a caption longer than 10,000 characters", () => {
  /** How many times the page says a caption is too long (the counter's alert, or a row line). */
  const lengthRefusals = () => (String(container.textContent).match(/caption is too long/gi) ?? []).length;

  it("Schedule all: the other rows go; that row stays, with one refusal and its caption", async () => {
    await mountWithThreePhotos();
    const long = "a".repeat(10_001);
    await run(() => props(rowInput(1, "TEXTAREA")).onChange({ target: { value: long } }));
    // R52 fix review L1: said once, before and after the press.
    expect(lengthRefusals()).toBe(1);
    await run(() => props(button("Schedule all")).onClick({ currentTarget: null }));
    expect(sentBodies.map((b) => b.baseCaption)).toEqual(["One", "Three"]);
    expect(lengthRefusals()).toBe(1);
    expect(container.textContent).not.toContain(BULK_CAPTION_TOO_LONG_MESSAGE);
    expect(container.textContent).not.toContain("baseCaption");
    expect(props(rowInput(1, "TEXTAREA")).value).toBe(long);
    // As for a long description: the press takes the person to the caption to shorten.
    expect(doc.activeElement).toBe(rowInput(1, "TEXTAREA"));
  });

  it("a long caption and a long description on one row: each reason once; the other rows go", async () => {
    await mountWithThreePhotos();
    await run(() => props(rowInput(1, "TEXTAREA")).onChange({ target: { value: "a".repeat(10_001) } }));
    await run(() => props(altField(1)).onChange({ target: { value: LONG } }));
    await run(() => props(button("Schedule all")).onClick({ currentTarget: null }));
    expect(sentBodies.map((b) => b.baseCaption)).toEqual(["One", "Three"]);
    expect(lengthRefusals()).toBe(1);
    expect(String(container.textContent).split(ALT_TEXT_TOO_LONG_TEXT).length - 1).toBe(1);
    expect(doc.activeElement).toBe(rowInput(1, "TEXTAREA"));
  });

  it("with nothing else to send, the first long caption takes the focus at once", async () => {
    await mountWithThreePhotos();
    for (const index of [0, 1, 2]) {
      await run(() => props(rowInput(index, "TEXTAREA")).onChange({ target: { value: "a".repeat(10_001) } }));
    }
    await saveAllAsDrafts();
    expect(posts).toBe(0);
    expect(doc.activeElement).toBe(rowInput(0, "TEXTAREA"));
  });

  it("a long caption in an earlier row than a long description: the caption takes the focus", async () => {
    await mountWithThreePhotos();
    await run(() => props(rowInput(0, "TEXTAREA")).onChange({ target: { value: "a".repeat(10_001) } }));
    await run(() => props(altField(2)).onChange({ target: { value: LONG } }));
    await saveAllAsDrafts();
    expect(sentBodies.map((b) => b.baseCaption)).toEqual(["Two"]);
    expect(doc.activeElement).toBe(rowInput(0, "TEXTAREA"));
  });

  it("at the cap: sent as before, and the focus stays", async () => {
    await mountWithThreePhotos();
    await run(() => props(rowInput(1, "TEXTAREA")).onChange({ target: { value: "a".repeat(10_000) } }));
    await saveAllAsDrafts();
    expect(posts).toBe(3);
    expect(container.textContent).not.toContain(BULK_CAPTION_TOO_LONG_MESSAGE);
    expect(doc.activeElement).not.toBe(rowInput(1, "TEXTAREA"));
  });
});
