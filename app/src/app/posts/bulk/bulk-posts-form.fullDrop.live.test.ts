import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * R56 pages-a-2 L1: a drop on a full batch (20 rows) returned before anything
 * was said, while the same drop on 19 rows showed "You can add up to 20 posts
 * at a time." A drop while posts are being created still does nothing.
 */

const mockState = vi.hoisted(() => ({ connections: [{ platform: "x", connected: true }] as { platform: string; connected: boolean }[] }));

vi.mock("next/link", async () => {
  const { createElement: h } = await import("react");
  return { default: ({ href, children, ...rest }: { href: string; children: unknown }) => h("a", { href, ...rest }, children as never) };
});
vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams(), useRouter: () => ({ push() {}, refresh() {} }) }));
vi.mock("@/hooks/useConnections", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/useConnections")>()),
  useConnections: () => ({ connections: mockState.connections, loading: false, error: null, reload: () => {} }),
}));
vi.mock("@/lib/prepareUploadFile", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/prepareUploadFile")>()),
  prepareUploadFile: (file: File) => Promise.resolve(file),
}));
vi.mock("@vercel/blob/client", () => ({
  upload: (key: string) => Promise.resolve({ url: `https://blob.example/${key}` }),
}));
vi.mock("./bulkExtras", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./bulkExtras")>()),
  readVideoDuration: () => Promise.resolve(10),
}));

import { makeDocument, type FakeNode } from "@/components/shell/fakeDom.testkit";
import { ToastProvider } from "@/components/ui/toast";
import { BulkPostsForm } from "./bulk-posts-form";

import { BULK_TOO_MANY_FILES_MESSAGE } from "@/lib/bulkPosts";

let root: Root;
let container: FakeNode;
/** The create request waits for this, so the batch stays in its sending state. */
let releasePosts: () => void = () => {};

const fetchMock = vi.fn(async (input: unknown, init?: { method?: string }) => {
  const url = String(input);
  if (url.startsWith("/api/posts/scheduled-times")) return Response.json({ times: [], slots: [] });
  if (url === "/api/posts" && init?.method === "POST") {
    await new Promise<void>((resolve) => (releasePosts = resolve));
    return Response.json({ postJob: { id: "post-1" } });
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
const photos = (n: number, prefix = "p") => Array.from({ length: n }, (_, i) => photo(`${prefix}-${i}`));
const rowItems = () => findAll(container, (n) => n.nodeName === "LI" && findAll(n, (m) => m.nodeName === "TEXTAREA").length > 0);
const tooManyShown = () => (container.textContent as string).includes(BULK_TOO_MANY_FILES_MESSAGE);

function dropArea(): FakeNode {
  const hit = findAll(container, (n) => typeof props(n)?.onDrop === "function")[0];
  if (!hit) throw new Error("no drop area");
  return hit;
}

async function drop(files: File[]) {
  await run(() =>
    props(dropArea()).onDrop({ preventDefault() {}, dataTransfer: { files } }),
  );
}

async function mountWith(n: number) {
  await act(async () => {
    root.render(createElement(ToastProvider, null, createElement(BulkPostsForm, { workspaceId: "ws-1" })));
  });
  await settle();
  await run(() => props(byId("bulk-ai-captions")).onChange({ target: { checked: false } }));
  await run(() => props(byId("bulk-files")).onChange({ target: { files: photos(n) } }));
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
  vi.stubGlobal("URL", Object.assign(Object.create(URL), URL, { createObjectURL: () => "blob:thumb", revokeObjectURL() {} }));
  Object.assign(made.doc.defaultView as object, {
    matchMedia: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }),
    location: { href: "http://localhost/posts/bulk" },
    localStorage: { getItem: () => null, setItem() {} },
  });
  root = createRoot(container as unknown as HTMLElement);
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});

describe("Add many: files dropped on the batch", () => {
  it("a drop on a full batch shows the warning and adds nothing", async () => {
    await mountWith(20);
    expect(rowItems()).toHaveLength(20);
    expect(tooManyShown()).toBe(false);
    await drop(photos(2, "late"));
    expect(rowItems()).toHaveLength(20);
    expect(tooManyShown()).toBe(true);
  }, 20_000);

  it("a drop on 19 rows: one is added and the warning shows, as now", async () => {
    await mountWith(19);
    await drop(photos(2, "late"));
    expect(rowItems()).toHaveLength(20);
    expect(tooManyShown()).toBe(true);
  }, 20_000);

  it("a drop while posts are being created does nothing, as now", async () => {
    await mountWith(1);
    const textarea = findAll(rowItems()[0]!, (n) => n.nodeName === "TEXTAREA")[0]!;
    await run(() => props(textarea).onChange({ target: { value: "Dawn patrol" } }));
    const save = findAll(container, (n) => n.nodeName === "BUTTON" && (n.textContent as string).trim() === "Save all as drafts")[0]!;
    await run(() => props(save).onClick({ currentTarget: null }));
    expect(fetchMock.mock.calls.some(([url, init]) => url === "/api/posts" && (init as { method?: string })?.method === "POST")).toBe(true);
    await drop(photos(25, "late"));
    expect(rowItems()).toHaveLength(1);
    expect(tooManyShown()).toBe(false);
    await act(async () => releasePosts());
    await settle();
  }, 20_000);
});
