import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * R67 publishing-flow-2 L1, on the mounted Add many page: removing a row lets
 * go of its running caption and description, as R62 did for its upload, so the
 * other rows go on at once and the late answer for the removed row writes
 * nothing. Unticking "Write captions with AI" still lets every request go (R60).
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
// Every upload asked for, by key with its signal; each waits until the test finishes it, or rejects when aborted.
const uploads = vi.hoisted(() => ({ pending: [] as (() => void)[], asked: [] as { key: string; signal?: AbortSignal }[] }));
vi.mock("@vercel/blob/client", () => ({
  upload: (key: string, _file: File, options?: { abortSignal?: AbortSignal }) =>
    new Promise((resolve, reject) => {
      uploads.asked.push({ key, signal: options?.abortSignal });
      options?.abortSignal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
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

let consoleError: ReturnType<typeof vi.spyOn>;
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
  uploads.asked.length = 0;
  frames.hold = false;
  frames.waiting.length = 0;
  duration.hold = false;
  duration.seconds = 5;
  duration.waiting.length = 0;
  connected.list = [{ platform: "x", connected: true }];
  consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  root = createRoot(container as unknown as HTMLElement);
  await act(async () => {
    root.render(createElement(ToastProvider, null, createElement(BulkPostsForm, { workspaceId: "ws-1" })));
  });
  await settle();
});

afterEach(async () => {
  await act(async () => root.unmount());
  consoleError.mockRestore();
  vi.unstubAllGlobals();
});

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
const valueOf = (id: string) => String(byId(id).value ?? byId(id).defaultValue ?? "");
const placeholderOf = (id: string) => String(props(byId(id)).placeholder ?? "");
const buttonNamed = (text: string) =>
  find(container, (n) => n.nodeName === "BUTTON" && (n.textContent as string).trim() === text);
const scheduleWaits = () => {
  const hit = buttonNamed("Schedule all");
  if (!hit) throw new Error("no Schedule all");
  return (props(hit).disabled as unknown) === true;
};
const uploadsOf = (name: string) => uploads.asked.filter((u) => u.key.includes(name));

function findAll(node: FakeNode, test: (n: FakeNode) => boolean, hits: FakeNode[] = []): FakeNode[] {
  if (test(node)) hits.push(node);
  for (const child of node.childNodes) findAll(child, test, hits);
  return hits;
}
function rows(): FakeNode[] {
  return findAll(container, (n) => n.nodeName === "LI" && findAll(n, (m) => m.nodeName === "TEXTAREA").length > 0);
}
async function removeRow(index: number) {
  const button = findAll(rows()[index]!, (n) => n.nodeName === "BUTTON" && (n.textContent as string).trim() === "Remove")[0];
  if (!button) throw new Error(`no Remove on row ${index}`);
  await run(() => props(button).onClick({ currentTarget: null }));
}

describe("Add many: a removed row lets go of its AI requests (R67 publishing-flow-2 L1)", () => {
  it("removed while Writing caption: the next row starts at once, and nothing is written or said", async () => {
    await pick(photo("first"), photo("second"));
    await finishUploads();
    expect(countOf("caption")).toBe(1);
    expect(uploadsOf("second")).toHaveLength(0);

    await removeRow(0);

    expect(signals[0]?.aborted).toBe(true);
    expect(rows()).toHaveLength(1);
    expect(uploadsOf("second")).toHaveLength(1);
    await finishUploads();
    expect(countOf("caption")).toBe(2);
    expect(find(container, (n) => n.attributes?.role === "alert")).toBeNull();
    expect(consoleError).not.toHaveBeenCalled();
    // The second row's own caption is written as before (the first entry is the removed row's, already rejected).
    sent.shift();
    await answerNext("caption", { caption: "Waves at noon" });
    expect(valueOf(idsStarting("bulk-caption-")[0]!)).toBe("Waves at noon");
  }, 10_000);

  it("removed while Writing caption: a late answer for it (a fetch that ignores its signal) writes nothing", async () => {
    late.answers = true;
    await pick(photo("first"), photo("second"));
    await finishUploads();
    await removeRow(0);
    expect(signals[0]?.aborted).toBe(true);

    await answerNext("caption", { caption: "An old answer" });

    expect(container.textContent).not.toContain("An old answer");
    expect(uploadsOf("second")).toHaveLength(1);
    await finishUploads();
    expect(countOf("caption")).toBe(2);
    expect(valueOf(idsStarting("bulk-caption-")[0]!)).toBe("");
    expect(consoleError).not.toHaveBeenCalled();
  }, 10_000);

  it("removed while its photo is described: the next row starts at once, and nothing is written or said", async () => {
    await pick(photo("first"), photo("second"));
    await finishUploads();
    await answerNext("caption", { caption: "Waves at sunrise" });
    expect(countOf("describe")).toBe(1);
    expect(uploadsOf("second")).toHaveLength(0);

    await removeRow(0);

    expect(signals[1]?.aborted).toBe(true);
    expect(rows()).toHaveLength(1);
    expect(uploadsOf("second")).toHaveLength(1);
    await finishUploads();
    expect(countOf("caption")).toBe(2);
    expect(consoleError).not.toHaveBeenCalled();
  }, 10_000);

  it("removed while its photo is described: a late description for it writes nothing", async () => {
    late.answers = true;
    await pick(photo("first"), photo("second"));
    await finishUploads();
    await answerNext("caption", { caption: "Waves at sunrise" });
    await removeRow(0);
    expect(signals[1]?.aborted).toBe(true);

    await answerNext("describe", { altText: "An old description." });

    expect(container.textContent).not.toContain("An old description.");
    await finishUploads();
    expect(countOf("caption")).toBe(2);
    expect(valueOf(idsStarting("bulk-alt-")[0]!)).toBe("");
    expect(consoleError).not.toHaveBeenCalled();
  }, 10_000);

  it("removed with no request running: the other row and its text stay as now", async () => {
    await pick(photo("first"), photo("second"));
    await finishUploads();
    await answerNext("caption", { caption: "Waves at sunrise" });
    await answerNext("describe", { altText: "A wave breaking." });
    await finishUploads();
    await answerNext("caption", { caption: "Waves at noon" });
    await answerNext("describe", { altText: "A calm sea." });

    await removeRow(0);

    expect(rows()).toHaveLength(1);
    expect(signals.every((signal) => signal?.aborted === false)).toBe(true);
    expect(valueOf(idsStarting("bulk-caption-")[0]!)).toBe("Waves at noon");
    expect(valueOf(idsStarting("bulk-alt-")[0]!)).toBe("A calm sea.");
    expect(calls).toHaveLength(4);
    expect(scheduleWaits()).toBe(false);
  }, 10_000);

  it("removed while uploading: its upload is still stopped and the next row starts (R62, as now)", async () => {
    await pick(photo("first"), photo("second"));
    expect(uploadsOf("first")).toHaveLength(1);

    await removeRow(0);

    expect(uploadsOf("first")[0]!.signal?.aborted).toBe(true);
    expect(uploadsOf("second")).toHaveLength(1);
    expect(consoleError).not.toHaveBeenCalled();
  }, 10_000);

  it('unticking "Write captions with AI" still lets the running request go (R60, as now)', async () => {
    await pick(photo("first"), photo("second"));
    await finishUploads();
    expect(scheduleWaits()).toBe(true);

    await untick();

    expect(signals[0]?.aborted).toBe(true);
    expect(placeholderOf(idsStarting("bulk-caption-")[0]!)).toBe("Write a caption");
    await finishUploads();
    expect(countOf("caption")).toBe(1);
    expect(scheduleWaits()).toBe(false);
  }, 10_000);
});
