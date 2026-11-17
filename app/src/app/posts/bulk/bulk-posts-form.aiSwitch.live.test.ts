import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * R39 publishing L1, on the mounted Add many page: "Write captions with AI" is
 * read right before each automatic AI request, after the local work before it
 * (a video's frame grab, the caption before a photo's description).
 */

vi.mock("next/link", async () => {
  const { createElement: h } = await import("react");
  return { default: ({ href, children, ...rest }: { href: string; children: unknown }) => h("a", { href, ...rest }, children as never) };
});
vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams(), useRouter: () => ({ push() {}, refresh() {} }) }));
vi.mock("@/hooks/useConnections", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/useConnections")>()),
  useConnections: () => ({
    connections: [{ platform: "x", connected: true }],
    loading: false,
    error: null,
    reload: () => {},
  }),
}));
vi.mock("@/lib/prepareUploadFile", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/prepareUploadFile")>()),
  prepareUploadFile: (file: File) => Promise.resolve(file),
}));
// While `frames.hold` is set, a video's frame grab waits until the test releases it.
const frames = vi.hoisted(() => ({ hold: false, waiting: [] as (() => void)[] }));
vi.mock("@/lib/extractVideoFrames", () => ({
  extractVideoFrames: () =>
    frames.hold ? new Promise<string[]>((resolve) => frames.waiting.push(() => resolve([]))) : Promise.resolve([]),
}));
vi.mock("./bulkExtras", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./bulkExtras")>()),
  readVideoDuration: () => Promise.resolve(5),
}));
const uploads = vi.hoisted(() => ({ pending: [] as (() => void)[] }));
vi.mock("@vercel/blob/client", () => ({
  upload: (key: string) =>
    new Promise((resolve) => {
      uploads.pending.push(() => resolve({ url: `https://blob.example/${key}` }));
    }),
}));

import { makeDocument, type FakeNode } from "@/components/shell/fakeDom.testkit";
import { ToastProvider } from "@/components/ui/toast";
import { BulkPostsForm } from "./bulk-posts-form";

let root: Root;
let container: FakeNode;
type Sent = { kind: "caption" | "describe"; resolve: (body: unknown) => void };
// Every AI request sent, in order, and the ones still waiting for an answer.
const calls: Sent["kind"][] = [];
const sent: Sent[] = [];

const fetchMock = vi.fn((input: unknown, init?: { body?: unknown }) => {
  const url = String(input);
  if (url === "/api/posts/auto-caption") {
    const body = JSON.parse(String(init?.body ?? "{}")) as { purpose?: string };
    const kind = body.purpose === "altText" ? "describe" : "caption";
    calls.push(kind);
    return new Promise<Response>((resolve) => {
      sent.push({ kind, resolve: (b) => resolve(Response.json(b)) });
    });
  }
  return Promise.resolve(Response.json({}));
});

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

const pick = (...files: File[]) => run(() => props(byId("bulk-files")).onChange({ target: { files } }));
const finishUploads = () => run(() => uploads.pending.splice(0).forEach((go) => go()));
const untick = () => run(() => props(byId("bulk-ai-captions")).onChange({ target: { checked: false } }));
const releaseFrames = () => run(() => frames.waiting.splice(0).forEach((go) => go()));
const answerNext = (kind: Sent["kind"], body: unknown) =>
  run(() => {
    const index = sent.findIndex((s) => s.kind === kind);
    if (index < 0) throw new Error(`no ${kind} request waiting`);
    sent.splice(index, 1)[0]!.resolve(body);
  });
const countOf = (kind: Sent["kind"]) => calls.filter((k) => k === kind).length;
const photo = (name: string) => new File([name], `${name}.jpg`, { type: "image/jpeg" });
const video = () => new File(["v"], "v.mp4", { type: "video/mp4" });

beforeEach(async () => {
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
  sent.length = 0;
  calls.length = 0;
  uploads.pending.length = 0;
  frames.hold = false;
  frames.waiting.length = 0;
  root = createRoot(container as unknown as HTMLElement);
  await act(async () => {
    root.render(createElement(ToastProvider, null, createElement(BulkPostsForm, { workspaceId: "ws-1" })));
  });
  await settle();
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});

describe("Add many: Write captions with AI is read right before each AI request", () => {
  it("ticked, a photo: its caption, then its description", async () => {
    await pick(photo("a"));
    await finishUploads();
    expect(countOf("caption")).toBe(1);
    await answerNext("caption", { caption: "Waves at sunrise" });
    expect(countOf("describe")).toBe(1);
  });

  it("unticked while a photo's caption is being written: no description and no further caption", async () => {
    await pick(photo("a"), photo("b"));
    await finishUploads();
    await finishUploads();
    expect(countOf("caption")).toBe(1);
    await untick();
    await answerNext("caption", { caption: "Waves at sunrise" });
    await finishUploads();
    expect(countOf("describe")).toBe(0);
    expect(countOf("caption")).toBe(1);
  });

  it("unticked during a video's frame grab: no caption request", async () => {
    frames.hold = true;
    await pick(video());
    await finishUploads();
    expect(frames.waiting.length).toBe(1);
    await untick();
    await releaseFrames();
    expect(countOf("caption")).toBe(0);
  });

  it("ticked, a video: the caption goes after the frame grab", async () => {
    frames.hold = true;
    await pick(video());
    await finishUploads();
    expect(countOf("caption")).toBe(0);
    await releaseFrames();
    expect(countOf("caption")).toBe(1);
  });
});
