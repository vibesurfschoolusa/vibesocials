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
// While `frames.fail` is set, the grab throws: an unexpected failure the caption handler catches.
const frames = vi.hoisted(() => ({ hold: false, fail: false, waiting: [] as (() => void)[] }));
vi.mock("@/lib/extractVideoFrames", () => ({
  extractVideoFrames: () =>
    frames.fail
      ? Promise.reject(new Error("unexpected"))
      : frames.hold
        ? new Promise<string[]>((resolve) => frames.waiting.push(() => resolve([])))
        : Promise.resolve([]),
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
import { CAPTION_FAILED_MESSAGE, CAPTION_OFFLINE_MESSAGE } from "@/lib/captionRequest";
import { AI_REQUEST_TIMEOUT_MS } from "./composer/useCaptionBox";
import { automaticCaptionRefusedText, captionsChangedMessage, CreatePostForm } from "./create-post-form";

let root: Root;
let container: FakeNode;
let body: FakeNode;
const answers: Record<string, Deferred[]> = {};
const calls: string[] = [];
// Each AI request's signal, in order, to see it aborted when let go.
const signals: AbortSignal[] = [];

const fetchMock = vi.fn((input: unknown, init?: { signal?: AbortSignal }) => {
  const url = String(input);
  calls.push(url);
  if (url === "/api/posts/enhance-caption" || url === "/api/posts/auto-caption") {
    if (init?.signal) signals.push(init.signal);
    // As a browser's fetch: an aborted signal rejects it.
    return new Promise<Response>((resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      (answers[url] ??= []).push({ resolve: (body) => resolve(body instanceof Response ? body : Response.json(body)) });
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
  // A textarea React has only mounted holds its text as defaultValue in the fake DOM.
  return box ? String(box.value ?? box.defaultValue ?? "") : null;
};

async function settle() {
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(0);
      else await new Promise((resolve) => setTimeout(resolve, 0));
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
  signals.length = 0;
  uploads.pending.length = 0;
  prep.hold = false;
  prep.waiting.length = 0;
  frames.hold = false;
  frames.fail = false;
  frames.waiting.length = 0;
  root = createRoot(container as unknown as HTMLElement);
  await act(async () => {
    root.render(createElement(ToastProvider, null, createElement(CreatePostForm, { workspaceId: "ws-1" })));
  });
  await settle();
});

afterEach(async () => {
  vi.useRealTimers();
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
    expect(pageSays(captionsChangedMessage("now"))).toBe(true);
    expect(pageSays("then publish again.")).toBe(true);
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

describe("R39 lead review: the AI wait ends with its request", () => {
  const AI_WAIT = "Wait until the AI caption is ready.";
  const submitButton = () => {
    const hit = find(container, (n) => n.nodeName === "BUTTON" && n.attributes?.type === "submit");
    if (!hit) throw new Error("no submit button");
    return hit;
  };
  const submitDisabled = () => (props(submitButton()).disabled as unknown) === true;
  const pageSays = (text: string) => (body.textContent as string).includes(text);
  const video = () => new File(["v"], "v.mp4", { type: "video/mp4" });
  const photo = () => new File(["a"], "a.jpg", { type: "image/jpeg" });

  it("a video removed during its frame grab: the wait ends at once and nothing is sent", async () => {
    frames.hold = true;
    await pick(video());
    await finishUploads();
    expect(submitDisabled()).toBe(true);
    await pick();
    expect(submitDisabled()).toBe(false);
    expect(pageSays(AI_WAIT)).toBe(false);
    await run(() => frames.waiting.splice(0).forEach((go) => go()));
    expect(autoCaptionCalls()).toBe(0);
  });

  it("unticked during the automatic caption's call: the wait ends at once and its answer is dropped", async () => {
    await pick(photo());
    await finishUploads();
    expect(autoCaptionCalls()).toBe(1);
    expect(submitDisabled()).toBe(true);
    await untickAutoCaption();
    expect(submitDisabled()).toBe(false);
    expect(pageSays(AI_WAIT)).toBe(false);
    await answer("/api/posts/auto-caption", { caption: "Waves at sunrise" });
    expect(captionNow()).toBe("");
  });

  it("a manual Caption from media is not stopped by unticking", async () => {
    await untickAutoCaption();
    await pick(photo());
    await finishUploads();
    await tickAutoCaption();
    await press("Caption from media");
    await untickAutoCaption();
    expect(submitDisabled()).toBe(true);
    await answer("/api/posts/auto-caption", { caption: "Waves at sunrise" });
    expect(captionNow()).toBe("Waves at sunrise");
    expect(submitDisabled()).toBe(false);
  });

  it("an Improve that never answers runs out of time: the wait ends and it says so", async () => {
    await typeCaption("Surf lesson today");
    vi.useFakeTimers();
    await press("Improve caption");
    expect(submitDisabled()).toBe(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(AI_REQUEST_TIMEOUT_MS);
    });
    await settle();
    expect(submitDisabled()).toBe(false);
    expect(pageSays(CAPTION_OFFLINE_MESSAGE)).toBe(true);
    expect(captionNow()).toBe("Surf lesson today");
  });

  it("a Caption from media that never answers runs out of time: the wait ends", async () => {
    await untickAutoCaption();
    await pick(photo());
    await finishUploads();
    vi.useFakeTimers();
    await press("Caption from media");
    expect(submitDisabled()).toBe(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(AI_REQUEST_TIMEOUT_MS);
    });
    await settle();
    expect(submitDisabled()).toBe(false);
    expect(captionFromMediaBusy()).toBe(false);
  });

  it("an Adapt that never answers runs out of time: the wait ends", async () => {
    await typeCaption("Hi");
    await switchXOn();
    vi.useFakeTimers();
    await press("Adapt for X");
    expect(submitDisabled()).toBe(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(AI_REQUEST_TIMEOUT_MS);
    });
    await settle();
    expect(submitDisabled()).toBe(false);
  });

  it("the confirmation's refusal names what it confirms: publish or schedule", () => {
    expect(captionsChangedMessage("now")).toBe(
      "The caption changed while this was open. Press Cancel, read the caption, then publish again.",
    );
    expect(captionsChangedMessage("schedule")).toBe(
      "The caption changed while this was open. Press Cancel, read the caption, then schedule again.",
    );
  });
});

describe("R40: a wait is held only while its answer can still apply", () => {
  const AI_WAIT = "Wait until the AI caption is ready.";
  const submitButton = () => {
    const hit = find(container, (n) => n.nodeName === "BUTTON" && n.attributes?.type === "submit");
    if (!hit) throw new Error("no submit button");
    return hit;
  };
  const submitDisabled = () => (props(submitButton()).disabled as unknown) === true;
  const pageSays = (text: string) => (body.textContent as string).includes(text);
  const photo = () => new File(["a"], "a.jpg", { type: "image/jpeg" });
  const video = () => new File(["v"], "v.mp4", { type: "video/mp4" });

  it("a caption typed, then a photo picked: no request, and the submit stays enabled", async () => {
    await typeCaption("Surf lesson today, 3 pm");
    await pick(photo());
    await finishUploads();
    expect(autoCaptionCalls()).toBe(0);
    expect(submitDisabled()).toBe(false);
    expect(pageSays(AI_WAIT)).toBe(false);
    expect(captionNow()).toBe("Surf lesson today, 3 pm");
  });

  it("a caption typed, then a video picked: no frame grab, no request, the submit stays enabled", async () => {
    frames.hold = true;
    await typeCaption("Sunset session tonight");
    await pick(video());
    await finishUploads();
    expect(frames.waiting.length).toBe(0);
    expect(autoCaptionCalls()).toBe(0);
    expect(submitDisabled()).toBe(false);
  });

  it("a caption typed, then a photo set picked: no request, and the submit stays enabled", async () => {
    await typeCaption("Surf lesson today, 3 pm");
    await pick(photo(), new File(["b"], "b.jpg", { type: "image/jpeg" }));
    await finishUploads();
    await finishUploads();
    expect(autoCaptionCalls()).toBe(0);
    expect(submitDisabled()).toBe(false);
    expect(captionFromMediaBusy()).toBe(false);
  });

  it("typing during an automatic caption: the wait ends at once, the fetch is aborted, the text is kept", async () => {
    await pick(photo());
    await finishUploads();
    expect(autoCaptionCalls()).toBe(1);
    expect(submitDisabled()).toBe(true);
    await typeCaption("My own words");
    expect(submitDisabled()).toBe(false);
    expect(pageSays(AI_WAIT)).toBe(false);
    expect(signals[0]?.aborted).toBe(true);
    await answer("/api/posts/auto-caption", { caption: "Waves at sunrise" });
    expect(captionNow()).toBe("My own words");
  });

  it("typing during a video's frame grab: the wait ends and nothing is sent", async () => {
    frames.hold = true;
    await pick(video());
    await finishUploads();
    expect(submitDisabled()).toBe(true);
    await typeCaption("Sunset session tonight");
    expect(submitDisabled()).toBe(false);
    await run(() => frames.waiting.splice(0).forEach((go) => go()));
    expect(autoCaptionCalls()).toBe(0);
  });

  it("typing during Improve: the wait ends at once and the fetch is aborted", async () => {
    await typeCaption("Surf lesson today");
    await press("Improve caption");
    expect(submitDisabled()).toBe(true);
    await typeCaption("Surf lesson today at 3 pm");
    expect(submitDisabled()).toBe(false);
    expect(pageSays(AI_WAIT)).toBe(false);
    expect(signals[0]?.aborted).toBe(true);
    expect(captionNow()).toBe("Surf lesson today at 3 pm");
  });

  it("typing during a manual Caption from media: the wait ends", async () => {
    await untickAutoCaption();
    await pick(photo());
    await finishUploads();
    await typeCaption("Hi");
    await press("Caption from media");
    expect(submitDisabled()).toBe(true);
    await typeCaption("Hi there");
    expect(submitDisabled()).toBe(false);
    await answer("/api/posts/auto-caption", { caption: "Waves at sunrise" });
    expect(captionNow()).toBe("Hi there");
  });

  it("an unchanged box still waits, and the answer is written", async () => {
    await pick(photo());
    await finishUploads();
    expect(submitDisabled()).toBe(true);
    await answer("/api/posts/auto-caption", { caption: "Waves at sunrise" });
    expect(captionNow()).toBe("Waves at sunrise");
    expect(submitDisabled()).toBe(false);
    await press("Improve caption");
    expect(submitDisabled()).toBe(true);
    await answer("/api/posts/enhance-caption", { enhancedCaption: "Catch a wave at sunrise!" });
    expect(captionNow()).toBe("Catch a wave at sunrise!");
    expect(submitDisabled()).toBe(false);
  });
});

describe("R40 publishing L3: Write it for me counts as AI writing into the post", () => {
  const submitButton = () => {
    const hit = find(container, (n) => n.nodeName === "BUTTON" && n.attributes?.type === "submit");
    if (!hit) throw new Error("no submit button");
    return hit;
  };
  const submitDisabled = () => (props(submitButton()).disabled as unknown) === true;
  const pageSays = (text: string) => (body.textContent as string).includes(text);
  const submit = () => run(() => props(byId("create-post-form")).onSubmit({ preventDefault() {} }));
  const dialogConfirm = () => {
    const dialog = find(body, (n) => n.attributes?.role === "dialog");
    if (!dialog) throw new Error("no dialog");
    const buttons: FakeNode[] = [];
    const walk = (n: FakeNode) => {
      if (n.nodeName === "BUTTON") buttons.push(n);
      n.childNodes.forEach(walk);
    };
    walk(dialog);
    const hit = buttons.find((b) => (b.textContent as string).trim() !== "Cancel");
    if (!hit) throw new Error("no confirm button");
    return hit;
  };
  const postCalls = () => calls.filter((url) => url === "/api/posts").length;
  const descriptionNow = () => String(byId("post-alt-text").value ?? "");
  const photoReady = async () => {
    await untickAutoCaption();
    await pick(new File(["a"], "a.jpg", { type: "image/jpeg" }));
    await finishUploads();
    await typeCaption("Surf lesson today");
  };

  it("Write it for me running: the submit waits, then the description is written", async () => {
    await photoReady();
    expect(submitDisabled()).toBe(false);
    await press("Write it for me");
    expect(submitDisabled()).toBe(true);
    await answer("/api/posts/auto-caption", { altText: "A surfer on a wave." });
    expect(descriptionNow()).toBe("A surfer on a wave.");
    expect(submitDisabled()).toBe(false);
  });

  it("a description arrives while the confirmation is open: Publish refuses and says why", async () => {
    await photoReady();
    await press("Write it for me");
    await submit();
    expect(props(dialogConfirm()).disabled as unknown).toBeFalsy();
    await answer("/api/posts/auto-caption", { altText: "A surfer on a wave." });
    expect(descriptionNow()).toBe("A surfer on a wave.");
    expect(props(dialogConfirm()).disabled as unknown).toBe(true);
    expect(pageSays(captionsChangedMessage("now", "description"))).toBe(true);
    await run(() => props(dialogConfirm()).onClick());
    expect(postCalls()).toBe(0);
  });

  it("a normal publish with a written description: unchanged", async () => {
    await photoReady();
    await press("Write it for me");
    await answer("/api/posts/auto-caption", { altText: "A surfer on a wave." });
    await submit();
    expect(props(dialogConfirm()).disabled as unknown).toBeFalsy();
    expect(pageSays("changed while this was open")).toBe(false);
    await run(() => props(dialogConfirm()).onClick());
    expect(postCalls()).toBe(1);
  });

  it("the description refusal names what it confirms", () => {
    expect(captionsChangedMessage("now", "description")).toBe(
      "A photo description changed while this was open. Press Cancel, read the descriptions, then publish again.",
    );
    expect(captionsChangedMessage("schedule", "description")).toBe(
      "A photo description changed while this was open. Press Cancel, read the descriptions, then schedule again.",
    );
  });
});

describe("R40 lead review: the wait names what is being written, and a photo's description ends with the photo", () => {
  const CAPTION_WAIT = "Wait until the AI caption is ready.";
  const DESCRIPTION_WAIT = "Wait until the photo description is ready.";
  const BOTH_WAIT = "Wait until the AI has finished writing.";
  const submitButton = () => {
    const hit = find(container, (n) => n.nodeName === "BUTTON" && n.attributes?.type === "submit");
    if (!hit) throw new Error("no submit button");
    return hit;
  };
  const submitDisabled = () => (props(submitButton()).disabled as unknown) === true;
  const pageSays = (text: string) => (body.textContent as string).includes(text);
  const photo = (name: string) => new File([name], `${name}.jpg`, { type: "image/jpeg" });
  const allButtons = (text: string) => {
    const hits: FakeNode[] = [];
    const walk = (n: FakeNode) => {
      if (n.nodeName === "BUTTON" && (n.textContent as string).trim() === text) hits.push(n);
      n.childNodes.forEach(walk);
    };
    walk(container);
    return hits;
  };
  const labelled = (label: string) => {
    const hit = find(container, (n) => n.attributes?.["aria-label"] === label);
    if (!hit) throw new Error(`no ${label}`);
    return hit;
  };
  const describedAs = (id: string) => String(byId(id).value ?? "");

  it("Write it for me running: the wait names the photo description", async () => {
    await untickAutoCaption();
    await pick(photo("a"));
    await finishUploads();
    await press("Write it for me");
    expect(pageSays(DESCRIPTION_WAIT)).toBe(true);
    expect(pageSays(CAPTION_WAIT)).toBe(false);
    await answer("/api/posts/auto-caption", { altText: "A surfer on a wave." });
    expect(pageSays(DESCRIPTION_WAIT)).toBe(false);
  });

  it("a caption request running: the wait names the caption", async () => {
    await typeCaption("Surf lesson today");
    await press("Improve caption");
    expect(pageSays(CAPTION_WAIT)).toBe(true);
    expect(pageSays(DESCRIPTION_WAIT)).toBe(false);
  });

  it("both running: one neutral sentence, then the one still running", async () => {
    await untickAutoCaption();
    await pick(photo("a"));
    await finishUploads();
    await typeCaption("Surf lesson today");
    await press("Write it for me");
    await press("Improve caption");
    expect(pageSays(BOTH_WAIT)).toBe(true);
    expect(pageSays(CAPTION_WAIT)).toBe(false);
    expect(pageSays(DESCRIPTION_WAIT)).toBe(false);
    await answer("/api/posts/enhance-caption", { enhancedCaption: "Catch a wave today!" });
    expect(pageSays(DESCRIPTION_WAIT)).toBe(true);
    expect(pageSays(BOTH_WAIT)).toBe(false);
  });

  it("the single photo removed during its Write it for me: the wait ends at once and the fetch is aborted", async () => {
    await untickAutoCaption();
    await pick(photo("a"));
    await finishUploads();
    await press("Write it for me");
    expect(submitDisabled()).toBe(true);
    await pick();
    expect(submitDisabled()).toBe(false);
    expect(pageSays(DESCRIPTION_WAIT)).toBe(false);
    expect(signals[0]?.aborted).toBe(true);
  });

  it("a set photo removed during its Write it for me: only its wait ends; the other photo's stays and lands", async () => {
    await untickAutoCaption();
    await pick(photo("a"), photo("b"));
    await finishUploads();
    await finishUploads();
    const [first, second] = allButtons("Write it for me");
    await run(() => props(first!).onClick());
    await run(() => props(second!).onClick());
    expect(signals.length).toBe(2);
    await run(() => props(labelled("Remove photo 1")).onClick());
    expect(signals[0]?.aborted).toBe(true);
    expect(signals[1]?.aborted).toBe(false);
    expect(submitDisabled()).toBe(true);
    expect(pageSays(DESCRIPTION_WAIT)).toBe(true);
    // The second request's answer is the one still waiting.
    await run(() => answers["/api/posts/auto-caption"]?.pop()?.resolve({ altText: "Photo b, described." }));
    expect(submitDisabled()).toBe(false);
    const field = find(container, (n) => n.nodeName === "INPUT" && String(n.attributes?.id ?? "").startsWith("alt-"));
    expect(field && describedAs(String(field.attributes.id))).toBe("Photo b, described.");
  });
});

describe("R40 review: Adapt and a cover move hold the wait only while their answer can apply", () => {
  const submitButton = () => {
    const hit = find(container, (n) => n.nodeName === "BUTTON" && n.attributes?.type === "submit");
    if (!hit) throw new Error("no submit button");
    return hit;
  };
  const submitDisabled = () => (props(submitButton()).disabled as unknown) === true;
  const pageSays = (text: string) => (body.textContent as string).includes(text);
  const labelled = (label: string) => {
    const hit = find(container, (n) => n.attributes?.["aria-label"] === label);
    if (!hit) throw new Error(`no ${label}`);
    return hit;
  };
  const photo = (name: string) => new File([name], `${name}.jpg`, { type: "image/jpeg" });

  it("Adapt from an empty X box, then the main caption edited: the wait ends at once and the fetch is aborted", async () => {
    await typeCaption("Hi");
    await switchXOn();
    await typeX("");
    await press("Adapt for X");
    expect(submitDisabled()).toBe(true);
    await typeCaption("Hi there");
    expect(submitDisabled()).toBe(false);
    expect(signals[0]?.aborted).toBe(true);
    expect(xCaptionNow()).toBe("");
  });

  it("Adapt of X's own text, then X edited: the wait ends at once and the fetch is aborted", async () => {
    await typeCaption("Hi");
    await switchXOn();
    await press("Adapt for X");
    expect(submitDisabled()).toBe(true);
    await typeX("Hi you");
    expect(submitDisabled()).toBe(false);
    expect(signals[0]?.aborted).toBe(true);
    expect(xCaptionNow()).toBe("Hi you");
  });

  it("Adapt of X's own text, then the main caption edited: its source is unchanged, so it still waits and writes", async () => {
    await typeCaption("Hi");
    await switchXOn();
    await press("Adapt for X");
    await typeCaption("Hi there");
    expect(submitDisabled()).toBe(true);
    expect(signals[0]?.aborted).toBe(false);
    await answer("/api/posts/enhance-caption", { enhancedCaption: "Hi from X" });
    expect(xCaptionNow()).toBe("Hi from X");
    expect(submitDisabled()).toBe(false);
  });

  it("Adapt with an unchanged source still waits and writes", async () => {
    await typeCaption("Hi");
    await switchXOn();
    await typeX("");
    await press("Adapt for X");
    expect(submitDisabled()).toBe(true);
    await answer("/api/posts/enhance-caption", { enhancedCaption: "Hi from X" });
    expect(xCaptionNow()).toBe("Hi from X");
    expect(submitDisabled()).toBe(false);
  });

  it("another photo moved to the front during the set's caption: the wait ends at once; a description of a photo that stays keeps waiting", async () => {
    await pick(photo("a"), photo("b"));
    await finishUploads();
    await finishUploads();
    expect(autoCaptionCalls()).toBe(1);
    // Photo 2's description, asked while the caption runs. (No focus move: the press has no element here.)
    const writeButtons: FakeNode[] = [];
    const walk = (n: FakeNode) => {
      if (n.nodeName === "BUTTON" && (n.textContent as string).trim() === "Write it for me") writeButtons.push(n);
      n.childNodes.forEach(walk);
    };
    walk(container);
    await run(() => props(writeButtons[1]!).onClick());
    expect(pageSays("Wait until the AI has finished writing.")).toBe(true);
    await run(() => { const node = labelled("Move photo 2 earlier"); return props(node).onClick({ currentTarget: null }); });
    expect(signals[0]?.aborted).toBe(true);
    expect(signals[1]?.aborted).toBe(false);
    expect(pageSays("Wait until the photo description is ready.")).toBe(true);
    await run(() => answers["/api/posts/auto-caption"]?.pop()?.resolve({ altText: "Photo b, described." }));
    expect(submitDisabled()).toBe(false);
    expect(captionNow()).toBe("");
  });

  it("a move that keeps the same cover changes nothing: the caption still waits and lands", async () => {
    await pick(photo("a"), photo("b"), photo("c"));
    await finishUploads();
    await finishUploads();
    await finishUploads();
    expect(autoCaptionCalls()).toBe(1);
    expect(submitDisabled()).toBe(true);
    await run(() => { const node = labelled("Move photo 3 earlier"); return props(node).onClick({ currentTarget: null }); });
    expect(submitDisabled()).toBe(true);
    expect(signals[0]?.aborted).toBe(false);
    await answer("/api/posts/auto-caption", { caption: "Waves at sunrise" });
    expect(captionNow()).toBe("Waves at sunrise");
    expect(submitDisabled()).toBe(false);
  });
});

describe("R41 L1: Write it for me keeps a description typed while it runs", () => {
  const DESCRIPTION_WAIT = "Wait until the photo description is ready.";
  const submitButton = () => {
    const hit = find(container, (n) => n.nodeName === "BUTTON" && n.attributes?.type === "submit");
    if (!hit) throw new Error("no submit button");
    return hit;
  };
  const submitDisabled = () => (props(submitButton()).disabled as unknown) === true;
  const pageSays = (text: string) => (body.textContent as string).includes(text);
  const photo = (name: string) => new File([name], `${name}.jpg`, { type: "image/jpeg" });
  const valueOf = (id: string) => String(byId(id).value ?? "");
  const typeInto = (id: string, value: string) => run(() => props(byId(id)).onChange({ target: { value } }));
  const setFields = () => {
    const hits: FakeNode[] = [];
    const walk = (n: FakeNode) => {
      if (n.nodeName === "INPUT" && String(n.attributes?.id ?? "").startsWith("alt-")) hits.push(n);
      n.childNodes.forEach(walk);
    };
    walk(container);
    return hits.map((n) => String(n.attributes.id));
  };
  const allButtons = (text: string) => {
    const hits: FakeNode[] = [];
    const walk = (n: FakeNode) => {
      if (n.nodeName === "BUTTON" && (n.textContent as string).trim() === text) hits.push(n);
      n.childNodes.forEach(walk);
    };
    walk(container);
    return hits;
  };

  it("the single photo: typing ends the wait at once, aborts the fetch, and the typed text stays", async () => {
    await untickAutoCaption();
    await pick(photo("a"));
    await finishUploads();
    await typeCaption("Surf lesson today");
    await press("Write it for me");
    expect(submitDisabled()).toBe(true);
    await typeInto("post-alt-text", "Our surf crew at Dania Beach");
    expect(submitDisabled()).toBe(false);
    expect(pageSays(DESCRIPTION_WAIT)).toBe(false);
    expect(signals[0]?.aborted).toBe(true);
    await answer("/api/posts/auto-caption", { altText: "A surfer on a wave." });
    expect(valueOf("post-alt-text")).toBe("Our surf crew at Dania Beach");
  });

  it("a set photo: typing in its field ends only its wait, and the typed text stays", async () => {
    await untickAutoCaption();
    await pick(photo("a"), photo("b"));
    await finishUploads();
    await finishUploads();
    const [first, second] = allButtons("Write it for me");
    await run(() => props(first!).onClick());
    await run(() => props(second!).onClick());
    const [firstField, secondField] = setFields();
    await typeInto(firstField!, "Two surfers paddling out at the pier");
    expect(signals[0]?.aborted).toBe(true);
    expect(signals[1]?.aborted).toBe(false);
    expect(pageSays(DESCRIPTION_WAIT)).toBe(true);
    await run(() => answers["/api/posts/auto-caption"]?.pop()?.resolve({ altText: "Photo b, described." }));
    expect(pageSays(DESCRIPTION_WAIT)).toBe(false);
    expect(valueOf(firstField!)).toBe("Two surfers paddling out at the pier");
    expect(valueOf(secondField!)).toBe("Photo b, described.");
  });

  it("an untouched field still waits, and the answer is written", async () => {
    await untickAutoCaption();
    await pick(photo("a"));
    await finishUploads();
    await press("Write it for me");
    expect(pageSays(DESCRIPTION_WAIT)).toBe(true);
    await answer("/api/posts/auto-caption", { altText: "A surfer on a wave." });
    expect(valueOf("post-alt-text")).toBe("A surfer on a wave.");
    expect(pageSays(DESCRIPTION_WAIT)).toBe(false);
  });
});

// R43 new-customer L4: the caption written when a file is added got the
// route's bare "Too many tries…", which didn't say the caption wasn't written.
describe("the automatic caption's refusal says no caption was written", () => {
  const pageSays = (text: string) => (body.textContent as string).includes(text);
  const photo = () => new File(["a"], "a.jpg", { type: "image/jpeg" });
  const tooMany = () =>
    Response.json(
      { error: "Too many tries. Wait 4 minutes, then try again.", retryAfterSeconds: 230 },
      { status: 429, headers: { "Retry-After": "230" } },
    );

  it("automatic: the toast starts with No caption was written", async () => {
    await pick(photo());
    await finishUploads();
    expect(autoCaptionCalls()).toBe(1);
    await answer("/api/posts/auto-caption", tooMany());
    expect(pageSays("No caption was written: too many tries. Wait 4 minutes, then try again.")).toBe(true);
    expect(captionNow()).toBe("");
  });

  it("a pressed Caption from media keeps the route's own words", async () => {
    await untickAutoCaption();
    await pick(photo());
    await finishUploads();
    await press("Caption from media");
    await answer("/api/posts/auto-caption", tooMany());
    expect(pageSays("Too many tries. Wait 4 minutes, then try again.")).toBe(true);
    expect(pageSays("No caption was written")).toBe(false);
  });

  // R44 new-customer L2: every failure of the automatic request, not only a 429.
  const busy = () =>
    Response.json({ error: "We couldn't check that just now. Nothing was changed. Try again in a minute." }, { status: 503 });
  const slow = () => Response.json({ error: "The AI service took too long. Try again." }, { status: 504 });

  it("automatic: a 503 starts with No caption was written", async () => {
    await pick(photo());
    await finishUploads();
    await answer("/api/posts/auto-caption", busy());
    expect(pageSays("No caption was written: we couldn't check that just now. Nothing was changed. Try again in a minute.")).toBe(true);
  });

  it("automatic: a 504 starts with No caption was written", async () => {
    await pick(photo());
    await finishUploads();
    await answer("/api/posts/auto-caption", slow());
    expect(pageSays("No caption was written: the AI service took too long. Try again.")).toBe(true);
  });

  // R44 lead review: an unexpected throw in the handler is a failure of the automatic request too.
  const video = () => new File(["v"], "v.mp4", { type: "video/mp4" });

  it("automatic: a throw in the handler starts with No caption was written", async () => {
    frames.fail = true;
    await pick(video());
    await finishUploads();
    expect(pageSays(automaticCaptionRefusedText(CAPTION_FAILED_MESSAGE))).toBe(true);
  });

  it("a pressed Caption from media whose handler throws keeps the plain sentence", async () => {
    frames.fail = true;
    await untickAutoCaption();
    await pick(video());
    await finishUploads();
    await press("Caption from media");
    expect(pageSays(CAPTION_FAILED_MESSAGE)).toBe(true);
    expect(pageSays("No caption was written")).toBe(false);
  });

  it("a pressed Caption from media keeps the 504's own words", async () => {
    await untickAutoCaption();
    await pick(photo());
    await finishUploads();
    await press("Caption from media");
    await answer("/api/posts/auto-caption", slow());
    expect(pageSays("The AI service took too long. Try again.")).toBe(true);
    expect(pageSays("No caption was written")).toBe(false);
  });
});
