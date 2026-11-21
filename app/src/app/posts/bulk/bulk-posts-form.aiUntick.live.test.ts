import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * R60 publishing-flow-2 L1, on the mounted Add many page: unticking "Write
 * captions with AI" lets go every row's running caption and description at
 * once, as Create does, so no AI answer lands after the switch is off.
 */

vi.mock("next/link", async () => {
  const { createElement: h } = await import("react");
  return { default: ({ href, children, ...rest }: { href: string; children: unknown }) => h("a", { href, ...rest }, children as never) };
});
vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams(), useRouter: () => ({ push() {}, refresh() {} }) }));
// The connected platforms; a test may add one before it mounts the page again.
const connected = vi.hoisted(() => ({ list: [{ platform: "x", connected: true }] }));
vi.mock("@/hooks/useConnections", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/useConnections")>()),
  useConnections: () => ({
    connections: connected.list,
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
// While `duration.hold` is set, reading a video's length waits until the test releases it.
const duration = vi.hoisted(() => ({ hold: false, seconds: 5, waiting: [] as (() => void)[] }));
vi.mock("./bulkExtras", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./bulkExtras")>()),
  readVideoDuration: () =>
    duration.hold
      ? new Promise<number>((resolve) => duration.waiting.push(() => resolve(duration.seconds)))
      : Promise.resolve(duration.seconds),
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

// Each AI request's signal, in order, to see it aborted when let go.
const signals: (AbortSignal | undefined)[] = [];
// Set: a request's answer still arrives after it was let go (a fetch that ignores its signal).
const late = { answers: false };

const fetchMock = vi.fn((input: unknown, init?: { body?: unknown; signal?: AbortSignal }) => {
  const url = String(input);
  if (url === "/api/posts/auto-caption") {
    const body = JSON.parse(String(init?.body ?? "{}")) as { purpose?: string };
    const kind = body.purpose === "altText" ? "describe" : "caption";
    calls.push(kind);
    signals.push(init?.signal);
    // As a browser's fetch: an aborted signal rejects it.
    return new Promise<Response>((resolve, reject) => {
      if (!late.answers) init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
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
const answerNext = (kind: Sent["kind"], body: unknown) =>
  run(() => {
    const index = sent.findIndex((s) => s.kind === kind);
    if (index < 0) throw new Error(`no ${kind} request waiting`);
    sent.splice(index, 1)[0]!.resolve(body);
  });
const countOf = (kind: Sent["kind"]) => calls.filter((k) => k === kind).length;
const photo = (name: string) => new File([name], `${name}.jpg`, { type: "image/jpeg" });

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
  signals.length = 0;
  late.answers = false;
  uploads.pending.length = 0;
  frames.hold = false;
  frames.waiting.length = 0;
  duration.hold = false;
  duration.seconds = 5;
  duration.waiting.length = 0;
  connected.list = [{ platform: "x", connected: true }];
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

const tick = () => run(() => props(byId("bulk-ai-captions")).onChange({ target: { checked: true } }));
const idsStarting = (prefix: string) => {
  const hits: string[] = [];
  const walk = (n: FakeNode) => {
    const id = String(n.attributes?.id ?? "");
    if (id.startsWith(prefix)) hits.push(id);
    n.childNodes.forEach(walk);
  };
  walk(container);
  return hits;
};
const captionBox = () => idsStarting("bulk-caption-")[0]!;
const altBox = () => idsStarting("bulk-alt-")[0]!;
const valueOf = (id: string) => String(byId(id).value ?? byId(id).defaultValue ?? "");
const placeholderOf = (id: string) => String(props(byId(id)).placeholder ?? "");
const buttonNamed = (text: string) =>
  find(container, (n) => n.nodeName === "BUTTON" && (n.textContent as string).trim() === text);
const scheduleWaits = () => {
  const hit = buttonNamed("Schedule all");
  if (!hit) throw new Error("no Schedule all");
  return (props(hit).disabled as unknown) === true;
};

describe("Add many: unticking AI captions lets go of the running caption and description", () => {
  it("untick during a caption call: the call is let go, the box stays empty and Schedule all comes back", async () => {
    await pick(photo("a"));
    await finishUploads();
    expect(countOf("caption")).toBe(1);
    expect(scheduleWaits()).toBe(true);
    await untick();
    expect(signals[0]?.aborted).toBe(true);
    expect(valueOf(captionBox())).toBe("");
    expect(placeholderOf(captionBox())).toBe("Write a caption");
    expect(scheduleWaits()).toBe(false);
    expect(countOf("describe")).toBe(0);
  });

  it("untick during a description call: the call is let go, the field stays empty and the wait ends", async () => {
    await pick(photo("a"));
    await finishUploads();
    await answerNext("caption", { caption: "Waves at sunrise" });
    expect(countOf("describe")).toBe(1);
    expect(placeholderOf(altBox())).toBe("Writing a description...");
    expect(scheduleWaits()).toBe(true);
    await untick();
    expect(signals[1]?.aborted).toBe(true);
    expect(valueOf(altBox())).toBe("");
    expect(placeholderOf(altBox())).toBe("What the photo shows, for screen readers");
    expect(scheduleWaits()).toBe(false);
    expect(buttonNamed("Improve caption")).not.toBeNull();
  });

  it("untick with nothing running: what was written stays, as now", async () => {
    await pick(photo("a"));
    await finishUploads();
    await answerNext("caption", { caption: "Waves at sunrise" });
    await answerNext("describe", { altText: "A wave breaking." });
    await untick();
    expect(signals.every((signal) => signal?.aborted === false)).toBe(true);
    expect(valueOf(captionBox())).toBe("Waves at sunrise");
    expect(valueOf(altBox())).toBe("A wave breaking.");
    expect(scheduleWaits()).toBe(false);
  });

  it("ticking again: an answer that arrives late for the let-go call is not written", async () => {
    late.answers = true;
    await pick(photo("a"));
    await finishUploads();
    await untick();
    await tick();
    await answerNext("caption", { caption: "An old answer" });
    expect(valueOf(captionBox())).toBe("");
    expect(scheduleWaits()).toBe(false);
    expect(buttonNamed("Write again")).not.toBeNull();
  });
});
