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
import { BULK_CAPTION_LOST_TEXT } from "./bulkExtras";

let root: Root;
let container: FakeNode;
type Sent = { kind: "caption" | "describe"; resolve: (body: unknown) => void };
// Every AI request sent, in order, and the ones still waiting for an answer.
const calls: Sent["kind"][] = [];
const sent: Sent[] = [];

// Each AI request's signal, in order, to see it aborted when let go.
const signals: (AbortSignal | undefined)[] = [];

const fetchMock = vi.fn((input: unknown, init?: { body?: unknown; signal?: AbortSignal }) => {
  const url = String(input);
  if (url === "/api/posts/auto-caption") {
    const body = JSON.parse(String(init?.body ?? "{}")) as { purpose?: string };
    const kind = body.purpose === "altText" ? "describe" : "caption";
    calls.push(kind);
    signals.push(init?.signal);
    // As a browser's fetch: an aborted signal rejects it.
    return new Promise<Response>((resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
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
  signals.length = 0;
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

describe("R40 publishing L2: nothing is sent for a row that is gone", () => {
  const removeButton = () => {
    const hit = find(container, (n) => n.nodeName === "BUTTON" && (n.textContent as string).trim() === "Remove");
    if (!hit) throw new Error("no Remove button");
    return hit;
  };

  it("a video row removed during its frame grab: no caption request", async () => {
    frames.hold = true;
    await pick(video());
    await finishUploads();
    expect(frames.waiting.length).toBe(1);
    await run(() => props(removeButton()).onClick());
    expect(find(container, (n) => n.nodeName === "BUTTON" && (n.textContent as string).trim() === "Remove")).toBeNull();
    await releaseFrames();
    expect(countOf("caption")).toBe(0);
  });
});

describe("R41: Add many asks nothing for a box the person has typed in, and typing ends the row's wait", () => {
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
  const captionBoxes = () => idsStarting("bulk-caption-");
  const altBoxes = () => idsStarting("bulk-alt-");
  const typeInto = (id: string, value: string) => run(() => props(byId(id)).onChange({ target: { value } }));
  const valueOf = (id: string) => String(byId(id).value ?? byId(id).defaultValue ?? "");
  const scheduleAll = () => {
    const hit = find(container, (n) => n.nodeName === "BUTTON" && (n.textContent as string).trim() === "Schedule all");
    if (!hit) throw new Error("no Schedule all");
    return hit;
  };
  const scheduleWaits = () => (props(scheduleAll()).disabled as unknown) === true;

  it("a row whose caption and description were typed before its turn: no caption and no description request", async () => {
    await pick(photo("a"), photo("b"));
    const [, captionB] = captionBoxes();
    const [, altB] = altBoxes();
    await typeInto(captionB!, "Our own words for b");
    await typeInto(altB!, "Board waxing on the sand");
    await finishUploads();
    await answerNext("caption", { caption: "Waves at sunrise" });
    await answerNext("describe", { altText: "A wave." });
    await finishUploads();
    expect(countOf("caption")).toBe(1);
    expect(countOf("describe")).toBe(1);
    expect(valueOf(captionB!)).toBe("Our own words for b");
    expect(valueOf(altB!)).toBe("Board waxing on the sand");
    expect(scheduleWaits()).toBe(false);
  });

  it("typing in the caption during its call: the wait ends, the fetch is aborted, the text stays", async () => {
    await pick(video());
    await finishUploads();
    expect(countOf("caption")).toBe(1);
    expect(scheduleWaits()).toBe(true);
    const [captionBox] = captionBoxes();
    await typeInto(captionBox!, "My own caption");
    expect(signals[0]?.aborted).toBe(true);
    expect(scheduleWaits()).toBe(false);
    expect(valueOf(captionBox!)).toBe("My own caption");
    expect((container.textContent as string).includes(BULK_CAPTION_LOST_TEXT)).toBe(false);
  });

  it("typing in the description during its automatic call: the wait ends and the typed text stays", async () => {
    await pick(photo("a"));
    await finishUploads();
    await answerNext("caption", { caption: "Waves at sunrise" });
    expect(countOf("describe")).toBe(1);
    expect(scheduleWaits()).toBe(true);
    const [altBox] = altBoxes();
    await typeInto(altBox!, "Board waxing on the sand");
    expect(signals[1]?.aborted).toBe(true);
    expect(scheduleWaits()).toBe(false);
    expect(valueOf(altBox!)).toBe("Board waxing on the sand");
  });

  it("empty rows are unchanged: the caption and the description land", async () => {
    await pick(photo("a"));
    await finishUploads();
    await answerNext("caption", { caption: "Waves at sunrise" });
    await answerNext("describe", { altText: "A wave breaking." });
    const [captionBox] = captionBoxes();
    const [altBox] = altBoxes();
    expect(valueOf(captionBox!)).toBe("Waves at sunrise");
    expect(valueOf(altBox!)).toBe("A wave breaking.");
    expect(scheduleWaits()).toBe(false);
  });

  it("a Media photo's Write it for me: typing ends the wait, and the typed text stays", async () => {
    await act(async () => root.unmount());
    root = createRoot(container as unknown as HTMLElement);
    const item = {
      id: "m1",
      storageLocation: "https://blob.example/m1.jpg",
      originalFilename: "m1.jpg",
      mimeType: "image/jpeg",
      sizeBytes: 10,
      baseCaption: "",
      perPlatformOverrides: null,
      createdAt: "2026-11-01T00:00:00.000Z",
      lastUsedAt: null,
    };
    await act(async () => {
      root.render(
        createElement(
          ToastProvider,
          null,
          createElement(BulkPostsForm, { workspaceId: "ws-1", initialMedia: [item as never] }),
        ),
      );
    });
    await settle();
    await answerNext("caption", { caption: "Waves at sunrise" });
    expect(scheduleWaits()).toBe(false);
    const write = find(container, (n) => n.nodeName === "BUTTON" && (n.textContent as string).trim() === "Write it for me");
    if (!write) throw new Error("no Write it for me");
    await run(() => props(write).onClick());
    expect(countOf("describe")).toBe(1);
    expect(scheduleWaits()).toBe(true);
    const [altBox] = altBoxes();
    await typeInto(altBox!, "Board waxing on the sand");
    expect(signals[signals.length - 1]?.aborted).toBe(true);
    expect(scheduleWaits()).toBe(false);
    expect(valueOf(altBox!)).toBe("Board waxing on the sand");
  });
});
