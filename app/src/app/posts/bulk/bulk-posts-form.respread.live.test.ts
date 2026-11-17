import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * R44 publishing L1: a draft holds no time, so once "Save all as drafts" has
 * made some, the rows still to send take the places the drafts gave up. A row
 * whose time was set by hand keeps it.
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
import { ToastProvider } from "@/components/ui/toast";
import { BulkPostsForm } from "./bulk-posts-form";

let root: Root;
let container: FakeNode;
/** The posting times the workspace has; none means the box is not offered. */
let slots: { day: number; time: string }[];
let posts: number;

const fetchMock = vi.fn(async (input: unknown, init?: { method?: string }) => {
  const url = String(input);
  if (url.startsWith("/api/posts/scheduled-times")) return Response.json({ times: [], slots });
  if (url === "/api/posts" && init?.method === "POST") {
    posts += 1;
    // The third post is refused; the first two are saved as drafts.
    return posts === 3
      ? Response.json({ error: "That post was refused." }, { status: 400 })
      : Response.json({ postJob: { id: `post-${posts}` } });
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

/** Each row's date and time as shown, or "none" for a draft's "no time yet" line. */
function rowTimes(): string[] {
  return findAll(container, (n) => n.nodeName === "LI" && findAll(n, (m) => m.nodeName === "TEXTAREA").length > 0).map(
    (row) => {
      const input = findAll(row, (n) => n.nodeName === "INPUT" && props(n)?.type === ("datetime-local" as never))[0];
      return input ? String(props(input).value) : "none";
    },
  );
}

function rowInput(index: number, nodeName: "TEXTAREA" | "INPUT"): FakeNode {
  const rows = findAll(container, (n) => n.nodeName === "LI" && findAll(n, (m) => m.nodeName === "TEXTAREA").length > 0);
  return findAll(rows[index]!, (n) =>
    nodeName === "TEXTAREA" ? n.nodeName === "TEXTAREA" : n.nodeName === "INPUT" && props(n)?.type === ("datetime-local" as never),
  )[0]!;
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
  root = createRoot(container as unknown as HTMLElement);
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});

describe("Add many: rows still to send move up once drafts are made", () => {
  it("the refused third row takes the First day place the drafts gave up", async () => {
    await mountWithThreePhotos();
    const [first, second, third] = rowTimes();
    expect(new Set([first, second, third]).size).toBe(3);

    await saveAllAsDrafts();
    expect(posts).toBe(3);
    expect(rowTimes()).toEqual(["none", "none", first]);
  });

  it("with Use my posting times, the refused row takes the first free posting time", async () => {
    slots = [0, 1, 2, 3, 4, 5, 6].flatMap((day) => [
      { day, time: "09:00" },
      { day, time: "18:00" },
    ]);
    await mountWithThreePhotos();
    const box = findAll(
      container,
      (n) => n.nodeName === "INPUT" && props(n)?.type === ("checkbox" as never) && String(n.parentNode?.textContent).includes("Use my posting times"),
    )[0]!;
    await run(() => props(box).onChange({ target: { checked: true } }));
    const [first, second, third] = rowTimes();
    expect(new Set([first, second, third]).size).toBe(3);

    await saveAllAsDrafts();
    expect(rowTimes()).toEqual(["none", "none", first]);
  });

  it("a row whose time was set by hand keeps it", async () => {
    await mountWithThreePhotos();
    const byHand = "2030-06-15T10:30";
    await run(() => props(rowInput(2, "INPUT")).onChange({ target: { value: byHand } }));

    await saveAllAsDrafts();
    expect(rowTimes()).toEqual(["none", "none", byHand]);
  });
});
