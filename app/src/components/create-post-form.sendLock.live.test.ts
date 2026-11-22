import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * R64 fix review L1: a pressed Schedule waiting on its send locks every control
 * that shapes the post, not only the caption, platforms and time: the caption
 * buttons, Repeat, the Story placements, the Google box, YouTube's settings,
 * the cover, the alt text and its Write button, When to publish, and the
 * attached photos' remove, move and describe. The send ending unlocks them.
 * TikTok's settings are frozen code and stay as they are.
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
      { platform: "instagram", connected: true },
      { platform: "facebook_page", connected: true },
      { platform: "youtube", connected: true },
      { platform: "google_business_profile", connected: true },
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
/** Disabled itself, or inside a disabled fieldset (which disables every control in it). */
function locked(node: FakeNode): boolean {
  for (let at: FakeNode | null = node; at; at = at.parentNode) {
    if (at === node && isDisabled(at)) return true;
    if (at.nodeName === "FIELDSET" && isDisabled(at)) return true;
  }
  return false;
}
function labelled(label: string): FakeNode {
  const hit = find(container, (n) => n.attributes?.["aria-label"] === label);
  if (!hit) throw new Error(`no ${label}`);
  return hit;
}
function storyRadios(platform: "Instagram" | "Facebook Page"): FakeNode[] {
  const legend = find(container, (n) => n.nodeName === "LEGEND" && n.textContent === `${platform}: post to`);
  const all = legend?.parentNode ? findAll(legend.parentNode, (n) => n.nodeName === "INPUT") : [];
  if (all.length === 0) throw new Error(`no ${platform} placement`);
  return all;
}
function coverControls(): FakeNode[] {
  const group = find(container, (n) => n.attributes?.role === "radiogroup" && n.attributes?.["aria-label"] === "Video cover");
  return group ? findAll(group, (n) => n.nodeName === "INPUT") : [];
}
function googleBoxButton(): FakeNode {
  const hit = find(container, (n) => n.nodeName === "BUTTON" && n.attributes?.["aria-controls"] === "google-post-box-settings");
  if (!hit) throw new Error("no Google box button");
  return hit;
}
function whenButtons(): FakeNode[] {
  const group = find(container, (n) => n.attributes?.["aria-label"] === "When to publish" && n.attributes?.role === "group");
  if (!group) throw new Error("no When to publish group");
  return findAll(group, (n) => n.nodeName === "BUTTON");
}
const REFUSED = () => Response.json({ error: "Something went wrong saving this post. Try again." }, { status: 400 });

type Control = [string, () => FakeNode[]];
async function expectLockedThenUnlocked(controls: Control[], end: () => Promise<void>) {
  for (const [name, nodes] of controls) {
    const found = nodes();
    expect(found.length, name).toBeGreaterThan(0);
    for (const node of found) expect(locked(node), `${name} during the wait`).toBe(true);
  }
  // The file input stays usable (R63).
  if (find(container, (n) => n.attributes?.id === "post-media")) expect(locked(byId("post-media"))).toBe(false);
  await end();
  for (const [name, nodes] of controls) {
    for (const node of nodes()) expect(locked(node), `${name} after the send`).toBe(false);
  }
}

describe("Create: a waiting Schedule locks every control that shapes the post (R64 fix review L1)", () => {
  it("a video: Repeat and its count, the Story placements, YouTube's settings, the cover and When to publish", async () => {
    stall.add("vid1");
    postAnswer = REFUSED;
    await typeCaption("Surf lesson today");
    await pressSchedule();
    await run(() => props(byId("post-repeat")).onChange({ target: { value: "weekly" } }));
    await pick(video("vid1"));
    for (const id of ["post-repeat", "post-repeat-count", "youtube-privacy"]) expect(locked(byId(id)), id).toBe(false);
    await submit();
    expect(posted).toHaveLength(0);

    await expectLockedThenUnlocked(
      [
        ["Repeat", () => [byId("post-repeat")]],
        ["Repeat count", () => [byId("post-repeat-count")]],
        ["Instagram placement", () => storyRadios("Instagram")],
        ["Facebook placement", () => storyRadios("Facebook Page")],
        ["YouTube privacy", () => [byId("youtube-privacy")]],
        ["Cover", coverControls],
        ["When to publish", whenButtons],
      ],
      async () => {
        await act(async () => release.get(uploadsOf("vid1")[0]!.key)!());
        await settle();
        expect(posted).toHaveLength(1);
      },
    );
  }, 15_000);

  it("Publish now (its dialog): the controls behind it are as before", async () => {
    stall.add("vid4");
    await typeCaption("Surf lesson today");
    await pick(video("vid4"));
    await pressPublishAndConfirm();
    expect(posted).toHaveLength(0);

    for (const node of [...storyRadios("Instagram"), ...coverControls(), ...whenButtons(), byId("youtube-privacy")]) {
      expect(locked(node)).toBe(false);
    }
    await act(async () => release.get(uploadsOf("vid4")[0]!.key)!());
    await settle();
    expect(posted).toHaveLength(1);
    expect(pageSays(UNEXPECTED)).toBe(false);
    expect(captionNow()).toBe("");
  }, 15_000);

  it("a photo: Improve caption, Caption from media, the alt text and its Write button, and the Google box", async () => {
    postAnswer = REFUSED;
    await typeCaption("Surf lesson today");
    await pressSchedule();
    await pick(photo("img2"));
    autoCaptionCalls.length = 0;
    for (const node of [buttonTexted("Improve caption"), buttonTexted("Caption from media"), byId("post-alt-text")]) {
      expect(locked(node)).toBe(false);
    }
    postStalls = true;
    await submit();
    expect(posted).toHaveLength(1);
    // R65 review L1: opening or closing the box changes nothing in the post.
    expect(locked(googleBoxButton())).toBe(false);

    await expectLockedThenUnlocked(
      [
        ["Improve caption", () => [buttonTexted("Improve caption")]],
        ["Caption from media", () => [buttonTexted("Caption from media")]],
        ["Alt text", () => [byId("post-alt-text")]],
        ["Write it for me", () => [labelled("Write it for me: Describe this photo (alt text)")]],
        ["Google fields", () => [byId("google-post-type"), byId("google-button-type")]],
      ],
      async () => {
        await act(async () => postRelease!());
        await settle();
      },
    );
  }, 15_000);

  it("photos: remove, move and describe on the attached photos", async () => {
    postAnswer = REFUSED;
    await typeCaption("Surf lesson today");
    await pressSchedule();
    await pick(photo("p1"), photo("p2"));
    await settle();
    postStalls = true;
    await submit();
    expect(posted).toHaveLength(1);

    await expectLockedThenUnlocked(
      [
        ["Remove photo 1", () => [buttonLabelled("Remove photo 1")]],
        ["Remove all", () => [buttonTexted("Remove all")]],
        ["Move photo 1 later", () => [buttonLabelled("Move photo 1 later")]],
        ["Move photo 2 earlier", () => [buttonLabelled("Move photo 2 earlier")]],
        ["Describe photo 1", () => findAll(container, (n) => n.nodeName === "INPUT" && String(n.attributes?.id ?? "").startsWith("alt-photo-"))],
      ],
      async () => {
        await act(async () => postRelease!());
        await settle();
      },
    );
  }, 15_000);
});

/**
 * R66 pages-b L3: a control the lock disables looks disabled while it is (the
 * app's disabled:cursor-not-allowed disabled:opacity-50, or the label's
 * equivalent read from the lock), with no hover change. Enabled, it looks as before.
 */
describe("Create: controls the lock disables look disabled (R66 pages-b L3)", () => {
  const classesOf = (node: FakeNode) => String(node.attributes.class ?? "").split(/\s+/).filter(Boolean);
  const WHEN_BASE =
    "rounded-[calc(var(--radius)-0.125rem)] px-3 py-1.5 text-sm font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50";
  const WHEN_PRESSED = `${WHEN_BASE} bg-primary text-primary-foreground`.split(" ");
  const WHEN_OTHER = `${WHEN_BASE} text-muted-foreground enabled:hover:text-foreground`.split(" ");
  // The chip and Story label classes as they were before the lock read them.
  const LABEL_BASE = "inline-flex items-center gap-2 rounded-[var(--radius)] border px-3 py-1.5 text-sm transition-colors";
  const LABEL_CHECKED = `${LABEL_BASE} cursor-pointer border-primary/40 bg-primary/10 text-foreground`;
  const LABEL_UNCHECKED = `${LABEL_BASE} cursor-pointer border-input text-muted-foreground hover:text-foreground`;

  function chips(): FakeNode[] {
    const legend = find(container, (n) => n.nodeName === "LEGEND" && n.textContent === "Publish to");
    const all = legend?.parentNode ? findAll(legend.parentNode, (n) => n.nodeName === "LABEL") : [];
    if (all.length === 0) throw new Error("no Publish to chips");
    return all;
  }
  function chipFor(name: string): FakeNode {
    const hit = chips().find((n) => (n.textContent as string).includes(name));
    if (!hit) throw new Error(`no ${name} chip`);
    return hit;
  }
  function storyLabels(): FakeNode[] {
    const legend = find(container, (n) => n.nodeName === "LEGEND" && n.textContent === "Instagram: post to");
    const all = legend?.parentNode ? findAll(legend.parentNode, (n) => n.nodeName === "LABEL") : [];
    if (all.length === 0) throw new Error("no Instagram placement labels");
    return all;
  }
  const checkboxIn = (label: FakeNode) => find(label, (n) => n.nodeName === "INPUT")!;
  const noBareHover = (node: FakeNode) => classesOf(node).filter((c) => c.startsWith("hover:"));

  /** Schedule on a video whose upload stalls, LinkedIn unticked; the send is pressed. */
  async function waitingSchedule(name: string) {
    stall.add(name);
    postAnswer = REFUSED;
    await typeCaption("Surf lesson today");
    await run(() => props(checkboxIn(chipFor("LinkedIn"))).onChange({ target: { checked: false } }));
    await pressSchedule();
    await pick(video(name));
  }
  function expectAsNow() {
    for (const button of whenButtons()) {
      expect(isDisabled(button)).toBe(false);
      expect(classesOf(button)).toEqual(button.attributes["aria-pressed"] === "true" ? WHEN_PRESSED : WHEN_OTHER);
    }
    for (const chip of chips()) {
      expect(isDisabled(checkboxIn(chip))).toBe(false);
      const checked = props(checkboxIn(chip)).checked === (true as never);
      expect(chip.attributes.class, chip.textContent as string).toBe(checked ? LABEL_CHECKED : LABEL_UNCHECKED);
    }
    for (const label of storyLabels()) {
      expect(locked(checkboxIn(label))).toBe(false);
      const checked = props(checkboxIn(label)).checked === (true as never);
      expect(label.attributes.class, label.textContent as string).toBe(checked ? LABEL_CHECKED : LABEL_UNCHECKED);
    }
  }

  it("with no send: the classes are as now", async () => {
    await waitingSchedule("look1");
    expectAsNow();
    await act(async () => release.get(uploadsOf("look1")[0]!.key)!());
    await settle();
  }, 15_000);

  it("during a waiting Schedule each control is disabled with the disabled look; after the send, each is as now", async () => {
    await waitingSchedule("look2");
    await submit();
    expect(posted).toHaveLength(0);

    for (const button of whenButtons()) {
      expect(isDisabled(button)).toBe(true);
      expect(classesOf(button)).toEqual(expect.arrayContaining(["disabled:cursor-not-allowed", "disabled:opacity-50"]));
      expect(noBareHover(button)).toEqual([]);
    }
    for (const label of [...chips(), ...storyLabels()]) {
      expect(locked(checkboxIn(label)), label.textContent as string).toBe(true);
      expect(classesOf(label), label.textContent as string).toEqual(expect.arrayContaining(["cursor-not-allowed", "opacity-50"]));
      expect(classesOf(label)).not.toContain("cursor-pointer");
      expect(noBareHover(label)).toEqual([]);
    }
    // A ticked chip still shows it is ticked; an unticked one shows it is not.
    expect(classesOf(chipFor("X"))).toContain("bg-primary/10");
    expect(classesOf(chipFor("LinkedIn"))).not.toContain("bg-primary/10");

    await act(async () => release.get(uploadsOf("look2")[0]!.key)!());
    await settle();
    expect(posted).toHaveLength(1);
    expectAsNow();
  }, 15_000);
});
