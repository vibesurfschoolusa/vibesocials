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
  // A file named "huge" is refused as one over 512 MB is (R63: the refused replacement).
  return {
    ...real,
    prepareUploadFile: (file: File) =>
      file.name.includes("huge")
        ? Promise.reject(new real.PrepareFileError("file", "This file is over 512 MB, so it can't be posted."))
        : Promise.resolve(file),
  };
});
/** Every upload asked for: the key and its signal. Keys naming a `stall` entry never finish unless aborted. */
const uploads: { key: string; signal: AbortSignal | undefined }[] = [];
const stall = new Set<string>();
/** A stalled upload's finish, by key: the test lets it go. */
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
const fetchMock = vi.fn((input: unknown, init?: { method?: string }) => {
  if (String(input) === "/api/posts" && init?.method === "POST") {
    posted.push(String(input));
    return Promise.resolve(Response.json({ postJob: { id: "job-1" } }));
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
  release.clear();
  posted.length = 0;
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

  // R62 lead follow-up: the single video or photo, ensureUploaded's path.
  it("one file: removing it mid-upload aborts the upload, quietly", async () => {
    stall.add("solo");
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await pick(photo("solo"));
      expect(uploadsOf("solo")).toHaveLength(1);
      expect(uploadsOf("solo")[0]!.signal?.aborted).toBe(false);

      await pick();

      expect(uploadsOf("solo")[0]!.signal?.aborted).toBe(true);
      expect(pageSays("aborted")).toBe(false);
      expect(pageSays("Failed to prepare media")).toBe(false);
      expect(consoleError).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  }, 10_000);

  it("one file: leaving the page mid-upload aborts it, and nothing runs after", async () => {
    stall.add("video");
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await pick(new File(["v"], "video.mp4", { type: "video/mp4" }));
      expect(uploadsOf("video")).toHaveLength(1);

      await act(async () => root.unmount());
      root = createRoot(container as unknown as HTMLElement);
      await settle();

      expect(uploadsOf("video")[0]!.signal?.aborted).toBe(true);
      expect(pageSays("aborted")).toBe(false);
      expect(consoleError).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  }, 10_000);

  // R62 fix review M1/L1: a pressed Publish that waits on the upload.
  /** The page as navigation leaves it: the form goes, the toasts (ToastProvider) stay. */
  async function leaveForm() {
    await act(async () => {
      root.render(createElement(ToastProvider, null, null));
    });
    await settle();
  }
  const typeCaption = (value: string) => run(() => props(byId("post-caption")).onChange({ target: { value } }));
  async function pressPublishAndConfirm() {
    await run(() => props(byId("create-post-form")).onSubmit({ preventDefault() {} }));
    const dialog = find(body, (n) => n.attributes?.role === "dialog");
    if (!dialog) throw new Error("no Publish dialog");
    const confirm = find(
      dialog,
      (n) => n.nodeName === "BUTTON" && (n.textContent as string).trim() !== "Cancel" && (n.textContent as string).trim() !== "",
    );
    if (!confirm) throw new Error("no confirm button");
    await run(() => props(confirm).onClick());
  }
  const UNEXPECTED = "Unexpected error while creating post.";

  it("Publish pressed during the upload, then the page is left: the upload goes on and the post is sent, with no toast", async () => {
    stall.add("press");
    await typeCaption("Surf lesson today");
    await pick(new File(["v"], "press.mp4", { type: "video/mp4" }));
    await pressPublishAndConfirm();
    expect(posted).toHaveLength(0);

    await leaveForm();
    expect(uploadsOf("press")[0]!.signal?.aborted).toBe(false);
    await act(async () => release.get(uploadsOf("press")[0]!.key)!());
    await settle();

    expect(posted).toHaveLength(1);
    expect(pageSays(UNEXPECTED)).toBe(false);
    expect(pageSays("nothing was posted")).toBe(false);
  }, 10_000);

  it("the page is left with no press waiting: the upload is aborted, as before", async () => {
    stall.add("idle");
    await pick(new File(["v"], "idle.mp4", { type: "video/mp4" }));
    await leaveForm();
    expect(uploadsOf("idle")[0]!.signal?.aborted).toBe(true);
    expect(posted).toHaveLength(0);
    expect(pageSays(UNEXPECTED)).toBe(false);
  }, 10_000);

  it("the file is changed while the post sends: the press's own sentence, and nothing is posted", async () => {
    stall.add("old");
    await typeCaption("Surf lesson today");
    await pick(new File(["v"], "old.mp4", { type: "video/mp4" }));
    await pressPublishAndConfirm();
    await pick(new File(["n"], "new.mp4", { type: "video/mp4" }));

    expect(uploadsOf("old")[0]!.signal?.aborted).toBe(true);
    expect(posted).toHaveLength(0);
    expect(pageSays(UNEXPECTED)).toBe(false);
    expect(
      pageSays(
        "You changed the file while the post was sending, so nothing was posted. Press Publish post again with the new file.",
      ),
    ).toBe(true);
  }, 10_000);

  it("the file is removed while the post sends: its sentence, and nothing is posted", async () => {
    stall.add("dropped");
    await typeCaption("Surf lesson today");
    await pick(new File(["v"], "dropped.mp4", { type: "video/mp4" }));
    await pressPublishAndConfirm();
    await pick();

    expect(uploadsOf("dropped")[0]!.signal?.aborted).toBe(true);
    expect(posted).toHaveLength(0);
    expect(pageSays(UNEXPECTED)).toBe(false);
    expect(pageSays("You removed the file while the post was sending, so nothing was posted.")).toBe(true);
  }, 10_000);

  // R62 second look: the sentence reads right in Draft mode, with the button's own label.
  it("Draft mode: the file is changed while the draft saves: Press Save draft again with the new file", async () => {
    stall.add("draftold");
    await typeCaption("Surf lesson today");
    await run(() => props(buttonTexted("Save draft")).onClick());
    await pick(new File(["v"], "draftold.mp4", { type: "video/mp4" }));
    await run(() => props(byId("create-post-form")).onSubmit({ preventDefault() {} }));
    await pick(new File(["n"], "draftnew.mp4", { type: "video/mp4" }));

    expect(uploadsOf("draftold")[0]!.signal?.aborted).toBe(true);
    expect(posted).toHaveLength(0);
    expect(pageSays(UNEXPECTED)).toBe(false);
    expect(
      pageSays(
        "You changed the file while the post was sending, so nothing was posted. Press Save draft again with the new file.",
      ),
    ).toBe(true);
  }, 10_000);
});

// R63 new-customer L1, L2 and pages-b L1: every change that empties or replaces
// the media stops all its uploads, the stop is worded by what the page holds
// once the change settles, and a dropped upload's bar goes.
describe("Create: the media changed while it uploads", () => {
  const typeCaption = (value: string) => run(() => props(byId("post-caption")).onChange({ target: { value } }));
  const video = (name: string) => new File(["v"], `${name}.mp4`, { type: "video/mp4" });
  const UNEXPECTED = "Unexpected error while creating post.";
  const REMOVED = "You removed the file while the post was sending, so nothing was posted.";
  const changed = (label: string) =>
    `You changed the file while the post was sending, so nothing was posted. Press ${label} again with the new file.`;
  function tomorrowNoon(): string {
    const now = new Date(Date.now());
    const at = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 12, 0);
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T12:00`;
  }
  async function pressPublishAndConfirm() {
    await run(() => props(byId("create-post-form")).onSubmit({ preventDefault() {} }));
    const dialog = find(body, (n) => n.attributes?.role === "dialog");
    if (!dialog) throw new Error("no Publish dialog");
    const confirm = find(
      dialog,
      (n) => n.nodeName === "BUTTON" && (n.textContent as string).trim() !== "Cancel" && (n.textContent as string).trim() !== "",
    );
    if (!confirm) throw new Error("no confirm button");
    await run(() => props(confirm).onClick());
  }

  it("a one-photo set replaced by 3 new photos: the old upload is aborted and the new ones start at once", async () => {
    stall.add("keep");
    stall.add("drop");
    await pick(photo("keep"), photo("drop"));
    // Before the second photo starts, it is removed: the set is one photo, still uploading.
    await run(() => props(buttonLabelled("Remove photo 2")).onClick());
    expect(uploadsOf("keep")).toHaveLength(1);
    expect(uploadsOf("keep")[0]!.signal?.aborted).toBe(false);

    await pick(photo("n1"), photo("n2"), photo("n3"));

    expect(uploadsOf("keep")[0]!.signal?.aborted).toBe(true);
    expect(uploadsOf("n1")).toHaveLength(1);
    expect(uploadsOf("n2")).toHaveLength(1);
    expect(uploadsOf("n3")).toHaveLength(1);
    expect(pageSays("Waiting")).toBe(false);
  }, 10_000);

  it("a single video replaced by 3 photos during a pressed Schedule: the changed sentence", async () => {
    stall.add("sched");
    await typeCaption("Surf lesson today");
    await run(() => props(buttonTexted("Schedule")).onClick());
    await run(() => props(byId("post-schedule")).onChange({ target: { value: tomorrowNoon() } }));
    await pick(video("sched"));
    await run(() => props(byId("create-post-form")).onSubmit({ preventDefault() {} }));
    expect(posted).toHaveLength(0);

    await pick(photo("p1"), photo("p2"), photo("p3"));

    expect(uploadsOf("sched")[0]!.signal?.aborted).toBe(true);
    expect(posted).toHaveLength(0);
    expect(pageSays(UNEXPECTED)).toBe(false);
    expect(pageSays(REMOVED)).toBe(false);
    expect(pageSays(changed("Schedule post"))).toBe(true);
  }, 10_000);

  it("a refused replacement (over 512 MB) during a pressed send: the removed sentence", async () => {
    stall.add("before");
    await typeCaption("Surf lesson today");
    await pick(video("before"));
    await pressPublishAndConfirm();

    await pick(video("huge"));

    expect(uploadsOf("before")[0]!.signal?.aborted).toBe(true);
    expect(posted).toHaveLength(0);
    expect(pageSays(UNEXPECTED)).toBe(false);
    expect(pageSays("You changed the file")).toBe(false);
    expect(pageSays(REMOVED)).toBe(true);
  }, 10_000);

  it("a file cleared mid-upload: the bar is gone", async () => {
    stall.add("barred");
    await pick(video("barred"));
    expect(pageSays("Uploading")).toBe(true);

    await pick();

    expect(uploadsOf("barred")[0]!.signal?.aborted).toBe(true);
    expect(pageSays("Uploading")).toBe(false);
  }, 10_000);

  it("a refused replacement mid-upload: the bar is gone too", async () => {
    stall.add("barred2");
    await pick(video("barred2"));
    expect(pageSays("Uploading")).toBe(true);

    await pick(video("huge"));

    expect(pageSays("Uploading")).toBe(false);
  }, 10_000);

  it("a file replaced by another mid-upload: the new file's bar shows, not the old one's", async () => {
    stall.add("first");
    stall.add("second");
    await pick(video("first"));
    await pick(video("second"));

    expect(uploadsOf("first")[0]!.signal?.aborted).toBe(true);
    expect(uploadsOf("second")).toHaveLength(1);
    expect(pageSays("Uploading")).toBe(true);
  }, 10_000);
});
