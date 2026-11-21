import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * R55 pages-a-2 L1: with every platform unticked Schedule all and Save all as
 * drafts are disabled; Create says why ("Select at least one platform."), so
 * does Add many, and both buttons point at the line.
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

async function mountWithPhoto() {
  await act(async () => {
    root.render(createElement(ToastProvider, null, createElement(BulkPostsForm, { workspaceId: "ws-1" })));
  });
  await settle();
  await run(() => props(byId("bulk-ai-captions")).onChange({ target: { checked: false } }));
  const photo = new File(["p"], "surf.jpg", { type: "image/jpeg" });
  await run(() => props(byId("bulk-files")).onChange({ target: { files: [photo] } }));
}

const LINE = "Select at least one platform.";
const lineNode = () => findAll(container, (n) => n.textContent === LINE && n.attributes?.role === "alert")[0];
const buttonNamed = (text: string) => findAll(container, (n) => n.tagName === "BUTTON" && n.textContent === text)[0]!;
const platformBox = () =>
  findAll(container, (n) => n.tagName === "LABEL" && n.textContent === "X")[0]!.childNodes.find(
    (c) => c.tagName === "INPUT",
  )!;

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

describe("Add many: no platform ticked", () => {
  beforeEach(() => {
    mockState.connections = [{ platform: "x", connected: true }];
  });

  it("none ticked: the line shows and both buttons point at it", async () => {
    await mountWithPhoto();
    await run(() => props(platformBox()).onChange({ target: { checked: false } }));
    const line = lineNode();
    expect(line).toBeTruthy();
    expect(line!.attributes.id).toBeTruthy();
    expect(buttonNamed("Schedule all").attributes["aria-describedby"]).toBe(line!.attributes.id);
    expect(buttonNamed("Save all as drafts").attributes["aria-describedby"]).toBe(line!.attributes.id);
  }, 10_000);

  it("one ticked: no line, no pointer", async () => {
    await mountWithPhoto();
    expect(lineNode()).toBeUndefined();
    expect(container.textContent).not.toContain(LINE);
    expect(buttonNamed("Schedule all").attributes["aria-describedby"]).toBeUndefined();
  }, 10_000);

  it("no platform offered at all: no line", async () => {
    mockState.connections = [];
    await mountWithPhoto();
    expect(container.textContent).not.toContain(LINE);
  }, 10_000);
});
