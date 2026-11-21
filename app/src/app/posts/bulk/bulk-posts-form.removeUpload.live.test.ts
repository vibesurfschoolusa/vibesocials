import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * R62 publishing-flow-2 L1: a row removed in Add many stops its upload. Each
 * row's upload carries its own abort signal, which Remove aborts, so the next
 * row starts at once; a row removed while its file is prepared (HEIC
 * conversion, shrinking) never asks for an upload token. An aborted upload
 * ends quietly.
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

/** File names whose preparation waits until the test lets it go. */
const preparing = new Map<string, () => void>();
const holdPreparation = new Set<string>();
vi.mock("@/lib/prepareUploadFile", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/prepareUploadFile")>();
  return {
    ...actual,
    prepareUploadFile: (file: File) => {
      if (!holdPreparation.has(file.name)) return Promise.resolve(file);
      return new Promise<File>((resolve) => preparing.set(file.name, () => resolve(file)));
    },
  };
});

/** Every upload asked for: the key and its signal. Keys in `stall` never finish unless aborted. */
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
import { BulkPostsForm } from "./bulk-posts-form";

let root: Root;
let container: FakeNode;

const fetchMock = vi.fn(async (input: unknown) => {
  const url = String(input);
  if (url.startsWith("/api/posts/scheduled-times")) return Response.json({ times: [], slots: [] });
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

async function mountWith(files: File[]) {
  await act(async () => {
    root.render(createElement(ToastProvider, null, createElement(BulkPostsForm, { workspaceId: "ws-1" })));
  });
  await settle();
  await run(() => props(byId("bulk-ai-captions")).onChange({ target: { checked: false } }));
  await run(() => props(byId("bulk-files")).onChange({ target: { files } }));
}

function rows(): FakeNode[] {
  return findAll(container, (n) => n.nodeName === "LI" && findAll(n, (m) => m.nodeName === "TEXTAREA").length > 0);
}

async function removeRow(index: number) {
  const button = findAll(rows()[index]!, (n) => n.nodeName === "BUTTON" && (n.textContent as string).trim() === "Remove")[0];
  if (!button) throw new Error(`no Remove on row ${index}`);
  await run(() => props(button).onClick({ currentTarget: null }));
}

const photo = (name: string) => new File([name], `${name}.jpg`, { type: "image/jpeg" });
const uploadsOf = (name: string) => uploads.filter((u) => u.key.includes(name));

let consoleError: ReturnType<typeof vi.spyOn>;

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
  uploads.length = 0;
  stall.clear();
  preparing.clear();
  holdPreparation.clear();
  consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  root = createRoot(container as unknown as HTMLElement);
});

afterEach(async () => {
  await act(async () => root.unmount());
  consoleError.mockRestore();
  vi.unstubAllGlobals();
});

describe("Add many: a removed row stops its upload", () => {
  it("removed while uploading: the upload is aborted, quietly, and the next row starts", async () => {
    stall.add("big");
    await mountWith([photo("big"), photo("next")]);
    expect(uploadsOf("big")).toHaveLength(1);
    expect(uploadsOf("next")).toHaveLength(0);
    expect(uploadsOf("big")[0]!.signal?.aborted).toBe(false);

    await removeRow(0);

    expect(uploadsOf("big")[0]!.signal?.aborted).toBe(true);
    expect(uploadsOf("next")).toHaveLength(1);
    expect(rows()).toHaveLength(1);
    expect(container.textContent).not.toContain("upload failed");
    expect(container.textContent).not.toContain("aborted");
    expect(consoleError).not.toHaveBeenCalled();
  }, 10_000);

  it("removed while preparing: no upload token is asked for, and the next row starts", async () => {
    holdPreparation.add("slow.jpg");
    await mountWith([photo("slow"), photo("after")]);
    expect(preparing.has("slow.jpg")).toBe(true);

    await removeRow(0);
    await run(() => preparing.get("slow.jpg")!());

    expect(uploadsOf("slow")).toHaveLength(0);
    expect(uploadsOf("after")).toHaveLength(1);
    expect(rows()).toHaveLength(1);
  }, 10_000);

  it("a row that isn't removed: uploads as before, with a signal that is never aborted", async () => {
    await mountWith([photo("kept")]);
    expect(uploadsOf("kept")).toHaveLength(1);
    expect(uploadsOf("kept")[0]!.signal).toBeDefined();
    expect(uploadsOf("kept")[0]!.signal?.aborted).toBe(false);
    expect(rows()).toHaveLength(1);
    expect(container.textContent).not.toContain("Uploading");
  }, 10_000);
});
