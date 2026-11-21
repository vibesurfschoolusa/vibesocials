import { readFileSync } from "node:fs";
import path from "node:path";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * R65, on the mounted Create page, while a Schedule waits on its send:
 * - "Use a different file instead" is locked like every other control that
 *   shapes the post (publishing-flow L1, new-customer L2);
 * - focus in a control the lock disables moves to the submit button, which
 *   keeps it through the send (new-customer L1, pages-b L1).
 */

vi.mock("next/link", async () => {
  const { createElement: h } = await import("react");
  return { default: ({ href, children, ...rest }: { href: string; children: unknown }) => h("a", { href, ...rest }, children as never) };
});
/** The page's query: `mediaItemId` opens Create on a Media item (reuse). */
const query = vi.hoisted(() => ({ search: "" }));
vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams(query.search) }));
vi.mock("@/hooks/useConnections", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/useConnections")>()),
  useConnections: () => ({
    connections: [
      { platform: "x", connected: true },
      { platform: "linkedin", connected: true },
      { platform: "google_business_profile", connected: true },
    ],
    loading: false,
    error: null,
    reload: () => {},
  }),
}));
vi.mock("@/lib/prepareUploadFile", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/prepareUploadFile")>()),
  prepareUploadFile: (file: File) => Promise.resolve(file),
}));
/** Every upload asked for. Keys naming a `stall` entry never finish unless released. */
const uploads: { key: string }[] = [];
const stall = new Set<string>();
const release = new Map<string, () => void>();
vi.mock("@vercel/blob/client", () => ({
  upload: (key: string, _file: File, options: { abortSignal?: AbortSignal }) => {
    uploads.push({ key });
    if (![...stall].some((name) => key.includes(name))) return Promise.resolve({ url: `https://blob.example/${key}` });
    return new Promise((resolve, reject) => {
      release.set(key, () => resolve({ url: `https://blob.example/${key}` }));
      options?.abortSignal?.addEventListener("abort", () => reject(new Error("The request was aborted.")));
    });
  },
}));

import { makeDocument, type FakeNode } from "@/components/shell/fakeDom.testkit";
import { ToastProvider } from "@/components/ui/toast";
import { CreatePostForm, SendLock } from "./create-post-form";

let root: Root;
let container: FakeNode;
let body: FakeNode;
let doc: Record<string, unknown>;

const REUSED_VIDEO = {
  id: "item-1",
  storageLocation: "https://blob.example/media/ws-1/item-1.mp4",
  originalFilename: "lesson.mp4",
  mimeType: "video/mp4",
  sizeBytes: 1000,
  baseCaption: "",
  perPlatformOverrides: null,
  createdAt: "2026-11-01T00:00:00.000Z",
  lastUsedAt: null,
};

const posted: string[] = [];
let postAnswer: (() => Response) | null = null;
let postStalls = false;
let postRelease: (() => void) | null = null;
const fetchMock = vi.fn((input: unknown, init?: { method?: string }) => {
  const url = String(input);
  if (url === "/api/posts" && init?.method === "POST") {
    posted.push(url);
    const answer = postAnswer ?? (() => Response.json({ postJob: { id: "job-1" } }, { status: 201 }));
    if (!postStalls) return Promise.resolve(answer());
    return new Promise<Response>((resolve) => {
      postRelease = () => resolve(answer());
    });
  }
  if (url.startsWith("/api/media/item-1")) return Promise.resolve(Response.json({ item: REUSED_VIDEO }));
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

function buttonTexted(text: string): FakeNode {
  const hit = find(container, (n) => n.nodeName === "BUTTON" && (n.textContent as string).trim() === text);
  if (!hit) throw new Error(`no button ${text}`);
  return hit;
}
const hasButton = (text: string) =>
  find(container, (n) => n.nodeName === "BUTTON" && (n.textContent as string).trim() === text) !== null;

/** As a browser: `disabled` on the control, or on a fieldset it sits in. */
function disabledNow(node: FakeNode): boolean {
  if ("disabled" in node.attributes) return true;
  for (let at = node.parentNode; at; at = at.parentNode) {
    if (at.nodeName === "FIELDSET" && "disabled" in at.attributes) return true;
  }
  return false;
}

beforeEach(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const made = makeDocument();
  container = made.container;
  doc = made.doc;
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
  // Focus as a browser keeps it: focus() moves document.activeElement, and
  // matches(":disabled") reads the control and the fieldsets around it.
  const createNode = made.doc.createElement as (tag: string) => FakeNode;
  Object.assign(made.doc, {
    createElement: (tag: string) => {
      const node: FakeNode = Object.assign(createNode(tag), {
        scrollIntoView() {},
        focus() {
          if (!disabledNow(node)) doc.activeElement = node;
        },
        matches: (selector: string) => selector === ":disabled" && disabledNow(node),
        querySelector: () => null,
        querySelectorAll: () => [],
        ...(tag === "select" ? { options: [] } : {}),
      });
      return node;
    },
  });
  vi.stubGlobal("HTMLElement", class {});
  vi.stubGlobal("Node", class {});
  uploads.length = 0;
  stall.clear();
  release.clear();
  posted.length = 0;
  postAnswer = null;
  postStalls = false;
  postRelease = null;
  query.search = "";
  root = createRoot(container as unknown as HTMLElement);
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
const typeCaption = (value: string) => run(() => props(byId("post-caption")).onChange({ target: { value } }));
const pick = (...files: File[]) => run(() => props(byId("post-media")).onChange({ target: { files } }));
const submit = () => run(() => props(byId("create-post-form")).onSubmit({ preventDefault() {} }));
const REFUSED = () => Response.json({ error: "Something went wrong saving this post. Try again." }, { status: 400 });
const DIFFERENT_FILE = "Use a different file instead";

function tomorrowNoon(): string {
  const now = new Date(Date.now());
  const at = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 12, 0);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T12:00`;
}
async function pressSchedule() {
  await run(() => props(buttonTexted("Schedule")).onClick());
  await run(() => props(byId("post-schedule")).onChange({ target: { value: tomorrowNoon() } }));
}

/** Create opened on the Media video, with an uploaded cover image chosen; the cover's upload stalls. */
async function reuseWithUploadedCover() {
  query.search = "mediaItemId=item-1";
  await mount();
  await typeCaption("Surf lesson today");
  await pressSchedule();
  const uploadRadio = find(container, (n) => n.nodeName === "INPUT" && props(n)?.value === ("upload" as never));
  if (!uploadRadio) throw new Error("no Upload a cover image choice");
  await run(() => props(uploadRadio).onChange());
  await run(() => props(byId("video-cover-file")).onChange({ target: { files: [photo("cover")] } }));
  stall.add("covers/");
}
const releaseCover = async () => {
  const cover = uploads.find((u) => u.key.startsWith("covers/"));
  if (!cover) throw new Error("no cover upload");
  await act(async () => release.get(cover.key)!());
  await settle();
};

describe('Create: "Use a different file instead" during a waiting send (R65 publishing-flow L1)', () => {
  it("a reuse send waiting on its cover upload: the button is disabled", async () => {
    await reuseWithUploadedCover();
    await submit();
    expect(uploads.some((u) => u.key.startsWith("covers/"))).toBe(true);
    expect(posted).toHaveLength(0);

    expect(disabledNow(buttonTexted(DIFFERENT_FILE))).toBe(true);
    await releaseCover();
  }, 10_000);

  it("after a failed send: it is enabled, and dismisses the item", async () => {
    postAnswer = REFUSED;
    await reuseWithUploadedCover();
    await submit();
    expect(disabledNow(buttonTexted(DIFFERENT_FILE))).toBe(true);
    await releaseCover();
    expect(posted).toHaveLength(1);

    expect(disabledNow(buttonTexted(DIFFERENT_FILE))).toBe(false);
    await run(() => props(buttonTexted(DIFFERENT_FILE)).onClick());
    expect(hasButton(DIFFERENT_FILE)).toBe(false);
    expect(find(container, (n) => n.attributes?.id === "post-media")).not.toBeNull();
  }, 10_000);

  it("after a successful send: the form is reset, the item is gone and nothing is left locked", async () => {
    await reuseWithUploadedCover();
    await submit();
    await releaseCover();
    expect(posted).toHaveLength(1);

    expect(hasButton(DIFFERENT_FILE)).toBe(false);
    expect(disabledNow(byId("post-caption"))).toBe(false);
    expect(disabledNow(byId("post-media"))).toBe(false);
  }, 10_000);

  it("with no send: it works as now", async () => {
    query.search = "mediaItemId=item-1";
    await mount();
    expect(disabledNow(buttonTexted(DIFFERENT_FILE))).toBe(false);
    await run(() => props(buttonTexted(DIFFERENT_FILE)).onClick());
    expect(hasButton(DIFFERENT_FILE)).toBe(false);
    expect(find(container, (n) => n.attributes?.id === "post-media")).not.toBeNull();
  }, 10_000);
});

describe("SendLock takes its one child's place (R65 publishing-flow L2)", () => {
  async function renderLock(child: unknown) {
    await act(async () => {
      root.render(createElement(SendLock, { locked: false }, child as never));
    });
  }

  it("with a child: a block fieldset with min-w-0, not contents, wrapping exactly that child", async () => {
    await renderLock(createElement("div", { className: "space-y-2" }, "Cover"));
    expect(container.childNodes).toHaveLength(1);
    const fieldset = container.childNodes[0]!;
    expect(fieldset.nodeName).toBe("FIELDSET");
    const classes = String(fieldset.attributes.class ?? "").split(/\s+/);
    expect(classes).toContain("min-w-0");
    expect(classes).not.toContain("contents");
    // The parent's space-y gap is a margin on the fieldset (zero specificity in
    // Tailwind v4), so the fieldset sets no margin of its own.
    expect(classes.filter((name) => /^-?m[trblxyse]?-/.test(name))).toEqual([]);
    expect(fieldset.childNodes).toHaveLength(1);
    expect(fieldset.childNodes[0]!.nodeName).toBe("DIV");
    expect(fieldset.childNodes[0]!.attributes.class).toBe("space-y-2");
  });

  it("with null or false: renders nothing", async () => {
    await renderLock(null);
    expect(container.childNodes).toHaveLength(0);
    await renderLock(false);
    expect(container.childNodes).toHaveLength(0);
  });

  it("every SendLock in create-post-form.tsx wraps one element", () => {
    const source = readFileSync(path.join(__dirname, "create-post-form.tsx"), "utf8");
    const uses = [...source.matchAll(/<SendLock locked=\{sendLocksFields\}>([^]*?)<\/SendLock>/g)].map((m) => m[1]!.trim());
    expect(uses.length).toBeGreaterThanOrEqual(7);
    for (const inner of uses) {
      // One expression, or one self-closing component with no element in its props.
      expect(/^\{\w+\}$/.test(inner) || /^<[A-Z]\w*[^<]*\/>$/.test(inner), inner).toBe(true);
    }
    expect(source.match(/<SendLock/g)?.length).toBe(uses.length);
  });

  it("on the page: a photo leaves no empty fieldset for the missing cover", async () => {
    await mount();
    await pick(photo("still"));
    expect(findAll(container, (n) => n.nodeName === "FIELDSET" && n.childNodes.length === 0)).toEqual([]);
  }, 10_000);

  it("on the page: the lock still disables what it wraps during a waiting send, and enables it after", async () => {
    postAnswer = REFUSED;
    await mount();
    await typeCaption("Surf lesson today");
    await pressSchedule();
    await pick(photo("img"));
    const googleBox = () => {
      const hit = find(container, (n) => n.nodeName === "BUTTON" && n.attributes?.["aria-controls"] === "google-post-box-settings");
      if (!hit) throw new Error("no Google box button");
      return hit;
    };
    expect(disabledNow(googleBox())).toBe(false);
    expect(disabledNow(byId("post-alt-text"))).toBe(false);
    postStalls = true;
    await submit();
    expect(posted).toHaveLength(1);

    expect(disabledNow(googleBox())).toBe(true);
    expect(disabledNow(byId("post-alt-text"))).toBe(true);
    await act(async () => postRelease!());
    await settle();
    expect(disabledNow(googleBox())).toBe(false);
    expect(disabledNow(byId("post-alt-text"))).toBe(false);
  }, 10_000);
});

void body;
