import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * R64 pages-b L1-L3 and new-customer L1, on the mounted Create page:
 * - a pressed Schedule or Save draft waiting on its upload locks the caption,
 *   the platform captions, the platform choices and the time, so an edit is
 *   never silently dropped; the file input stays usable (R63);
 * - the success reset ends the attachment as a cleared pick does, so a file
 *   picked during the save is stopped and its caption never lands;
 * - a single pick that fails to prepare after the page was left says nothing.
 * The R62/R63 stops that must stay are tested here beside the lock.
 */

vi.mock("next/link", async () => {
  const { createElement: h } = await import("react");
  return { default: ({ href, children, ...rest }: { href: string; children: unknown }) => h("a", { href, ...rest }, children as never) };
});
vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams() }));
vi.mock("@/hooks/useConnections", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/useConnections")>()),
  useConnections: () => ({
    connections: [
      { platform: "x", connected: true },
      { platform: "linkedin", connected: true },
    ],
    loading: false,
    error: null,
    reload: () => {},
  }),
}));
/** A file named "slowfail" fails to prepare when the test lets it go. */
const prepareFail: (() => void)[] = [];
const PREPARE_FAILED = "This photo could not be read. Check your connection and add it again.";
vi.mock("@/lib/prepareUploadFile", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/prepareUploadFile")>();
  return {
    ...real,
    prepareUploadFile: (file: File) =>
      file.name.includes("slowfail")
        ? new Promise<File>((_resolve, reject) =>
            prepareFail.push(() => reject(new real.PrepareFileError("network", PREPARE_FAILED))),
          )
        : Promise.resolve(file),
  };
});
/** Every upload asked for: the key and its signal. Keys naming a `stall` entry never finish unless released. */
const uploads: { key: string; signal: AbortSignal | undefined }[] = [];
const stall = new Set<string>();
const release = new Map<string, () => void>();
vi.mock("@vercel/blob/client", () => ({
  upload: (key: string, _file: File, options: { abortSignal?: AbortSignal }) => {
    uploads.push({ key, signal: options.abortSignal });
    if (![...stall].some((name) => key.includes(name))) return Promise.resolve({ url: `https://blob.example/${key}` });
    return new Promise((resolve, reject) => {
      release.set(key, () => resolve({ url: `https://blob.example/${key}` }));
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

const posted: string[] = [];
/** The next POST /api/posts answers; empty means 201. A stalled one waits for `postRelease`. */
let postAnswer: (() => Response) | null = null;
let postStalls = false;
let postRelease: (() => void) | null = null;
const autoCaptionCalls: string[] = [];
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
  if (url.startsWith("/api/posts/auto-caption")) {
    autoCaptionCalls.push(url);
    return Promise.resolve(Response.json({ caption: "A caption about the new photo" }));
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
        ...(tag === "select" ? { options: [] } : {}),
      }),
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
  autoCaptionCalls.length = 0;
  prepareFail.length = 0;
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
const video = (name: string) => new File(["v"], `${name}.mp4`, { type: "video/mp4" });
const uploadsOf = (name: string) => uploads.filter((u) => u.key.includes(`-${name}.`));
const typeCaption = (value: string) => run(() => props(byId("post-caption")).onChange({ target: { value } }));
const captionNow = () => String(props(byId("post-caption")).value);
const UNEXPECTED = "Unexpected error while creating post.";

function tomorrowNoon(): string {
  const now = new Date(Date.now());
  const at = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 12, 0);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T12:00`;
}

function platformBox(name: string): FakeNode {
  const label = find(
    container,
    (n) => n.nodeName === "LABEL" && (n.textContent as string).trim().startsWith(name) && find(n, (c) => c.nodeName === "INPUT") !== null,
  );
  const box = label ? find(label, (n) => n.nodeName === "INPUT") : null;
  if (!box) throw new Error(`no ${name} checkbox`);
  return box;
}

/** X's "Different caption" switch. */
function xSwitch(): FakeNode {
  const hit = findAll(container, (n) => n.attributes?.role === "switch").find((n) =>
    String(n.attributes?.["aria-labelledby"] ?? "").includes("-x-"),
  );
  if (!hit) throw new Error("no X switch");
  return hit;
}

const isDisabled = (node: FakeNode) => props(node).disabled === (true as never);

async function pressSchedule() {
  await run(() => props(buttonTexted("Schedule")).onClick());
  await run(() => props(byId("post-schedule")).onChange({ target: { value: tomorrowNoon() } }));
}
const submit = () => run(() => props(byId("create-post-form")).onSubmit({ preventDefault() {} }));
async function pressPublishAndConfirm() {
  await submit();
  const dialog = find(body, (n) => n.attributes?.role === "dialog");
  if (!dialog) throw new Error("no Publish dialog");
  const confirm = find(
    dialog,
    (n) => n.nodeName === "BUTTON" && (n.textContent as string).trim() !== "Cancel" && (n.textContent as string).trim() !== "",
  );
  if (!confirm) throw new Error("no confirm button");
  await run(() => props(confirm).onClick());
}
async function leaveForm() {
  await act(async () => {
    root.render(createElement(ToastProvider, null, null));
  });
  await settle();
}

describe("Create: a pressed Schedule or Save draft waiting on its upload (R64 pages-b L1)", () => {
  it("the caption, X's caption switch and the time cannot be edited during the wait", async () => {
    stall.add("wait1");
    await typeCaption("Surf lesson today");
    await pressSchedule();
    await pick(video("wait1"));
    expect(isDisabled(byId("post-caption"))).toBe(false);
    await submit();
    expect(posted).toHaveLength(0);

    expect(isDisabled(byId("post-caption"))).toBe(true);
    expect(isDisabled(xSwitch())).toBe(true);
    expect(isDisabled(byId("post-schedule"))).toBe(true);
    // The file input stays usable (R63): changing the file stops the send.
    expect(isDisabled(byId("post-media"))).toBe(false);
  }, 10_000);

  it("a platform cannot be unticked during the wait (Save draft)", async () => {
    stall.add("wait2");
    await typeCaption("Surf lesson today");
    await run(() => props(buttonTexted("Save draft")).onClick());
    await pick(video("wait2"));
    expect(isDisabled(platformBox("LinkedIn"))).toBe(false);
    await submit();

    expect(isDisabled(platformBox("LinkedIn"))).toBe(true);
    expect(isDisabled(platformBox("X"))).toBe(true);
  }, 10_000);

  it("after a failed send everything is editable again", async () => {
    stall.add("wait3");
    postAnswer = () => Response.json({ error: "Something went wrong saving this post. Try again." }, { status: 400 });
    await typeCaption("Surf lesson today");
    await pressSchedule();
    await pick(video("wait3"));
    await submit();
    expect(isDisabled(byId("post-caption"))).toBe(true);

    await act(async () => release.get(uploadsOf("wait3")[0]!.key)!());
    await settle();

    expect(posted).toHaveLength(1);
    expect(captionNow()).toBe("Surf lesson today");
    expect(isDisabled(byId("post-caption"))).toBe(false);
    expect(isDisabled(xSwitch())).toBe(false);
    expect(isDisabled(byId("post-schedule"))).toBe(false);
    expect(isDisabled(platformBox("LinkedIn"))).toBe(false);
  }, 10_000);

  it("Publish now (its dialog): the fields behind it are as before", async () => {
    stall.add("wait4");
    await typeCaption("Surf lesson today");
    await pick(video("wait4"));
    await pressPublishAndConfirm();
    expect(posted).toHaveLength(0);

    expect(isDisabled(byId("post-caption"))).toBe(false);
    expect(isDisabled(platformBox("LinkedIn"))).toBe(false);

    await act(async () => release.get(uploadsOf("wait4")[0]!.key)!());
    await settle();
    expect(posted).toHaveLength(1);
  }, 10_000);

  // R62/R63 behaviours that stay with the lock.
  it("stays: changing the file stops the waiting Schedule with the changed sentence, and unlocks", async () => {
    stall.add("wait5");
    await typeCaption("Surf lesson today");
    await pressSchedule();
    await pick(video("wait5"));
    await submit();
    await pick(video("other5"));

    expect(uploadsOf("wait5")[0]!.signal?.aborted).toBe(true);
    expect(posted).toHaveLength(0);
    expect(pageSays(UNEXPECTED)).toBe(false);
    expect(
      pageSays(
        "You changed the file while the post was sending, so nothing was posted. Press Schedule post again with the new file.",
      ),
    ).toBe(true);
    expect(isDisabled(byId("post-caption"))).toBe(false);
  }, 10_000);

  it("stays: a pressed Publish waiting on its upload still posts after the page is left", async () => {
    stall.add("wait6");
    await typeCaption("Surf lesson today");
    await pick(video("wait6"));
    await pressPublishAndConfirm();
    await leaveForm();
    expect(uploadsOf("wait6")[0]!.signal?.aborted).toBe(false);
    await act(async () => release.get(uploadsOf("wait6")[0]!.key)!());
    await settle();

    expect(posted).toHaveLength(1);
    expect(pageSays("nothing was posted")).toBe(false);
  }, 10_000);

  it("stays: Remove all aborts quietly", async () => {
    stall.add("left7");
    stall.add("right7");
    await pick(photo("left7"), photo("right7"));
    await run(() => props(buttonTexted("Remove all")).onClick());
    const dialog = find(body, (n) => n.attributes?.role === "dialog");
    if (!dialog) throw new Error("no Remove all dialog");
    await run(() => props(buttonTexted("Remove all", dialog)).onClick());

    for (const sent of uploads) expect(sent.signal?.aborted).toBe(true);
    expect(pageSays("aborted")).toBe(false);
    expect(pageSays("didn't upload")).toBe(false);
  }, 10_000);

  it("stays: Remove aborts quietly", async () => {
    stall.add("one8");
    await pick(photo("one8"), photo("two8"));
    await run(() => props(buttonLabelled("Remove photo 1")).onClick());

    expect(uploadsOf("one8")[0]!.signal?.aborted).toBe(true);
    expect(pageSays("aborted")).toBe(false);
    expect(pageSays("didn't upload")).toBe(false);
  }, 10_000);

  it("stays: the bar clears when an upload is dropped", async () => {
    stall.add("bar9");
    await pick(video("bar9"));
    expect(pageSays("Uploading")).toBe(true);
    await pick();
    expect(pageSays("Uploading")).toBe(false);
  }, 10_000);
});

describe("Create: the success reset ends the attachment (R64 pages-b L2, new-customer L1)", () => {
  it("a file picked during the save: after the 201 the form is empty, no caption is written and its upload is stopped", async () => {
    await typeCaption("Surf lesson today");
    await run(() => props(buttonTexted("Save draft")).onClick());
    await pick(photo("sent10"));
    autoCaptionCalls.length = 0;
    postStalls = true;
    await submit();
    expect(posted).toHaveLength(1);

    // The next photo, picked while POST /api/posts runs; its upload is still going at the 201.
    stall.add("next10");
    await pick(photo("next10"));
    expect(uploadsOf("next10")).toHaveLength(1);
    await act(async () => postRelease!());
    await settle();

    expect(uploadsOf("next10")[0]!.signal?.aborted).toBe(true);
    // Were it still running, its finish would ask for a caption and write it.
    await act(async () => release.get(uploadsOf("next10")[0]!.key)?.());
    await settle();
    expect(autoCaptionCalls).toHaveLength(0);
    expect(captionNow()).toBe("");
    expect(pageSays("Uploading")).toBe(false);
    expect(pageSays(UNEXPECTED)).toBe(false);
  }, 10_000);

  it("a normal save: as before, the form is empty and the sent upload is never aborted", async () => {
    await typeCaption("Surf lesson today");
    await run(() => props(buttonTexted("Save draft")).onClick());
    await pick(photo("sent11"));
    await submit();

    expect(posted).toHaveLength(1);
    expect(captionNow()).toBe("");
    expect(uploadsOf("sent11")[0]!.signal?.aborted).toBe(false);
    expect(pageSays(UNEXPECTED)).toBe(false);
    expect(isDisabled(byId("post-caption"))).toBe(false);
  }, 10_000);
});

describe("Create: a single pick that fails to prepare (R64 pages-b L3)", () => {
  it("after the page was left: no toast", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await pick(photo("slowfail12"));
      await leaveForm();
      await act(async () => prepareFail.forEach((fail) => fail()));
      await settle();

      expect(pageSays(PREPARE_FAILED)).toBe(false);
      expect(pageSays("Failed to prepare media")).toBe(false);
    } finally {
      consoleError.mockRestore();
    }
  }, 10_000);

  it("while still on the page: the toast as before", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await pick(photo("slowfail13"));
      await act(async () => prepareFail.forEach((fail) => fail()));
      await settle();

      expect(pageSays(PREPARE_FAILED)).toBe(true);
    } finally {
      consoleError.mockRestore();
    }
  }, 10_000);
});
