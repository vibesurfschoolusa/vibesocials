import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * R38 new-customer M1 and publishing L1, on the mounted Create page:
 * - an AI answer (Improve caption, Adapt for X) writes into its box only while
 *   the box is as it was at the press and the form hasn't been saved since;
 * - "Generate a caption when media is added" is read when the automatic
 *   request is about to go out, not when the file was picked.
 */

vi.mock("next/link", async () => {
  const { createElement: h } = await import("react");
  return { default: ({ href, children, ...rest }: { href: string; children: unknown }) => h("a", { href, ...rest }, children as never) };
});
vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams() }));
vi.mock("@/hooks/useConnections", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/useConnections")>()),
  useConnections: () => ({
    connections: [{ platform: "x", connected: true }],
    loading: false,
    error: null,
    reload: () => {},
  }),
}));
// While `hold` is set, preparing a pick waits until the test releases it.
const prep = vi.hoisted(() => ({ hold: false, waiting: [] as (() => void)[] }));
vi.mock("@/lib/prepareUploadFile", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/prepareUploadFile")>()),
  prepareUploadFile: (file: File) =>
    prep.hold ? new Promise<File>((resolve) => prep.waiting.push(() => resolve(file))) : Promise.resolve(file),
}));

type Deferred = { resolve: (value: unknown) => void };
// While `frames.hold` is set, a video's frame grab waits until the test releases it.
const frames = vi.hoisted(() => ({ hold: false, waiting: [] as (() => void)[] }));
vi.mock("@/lib/extractVideoFrames", () => ({
  extractVideoFrames: () =>
    frames.hold ? new Promise<string[]>((resolve) => frames.waiting.push(() => resolve([]))) : Promise.resolve([]),
}));

const uploads = vi.hoisted(() => ({ pending: [] as { resolve: (value: unknown) => void }[] }));
vi.mock("@vercel/blob/client", () => ({
  upload: (key: string) =>
    new Promise((resolve) => {
      uploads.pending.push({ resolve: () => resolve({ url: `https://blob.example/${key}` }) });
    }),
}));

import { makeDocument, type FakeNode } from "@/components/shell/fakeDom.testkit";
import { ToastProvider } from "@/components/ui/toast";
import { CreatePostForm } from "./create-post-form";

let root: Root;
let container: FakeNode;
let body: FakeNode;
const answers: Record<string, Deferred[]> = {};
const calls: string[] = [];

const fetchMock = vi.fn((input: unknown) => {
  const url = String(input);
  calls.push(url);
  if (url === "/api/posts/enhance-caption" || url === "/api/posts/auto-caption") {
    return new Promise<Response>((resolve) => {
      (answers[url] ??= []).push({ resolve: (body) => resolve(Response.json(body)) });
    });
  }
  if (url === "/api/posts") return Promise.resolve(Response.json({ id: "job-1" }));
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

function button(text: string): FakeNode {
  const hit = find(container, (n) => n.nodeName === "BUTTON" && (n.textContent as string).trim() === text);
  if (!hit) throw new Error(`no button ${text}`);
  return hit;
}

const captionNow = () => String(byId("post-caption").value ?? "");
const xCaptionNow = () => {
  const box = find(container, (n) => n.attributes?.id === "post-platform-caption-x-caption");
  return box ? String(box.value ?? "") : null;
};

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

const typeCaption = (value: string) => run(() => props(byId("post-caption")).onChange({ target: { value } }));
const typeX = (value: string) => run(() => props(byId("post-platform-caption-x-caption")).onChange({ target: { value } }));
const press = (text: string) => run(() => props(button(text)).onClick());
const switchXOn = () =>
  run(() => props(byId("post-platform-caption-x-switch-label").parentNode!.childNodes[1]!).onClick());
const saveDraft = async () => {
  await press("Save draft");
  await run(() => props(byId("create-post-form")).onSubmit({ preventDefault() {} }));
};
const answer = (url: string, body: unknown) => run(() => answers[url]?.shift()?.resolve(body));
const finishUploads = () => run(() => uploads.pending.splice(0).forEach((u) => u.resolve(undefined)));
const autoCaptionCalls = () => calls.filter((url) => url === "/api/posts/auto-caption").length;

function autoCaptionBox(): FakeNode {
  const label = find(
    container,
    (n) => n.nodeName === "LABEL" && (n.textContent as string).includes("Generate a caption when media is added"),
  );
  const box = label && find(label, (n) => n.nodeName === "INPUT");
  if (!box) throw new Error("no auto-caption checkbox");
  return box;
}
const untickAutoCaption = () => run(() => props(autoCaptionBox()).onChange({ target: { checked: false } }));
const tickAutoCaption = () => run(() => props(autoCaptionBox()).onChange({ target: { checked: true } }));
const releasePrepare = async () => {
  prep.hold = false;
  await run(() => prep.waiting.splice(0).forEach((go) => go()));
};
const captionFromMediaBusy = () => button("Caption from media").attributes["aria-busy"] === "true";
const pick = (...files: File[]) => run(() => props(byId("post-media")).onChange({ target: { files } }));

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
  // The success banner scrolls itself into view after a save.
  const createNode = made.doc.createElement as (tag: string) => FakeNode;
  // The confirmation dialog looks for its first control and moves focus.
  Object.assign(made.doc, {
    createElement: (tag: string) =>
      Object.assign(createNode(tag), { scrollIntoView() {}, focus() {}, querySelector: () => null, querySelectorAll: () => [] }),
  });
  vi.stubGlobal("HTMLElement", class {});
  vi.stubGlobal("Node", class {});
  for (const key of Object.keys(answers)) delete answers[key];
  calls.length = 0;
  uploads.pending.length = 0;
  prep.hold = false;
  prep.waiting.length = 0;
  frames.hold = false;
  frames.waiting.length = 0;
  root = createRoot(container as unknown as HTMLElement);
  await act(async () => {
    root.render(createElement(ToastProvider, null, createElement(CreatePostForm, { workspaceId: "ws-1" })));
  });
  await settle();
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});

describe("Improve caption: a late answer", () => {
  it("a normal Improve writes the box", async () => {
    await typeCaption("Surf lesson today");
    await press("Improve caption");
    await answer("/api/posts/enhance-caption", { enhancedCaption: "Catch a wave today!" });
    expect(captionNow()).toBe("Catch a wave today!");
  });

  it("text typed while it runs is kept and the answer dropped", async () => {
    await typeCaption("Surf lesson today");
    await press("Improve caption");
    await typeCaption("Surf lesson today at 3 pm, book now");
    await answer("/api/posts/enhance-caption", { enhancedCaption: "Catch a wave today!" });
    expect(captionNow()).toBe("Surf lesson today at 3 pm, book now");
  });

  it("the post is saved while it runs: the next post's box stays empty", async () => {
    await typeCaption("Surf lesson today");
    await press("Improve caption");
    await saveDraft();
    expect(calls).toContain("/api/posts");
    expect(captionNow()).toBe("");
    await answer("/api/posts/enhance-caption", { enhancedCaption: "Catch a wave today!" });
    expect(captionNow()).toBe("");
  });
});

describe("Adapt for X on Create: a late answer", () => {
  it("a normal Adapt writes X's caption", async () => {
    await typeCaption("Hi");
    await switchXOn();
    await press("Adapt for X");
    await answer("/api/posts/enhance-caption", { enhancedCaption: "Hi from X" });
    expect(xCaptionNow()).toBe("Hi from X");
  });

  it("text typed in X's box while it runs is kept", async () => {
    await typeCaption("Hi");
    await switchXOn();
    await press("Adapt for X");
    await typeX("Hi there");
    await answer("/api/posts/enhance-caption", { enhancedCaption: "Hi from X" });
    expect(xCaptionNow()).toBe("Hi there");
  });

  it("the post is saved while it runs: the next post's X caption is untouched, even when it reads the same", async () => {
    await typeCaption("Hi");
    await switchXOn();
    await press("Adapt for X");
    await saveDraft();
    await typeCaption("Hi");
    await switchXOn();
    await answer("/api/posts/enhance-caption", { enhancedCaption: "Hi from X" });
    expect(xCaptionNow()).toBe("Hi");
  });
});

describe("Generate a caption when media is added", () => {
  const photo = () => new File(["a"], "a.jpg", { type: "image/jpeg" });

  it("ticked, a single file: the caption is asked for and lands in the empty box", async () => {
    await pick(photo());
    await finishUploads();
    expect(autoCaptionCalls()).toBe(1);
    await answer("/api/posts/auto-caption", { caption: "Waves at sunrise" });
    expect(captionNow()).toBe("Waves at sunrise");
  });

  it("unticked between the pick and the end of the upload, a single file: no call", async () => {
    await pick(photo());
    await untickAutoCaption();
    await finishUploads();
    expect(autoCaptionCalls()).toBe(0);
  });

  it("ticked, a photo set: the caption is asked for once", async () => {
    await pick(photo(), new File(["b"], "b.jpg", { type: "image/jpeg" }));
    await finishUploads();
    await finishUploads();
    expect(autoCaptionCalls()).toBe(1);
  });

  it("unticked between the pick and the end of the upload, a photo set: no call", async () => {
    await pick(photo(), new File(["b"], "b.jpg", { type: "image/jpeg" }));
    await untickAutoCaption();
    await finishUploads();
    await finishUploads();
    expect(autoCaptionCalls()).toBe(0);
  });

  describe("R38 review: the checkbox changed while the pick is still preparing", () => {
    const setOf = () => [photo(), new File(["b"], "b.jpg", { type: "image/jpeg" })];

    it("a photo set, unticked while Preparing: no call, the spinner ends, Caption from media still works", async () => {
      prep.hold = true;
      await pick(...setOf());
      await untickAutoCaption();
      await releasePrepare();
      await finishUploads();
      await finishUploads();
      expect(autoCaptionCalls()).toBe(0);
      expect(captionFromMediaBusy()).toBe(false);
      await press("Caption from media");
      expect(autoCaptionCalls()).toBe(1);
    });

    it("a single file, unticked while Preparing: no call, the spinner ends, Caption from media still works", async () => {
      prep.hold = true;
      await pick(photo());
      await untickAutoCaption();
      await releasePrepare();
      await finishUploads();
      expect(autoCaptionCalls()).toBe(0);
      expect(captionFromMediaBusy()).toBe(false);
      await press("Caption from media");
      expect(autoCaptionCalls()).toBe(1);
    });

    it("a photo set, ticked again while Preparing: the call goes", async () => {
      await untickAutoCaption();
      prep.hold = true;
      await pick(...setOf());
      await tickAutoCaption();
      await releasePrepare();
      await finishUploads();
      await finishUploads();
      expect(autoCaptionCalls()).toBe(1);
    });

    it("a single file, ticked again while Preparing: the call goes", async () => {
      await untickAutoCaption();
      prep.hold = true;
      await pick(photo());
      await tickAutoCaption();
      await releasePrepare();
      await finishUploads();
      expect(autoCaptionCalls()).toBe(1);
    });
  });
});

describe("R38 review: Improve, then a different photo", () => {
  const photoA = () => new File(["a"], "a.jpg", { type: "image/jpeg" });
  const photoB = () => new File(["b"], "b.jpg", { type: "image/jpeg" });

  it("Improve of the AI's caption for photo A: replacing A clears it and B gets its own", async () => {
    await pick(photoA());
    await finishUploads();
    await answer("/api/posts/auto-caption", { caption: "Photo A described" });
    await press("Improve caption");
    await answer("/api/posts/enhance-caption", { enhancedCaption: "Photo A, better" });
    expect(captionNow()).toBe("Photo A, better");
    await pick(photoB());
    expect(captionNow()).toBe("");
    await finishUploads();
    await answer("/api/posts/auto-caption", { caption: "Photo B described" });
    expect(captionNow()).toBe("Photo B described");
  });

  it("Improve of typed text: replacing the photo keeps it", async () => {
    await untickAutoCaption();
    await pick(photoA());
    await finishUploads();
    await typeCaption("My own words");
    await press("Improve caption");
    await answer("/api/posts/enhance-caption", { enhancedCaption: "My own words, better" });
    await pick(photoB());
    await finishUploads();
    expect(captionNow()).toBe("My own words, better");
  });
});

describe("R39 new-customer M1: nothing is posted that the person didn't see", () => {
  const AI_WAIT = "Wait until the AI caption is ready.";
  const submitButton = () => {
    const hit = find(container, (n) => n.nodeName === "BUTTON" && n.attributes?.type === "submit");
    if (!hit) throw new Error("no submit button");
    return hit;
  };
  const submitDisabled = () => (props(submitButton()).disabled as unknown) === true;
  const pageSays = (text: string) => (body.textContent as string).includes(text);
  const submit = () => run(() => props(byId("create-post-form")).onSubmit({ preventDefault() {} }));
  const dialogButton = (text: string) => {
    const dialog = find(body, (n) => n.attributes?.role === "dialog");
    const hit = dialog && find(dialog, (n) => n.nodeName === "BUTTON" && (n.textContent as string).trim() === text);
    if (!hit) throw new Error(`no dialog button ${text}`);
    return hit;
  };
  const postCalls = () => calls.filter((url) => url === "/api/posts").length;

  it("Improve running: the submit waits, and says why", async () => {
    await typeCaption("Surf lesson today");
    await press("Improve caption");
    expect(submitDisabled()).toBe(true);
    expect(pageSays(AI_WAIT)).toBe(true);
    await answer("/api/posts/enhance-caption", { enhancedCaption: "Catch a wave today!" });
    expect(submitDisabled()).toBe(false);
    expect(pageSays(AI_WAIT)).toBe(false);
  });

  it("Adapt running: the submit waits", async () => {
    await typeCaption("Hi");
    await switchXOn();
    await press("Adapt for X");
    expect(submitDisabled()).toBe(true);
    expect(pageSays(AI_WAIT)).toBe(true);
    await answer("/api/posts/enhance-caption", { enhancedCaption: "Hi from X" });
    expect(submitDisabled()).toBe(false);
  });

  it("Caption from media running: the submit waits", async () => {
    await untickAutoCaption();
    await pick(new File(["a"], "a.jpg", { type: "image/jpeg" }));
    await finishUploads();
    expect(submitDisabled()).toBe(false);
    await press("Caption from media");
    expect(submitDisabled()).toBe(true);
    expect(pageSays(AI_WAIT)).toBe(true);
    await answer("/api/posts/auto-caption", { caption: "Waves at sunrise" });
    expect(submitDisabled()).toBe(false);
  });

  it("an AI caption lands while the confirmation is open: Publish refuses and says why", async () => {
    // The button waits while Improve runs (above); the form's handler is
    // called directly here, so the dialog's own check is what is tested.
    await typeCaption("Surf lesson today, 3 pm");
    await press("Improve caption");
    await submit();
    expect((props(dialogButton("Publish without a photo")).disabled as unknown)).toBeFalsy();
    await answer("/api/posts/enhance-caption", { enhancedCaption: "Catch a wave today!" });
    expect(captionNow()).toBe("Catch a wave today!");
    expect((props(dialogButton("Publish without a photo")).disabled as unknown)).toBe(true);
    expect(pageSays("The caption changed while this was open.")).toBe(true);
    await run(() => props(dialogButton("Publish without a photo")).onClick());
    expect(postCalls()).toBe(0);
  });

  it("an Adapt answer lands while the confirmation is open: Publish refuses", async () => {
    await typeCaption("Hi");
    await switchXOn();
    await press("Adapt for X");
    await submit();
    await answer("/api/posts/enhance-caption", { enhancedCaption: "Hi from X" });
    expect(xCaptionNow()).toBe("Hi from X");
    expect((props(dialogButton("Publish without a photo")).disabled as unknown)).toBe(true);
    await run(() => props(dialogButton("Publish without a photo")).onClick());
    expect(postCalls()).toBe(0);
  });

  it("a normal publish: unchanged", async () => {
    await typeCaption("Surf lesson today");
    expect(submitDisabled()).toBe(false);
    await submit();
    expect((props(dialogButton("Publish without a photo")).disabled as unknown)).toBeFalsy();
    expect(pageSays("The caption changed while this was open.")).toBe(false);
    await run(() => props(dialogButton("Publish without a photo")).onClick());
    expect(postCalls()).toBe(1);
  });
});

describe("R39 publishing L1: the automatic caption reads the switch after the frame grab", () => {
  const video = () => new File(["v"], "v.mp4", { type: "video/mp4" });

  it("unticked during the frame grab: no call", async () => {
    frames.hold = true;
    await pick(video());
    await finishUploads();
    await untickAutoCaption();
    await run(() => frames.waiting.splice(0).forEach((go) => go()));
    expect(autoCaptionCalls()).toBe(0);
    expect(captionFromMediaBusy()).toBe(false);
  });

  it("ticked: the call goes after the frame grab", async () => {
    frames.hold = true;
    await pick(video());
    await finishUploads();
    expect(autoCaptionCalls()).toBe(0);
    await run(() => frames.waiting.splice(0).forEach((go) => go()));
    expect(autoCaptionCalls()).toBe(1);
  });
});
