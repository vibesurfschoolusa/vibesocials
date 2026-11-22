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
      { platform: "instagram", connected: true },
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
import { CreatePostForm } from "./create-post-form";

let root: Root;
let container: FakeNode;
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
        querySelector: (selector: string) =>
          selector === 'button[type="submit"]'
            ? find(node, (n) => n !== node && n.nodeName === "BUTTON" && n.attributes?.type === "submit")
            : null,
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

  it("looks disabled when it is (R65 review L2)", async () => {
    query.search = "mediaItemId=item-1";
    await mount();
    const classes = String(buttonTexted(DIFFERENT_FILE).attributes.class).split(/\s+/);
    expect(classes).toEqual(expect.arrayContaining(["disabled:cursor-not-allowed", "disabled:opacity-50"]));
  }, 10_000);

  it("a waiting send locks the cover on the reused video, and focus in it moves to the submit button", async () => {
    postAnswer = REFUSED;
    await reuseWithUploadedCover();
    const radio = find(container, (n) => n.nodeName === "INPUT" && props(n)?.value === ("upload" as never));
    if (!radio) throw new Error("no cover choice");
    await act(async () => (radio.focus as () => void)());
    expect(doc.activeElement).toBe(radio);
    await submit();
    expect(disabledNow(radio)).toBe(true);

    const focused = doc.activeElement as FakeNode;
    expect(focused.nodeName).toBe("BUTTON");
    expect(focused.attributes.type).toBe("submit");
    await releaseCover();
    expect(disabledNow(radio)).toBe(false);
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

describe("Create adds nothing around its parts (R65 publishing-flow L2, review L1)", () => {
  it("R65 review L1: the cover, alt text, YouTube and Story parts take disabled={sendLocksFields} and sit where they sat at 0071194, with nothing around them", () => {
    const source = readFileSync(path.join(__dirname, "create-post-form.tsx"), "utf8");
    const count = (re: RegExp) => source.match(re)?.length ?? 0;
    // At 0071194 the cover was {coverPicker} straight after the preview, before the file line.
    expect(count(/\) : null\}\s*\{coverPicker\}\s*<p className="text-xs text-muted-foreground">/g)).toBe(2);
    expect(source).toMatch(/const coverPicker = coverVideo \? \(\s*<VideoCoverPicker[^<]*?disabled=\{sendLocksFields\}[^<]*?\/>\s*\) : null;/);
    expect(count(/&& \(\s*<PhotoDescriptionField[^<]*?disabled=\{sendLocksFields\}[^<]*?\/>\s*\)\}/g)).toBe(2);
    expect(count(/&& \(\s*<YouTubePostSettings[^<]*?disabled=\{sendLocksFields\}[^<]*?\/>\s*\)\}/g)).toBe(1);
    expect(count(/&& \(\s*<StoryPlacementSettings[^<]*?disabled=\{sendLocksFields\}[^<]*?\/>\s*\)\}/g)).toBe(2);
    expect(count(/&& \(\s*<GooglePostBox[^<]*?disabled=\{sendLocksFields\}[^<]*?\/>\s*\)\}/g)).toBe(1);
  });

  it("create-post-form.tsx has no SendLock, and only the one fieldset it had at 0071194", () => {
    const source = readFileSync(path.join(__dirname, "create-post-form.tsx"), "utf8");
    expect(source).not.toContain("SendLock");
    expect(source.match(/<fieldset/g)?.length).toBe(1);
  });

  it("on the page: the Google box opens and closes while a send waits, and its fields are locked", async () => {
    postAnswer = REFUSED;
    await mount();
    await typeCaption("Surf lesson today");
    await pressSchedule();
    await pick(photo("gbox"));
    const summary = () => {
      const hit = find(container, (n) => n.nodeName === "BUTTON" && n.attributes?.["aria-controls"] === "google-post-box-settings");
      if (!hit) throw new Error("no Google box button");
      return hit;
    };
    expect(summary().attributes["aria-expanded"]).toBe("false");
    postStalls = true;
    await submit();
    expect(posted).toHaveLength(1);

    expect(disabledNow(summary())).toBe(false);
    expect(disabledNow(byId("google-post-type"))).toBe(true);
    await run(() => props(summary()).onClick());
    expect(summary().attributes["aria-expanded"]).toBe("true");
    await run(() => props(summary()).onClick());
    expect(summary().attributes["aria-expanded"]).toBe("false");
    await act(async () => postRelease!());
    await settle();
    expect(disabledNow(byId("google-post-type"))).toBe(false);
  }, 10_000);

  it("no SendLock wraps AttachedPhotos: it takes disabled={sendLocksFields} itself", () => {
    const source = readFileSync(path.join(__dirname, "create-post-form.tsx"), "utf8");
    expect(source).not.toMatch(/<SendLock locked=\{sendLocksFields\}>\s*<AttachedPhotos/);
    expect(source).toMatch(/<AttachedPhotos[^<]*?disabled=\{sendLocksFields\}[^<]*?\/>/);
  });

  it("on the page: the photos have no wrapper, and their controls lock during a waiting Schedule and unlock after", async () => {
    postAnswer = REFUSED;
    await mount();
    await typeCaption("Surf lesson today");
    await pressSchedule();
    await pick(photo("s1"), photo("s2"));
    const list = find(container, (n) => n.nodeName === "OL" && n.attributes?.["aria-label"] === "Attached photos");
    if (!list) throw new Error("no attached photos");
    expect(list.parentNode?.parentNode?.nodeName).not.toBe("FIELDSET");
    const label = (n: FakeNode) => String(n.attributes?.["aria-label"] ?? n.attributes?.id ?? "");
    const photoControls = () => [
      ...findAll(container, (n) => n.nodeName === "BUTTON" && /^(Remove|Move|Retry) photo /.test(label(n))),
      ...findAll(container, (n) => n.nodeName === "INPUT" && label(n).startsWith("alt-photo-")),
      buttonTexted("Remove all"),
    ];
    // At the ends of the set an arrow is disabled anyway.
    const offWithoutLock = () => photoControls().filter((n) => disabledNow(n) && !/(1 earlier|2 later)$/.test(label(n)));
    expect(photoControls().length).toBeGreaterThanOrEqual(9);
    expect(offWithoutLock()).toEqual([]);
    postStalls = true;
    await submit();
    expect(posted).toHaveLength(1);

    for (const node of photoControls()) expect(disabledNow(node), label(node)).toBe(true);
    await act(async () => postRelease!());
    await settle();
    expect(offWithoutLock()).toEqual([]);
  }, 10_000);

  it("on the page: a photo leaves no empty fieldset for the missing cover", async () => {
    await mount();
    await pick(photo("still"));
    expect(findAll(container, (n) => n.nodeName === "FIELDSET" && n.childNodes.length === 0)).toEqual([]);
  }, 10_000);
});

describe("Create: the lock keeps keyboard focus (R65 new-customer L1, pages-b L1)", () => {
  const active = () => doc.activeElement as FakeNode;
  /** The form's own submit button (the phone's bar has the other). */
  const formSubmit = () => {
    const hit = find(byId("create-post-form"), (n) => n.nodeName === "BUTTON" && n.attributes?.type === "submit");
    if (!hit) throw new Error("no submit button in the form");
    return hit;
  };
  const isSubmitButton = (node: FakeNode) => node.nodeName === "BUTTON" && node.attributes?.type === "submit";
  const focus = (node: FakeNode) => act(async () => (node.focus as () => void)());
  const releaseUpload = async (name: string) => {
    const sent = uploads.find((u) => u.key.includes(`-${name}.`));
    if (!sent) throw new Error(`no upload of ${name}`);
    await act(async () => release.get(sent.key)!());
    await settle();
  };

  async function scheduleWithStalledPhoto(name: string) {
    await mount();
    await typeCaption("Surf lesson today");
    await pressSchedule();
    stall.add(name);
    await pick(photo(name));
  }

  it("Enter in Publish at during Schedule: focus is on the submit button", async () => {
    await scheduleWithStalledPhoto("enter1");
    await focus(byId("post-schedule"));
    expect(active()).toBe(byId("post-schedule"));
    await submit();
    expect(posted).toHaveLength(0);
    expect(disabledNow(byId("post-schedule"))).toBe(true);

    expect(isSubmitButton(active())).toBe(true);
    // The form's own button, which shows from md up; the phone's bar takes it when that one is hidden.
    expect(active()).toBe(formSubmit());
    expect(disabledNow(active())).toBe(false);
    await releaseUpload("enter1");
  }, 10_000);

  /** The publish bar's button: a submit for the form that sits outside it. */
  const barSubmit = () => {
    const form = byId("create-post-form");
    const hit = find(
      container,
      (n) => isSubmitButton(n) && n.attributes?.form === "create-post-form" && find(form, (m) => m === n) === null,
    );
    if (!hit) throw new Error("no publish bar button");
    return hit;
  };

  it("R66 new-customer L1, a phone: the form's button is hidden and takes no focus, so Enter in Publish at moves focus to the publish bar's button", async () => {
    await scheduleWithStalledPhoto("phone8");
    // As below md: the form's button is inside hidden md:inline, so focus() does nothing.
    Object.assign(formSubmit(), { focus() {} });
    await focus(byId("post-schedule"));
    expect(active()).toBe(byId("post-schedule"));
    await submit();
    expect(posted).toHaveLength(0);
    expect(disabledNow(byId("post-schedule"))).toBe(true);

    expect(active()).toBe(barSubmit());
    expect(active()).not.toBe(formSubmit());
    expect(disabledNow(active())).toBe(false);
    await releaseUpload("phone8");
  }, 10_000);

  it("R66 new-customer L1, desktop: with both buttons focusable, focus goes to the form's own button, not the bar's", async () => {
    await scheduleWithStalledPhoto("desk9");
    await focus(byId("post-schedule"));
    await submit();
    expect(posted).toHaveLength(0);

    expect(active()).toBe(formSubmit());
    expect(active()).not.toBe(barSubmit());
    await releaseUpload("desk9");
  }, 10_000);

  it("Enter in the alt text during Schedule: focus is on the submit button", async () => {
    await scheduleWithStalledPhoto("alt2");
    await focus(byId("post-alt-text"));
    expect(active()).toBe(byId("post-alt-text"));
    await submit();
    expect(disabledNow(byId("post-alt-text"))).toBe(true);

    expect(isSubmitButton(active())).toBe(true);
    await releaseUpload("alt2");
  }, 10_000);

  it("Enter in a photo's alt text in a set during Schedule: focus is on the submit button", async () => {
    await mount();
    await typeCaption("Surf lesson today");
    await pressSchedule();
    await pick(photo("set5a"), photo("set5b"));
    const altField = find(container, (n) => n.nodeName === "INPUT" && String(n.attributes?.id ?? "").startsWith("alt-photo-"));
    if (!altField) throw new Error("no photo alt text");
    await focus(altField);
    expect(active()).toBe(altField);
    // A set sends once every photo is up, so the wait is the save itself.
    postStalls = true;
    await submit();
    expect(posted).toHaveLength(1);
    expect(disabledNow(altField)).toBe(true);

    expect(active()).toBe(formSubmit());
    await act(async () => postRelease!());
    await settle();
  }, 10_000);

  it("Enter in a Google field during Schedule: focus is on the submit button", async () => {
    await scheduleWithStalledPhoto("google6");
    const field = byId("google-post-type");
    await focus(field);
    expect(active()).toBe(field);
    await submit();
    expect(disabledNow(field)).toBe(true);

    expect(active()).toBe(formSubmit());
    await releaseUpload("google6");
  }, 10_000);

  it("a Story choice focused during Schedule: focus is on the submit button", async () => {
    postAnswer = REFUSED;
    await scheduleWithStalledPhoto("story7");
    const legend = find(container, (n) => n.nodeName === "LEGEND" && n.textContent === "Instagram: post to");
    const radio = legend?.parentNode ? find(legend.parentNode, (n) => n.nodeName === "INPUT") : null;
    if (!radio) throw new Error("no Instagram placement");
    await focus(radio);
    expect(active()).toBe(radio);
    await submit();
    expect(disabledNow(radio)).toBe(true);

    expect(active()).toBe(formSubmit());
    await releaseUpload("story7");
    expect(disabledNow(radio)).toBe(false);
  }, 10_000);

  it("pressing the Schedule button itself: focus is unchanged", async () => {
    await scheduleWithStalledPhoto("press3");
    const button = formSubmit();
    await focus(button);
    await submit();
    expect(posted).toHaveLength(0);

    expect(active()).toBe(button);
    await releaseUpload("press3");
  }, 10_000);

  it("after a failed send, focus is still on the submit button", async () => {
    postAnswer = REFUSED;
    await scheduleWithStalledPhoto("fail4");
    await focus(byId("post-schedule"));
    await submit();
    const focused = active();
    expect(isSubmitButton(focused)).toBe(true);
    await releaseUpload("fail4");
    expect(posted).toHaveLength(1);
    expect(disabledNow(byId("post-schedule"))).toBe(false);

    expect(active()).toBe(focused);
  }, 10_000);
});

