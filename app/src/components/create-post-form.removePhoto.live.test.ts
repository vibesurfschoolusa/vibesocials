import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * R62 publishing-flow-2 L1, on the mounted Create page: a photo removed while
 * it uploads stops its upload (its own abort signal), quietly, and the next
 * photo of the pick starts at once instead of waiting for the removed one.
 */

vi.mock("next/link", async () => {
  const { createElement: h } = await import("react");
  return { default: ({ href, children, ...rest }: { href: string; children: unknown }) => h("a", { href, ...rest }, children as never) };
});
vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams() }));
vi.mock("@/hooks/useConnections", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/useConnections")>()),
  useConnections: () => ({ connections: [{ platform: "x", connected: true }], loading: false, error: null, reload: () => {} }),
}));
vi.mock("@/lib/prepareUploadFile", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/prepareUploadFile")>();
  return { ...real, prepareUploadFile: (file: File) => Promise.resolve(file) };
});
/** Every upload asked for: the key and its signal. Keys naming a `stall` entry never finish unless aborted. */
const uploads: { key: string; signal: AbortSignal | undefined }[] = [];
const stall = new Set<string>();
vi.mock("@vercel/blob/client", () => ({
  upload: (key: string, _file: File, options: { abortSignal?: AbortSignal }) => {
    uploads.push({ key, signal: options.abortSignal });
    if (![...stall].some((name) => key.includes(name))) return Promise.resolve({ url: `https://blob.example/${key}` });
    return new Promise((_resolve, reject) => {
      options.abortSignal?.addEventListener("abort", () => reject(new Error("The request was aborted.")));
    });
  },
}));

import { makeDocument, type FakeNode } from "@/components/shell/fakeDom.testkit";
import { ToastProvider } from "@/components/ui/toast";
import { CreatePostForm } from "./create-post-form";

let root: Root;
let container: FakeNode;
let body: FakeNode;

const fetchMock = vi.fn(() => Promise.resolve(Response.json({})));

function find(node: FakeNode, test: (n: FakeNode) => boolean): FakeNode | null {
  if (test(node)) return node;
  for (const child of node.childNodes) {
    const hit = find(child, test);
    if (hit) return hit;
  }
  return null;
}

function props(node: FakeNode): Record<string, (arg?: unknown) => unknown> {
  const key = Object.keys(node).find((k) => k.startsWith("__reactProps$"));
  return node[key as string] as Record<string, (arg?: unknown) => unknown>;
}

function byId(id: string): FakeNode {
  const hit = find(container, (n) => n.attributes?.id === id);
  if (!hit) throw new Error(`no #${id}`);
  return hit;
}

async function settle() {
  for (let i = 0; i < 5; i += 1) {
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

const pageSays = (text: string) => (body.textContent as string).includes(text);
const pick = (...files: File[]) => run(() => props(byId("post-media")).onChange({ target: { files } }));
function buttonTexted(text: string, within: FakeNode = container): FakeNode {
  const hit = find(within, (n) => n.nodeName === "BUTTON" && (n.textContent as string).trim() === text);
  if (!hit) throw new Error(`no button ${text}`);
  return hit;
}
function buttonLabelled(label: string): FakeNode {
  const hit = find(container, (n) => n.nodeName === "BUTTON" && n.attributes?.["aria-label"] === label);
  if (!hit) throw new Error(`no button ${label}`);
  return hit;
}

beforeEach(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const made = makeDocument();
  container = made.container;
  body = made.doc.body as FakeNode;
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
    location: { href: "http://localhost/posts/new" },
    setTimeout: (step: () => void, ms?: number) => setTimeout(step, ms),
    clearTimeout: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
  });
  const createNode = made.doc.createElement as (tag: string) => FakeNode;
  Object.assign(made.doc, {
    createElement: (tag: string) =>
      Object.assign(createNode(tag), {
        scrollIntoView() {},
        focus() {},
        querySelector: () => null,
        querySelectorAll: () => [],
        // Schedule mode has a <select>; React reads its options when it mounts.
        ...(tag === "select" ? { options: [] } : {}),
      }),
  });
  vi.stubGlobal("HTMLElement", class {});
  vi.stubGlobal("Node", class {});
  uploads.length = 0;
  stall.clear();
  root = createRoot(container as unknown as HTMLElement);
  await mount();
});

async function mount() {
  await act(async () => {
    root.render(createElement(ToastProvider, null, createElement(CreatePostForm, { workspaceId: "ws-1" })));
  });
  await settle();
}

afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});

const photo = (name: string) => new File([name], `${name}.jpg`, { type: "image/jpeg" });
const uploadsOf = (name: string) => uploads.filter((u) => u.key.includes(name));

describe("Create: a photo removed while it uploads", () => {
  it("the upload is aborted, quietly, and the next photo starts", async () => {
    stall.add("first");
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await pick(photo("first"), photo("second"));
      expect(uploadsOf("first")).toHaveLength(1);
      expect(uploadsOf("second")).toHaveLength(0);
      expect(uploadsOf("first")[0]!.signal?.aborted).toBe(false);

      await run(() => props(buttonLabelled("Remove photo 1")).onClick());

      expect(uploadsOf("first")[0]!.signal?.aborted).toBe(true);
      expect(uploadsOf("second")).toHaveLength(1);
      expect(pageSays("aborted")).toBe(false);
      expect(pageSays("didn't upload")).toBe(false);
      // The new cover's AI caption may log its own failure here; nothing about the upload.
      expect(consoleError.mock.calls.some((call) => /upload|abort/i.test(call.map(String).join(" ")))).toBe(false);
    } finally {
      consoleError.mockRestore();
    }
  }, 10_000);

  it("a photo that isn't removed: uploads as before, with a signal that is never aborted", async () => {
    await pick(photo("one"), photo("two"));
    expect(uploadsOf("one")).toHaveLength(1);
    expect(uploadsOf("two")).toHaveLength(1);
    for (const sent of uploads) {
      expect(sent.signal).toBeDefined();
      expect(sent.signal?.aborted).toBe(false);
    }
    expect(pageSays("didn't upload")).toBe(false);
  }, 10_000);

  // R62 lead follow-up: the same class, closed for Remove all and for leaving the page.
  it("Remove all while photos upload: every upload is aborted, and none is left running", async () => {
    stall.add("left");
    stall.add("right");
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await pick(photo("left"), photo("right"));
      expect(uploads).toHaveLength(1);

      await run(() => props(buttonTexted("Remove all")).onClick());
      const dialog = find(body, (n) => n.attributes?.role === "dialog");
      if (!dialog) throw new Error("no Remove all dialog");
      await run(() => props(buttonTexted("Remove all", dialog)).onClick());

      // The second photo either never started or was aborted too: nothing is still sending.
      expect(uploads.length).toBeGreaterThan(0);
      for (const sent of uploads) expect(sent.signal?.aborted).toBe(true);
      expect(pageSays("aborted")).toBe(false);
      expect(pageSays("didn't upload")).toBe(false);
      expect(consoleError.mock.calls.some((call) => /upload|abort/i.test(call.map(String).join(" ")))).toBe(false);
    } finally {
      consoleError.mockRestore();
    }
  }, 10_000);

  it("leaving the page mid-upload: the upload is aborted and nothing runs after", async () => {
    stall.add("gone");
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await pick(photo("gone"), photo("never"));
      expect(uploadsOf("gone")).toHaveLength(1);

      await act(async () => root.unmount());
      root = createRoot(container as unknown as HTMLElement);
      await settle();

      expect(uploadsOf("gone")[0]!.signal?.aborted).toBe(true);
      expect(uploadsOf("never")).toHaveLength(0);
      expect(consoleError).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  }, 10_000);
});
