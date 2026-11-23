import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * R67 round, BC3 review of item 8: the Google box remembers the event and
 * offer details across a type switch in its own state, so a successful send
 * remounts it (a new key) and post 2 starts with nothing from post 1. A failed
 * send, and a type switch within one post, keep the same box.
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
      { platform: "google_business_profile", connected: true },
    ],
    loading: false,
    error: null,
    reload: () => {},
  }),
}));
/** A file named "slowfail" fails to prepare when the test lets it go. */
const prepareFail: (() => void)[] = [];
/** A file named "slowpick" prepares when the test lets it go, so the page renders while it prepares. */
const prepareDone: (() => void)[] = [];
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
        : file.name.includes("slowpick")
          ? new Promise<File>((resolve) => prepareDone.push(() => resolve(file)))
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
/** The body of every POST /api/posts, parsed. */
const postedBodies: { googleMetadata?: unknown }[] = [];
/** The next POST /api/posts answers; empty means 201. */
let postAnswer: (() => Response) | null = null;
const autoCaptionCalls: string[] = [];
const fetchMock = vi.fn((input: unknown, init?: { method?: string }) => {
  const url = String(input);
  if (url === "/api/posts" && init?.method === "POST") {
    posted.push(url);
    postedBodies.push(JSON.parse(String((init as { body?: string }).body ?? "{}")));
    const answer = postAnswer ?? (() => Response.json({ postJob: { id: "job-1" } }, { status: 201 }));
    return Promise.resolve(answer());
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
function buttonTexted(text: string, within: FakeNode = container): FakeNode {
  const hit = find(within, (n) => n.nodeName === "BUTTON" && (n.textContent as string).trim() === text);
  if (!hit) throw new Error(`no button ${text}`);
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
        setCustomValidity() {},
        checkValidity: () => true,
        ...(tag === "select" ? { options: [] } : {}),
      }),
  });
  vi.stubGlobal("HTMLElement", class {});
  vi.stubGlobal("Node", class {});
  uploads.length = 0;
  stall.clear();
  release.clear();
  posted.length = 0;
  postedBodies.length = 0;
  postAnswer = null;
  autoCaptionCalls.length = 0;
  prepareFail.length = 0;
  prepareDone.length = 0;
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

const typeCaption = (value: string) => run(() => props(byId("post-caption")).onChange({ target: { value } }));
const UNEXPECTED = "Unexpected error while creating post.";

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
const submit = () => run(() => props(byId("create-post-form")).onSubmit({ preventDefault() {} }));
const REFUSED = () => Response.json({ error: "Something went wrong saving this post. Try again." }, { status: 400 });

/** The box's settings panel: always rendered while the box is, so a new node means a new mount. */
const googlePanel = () => byId("google-post-box-settings");
const setField = (id: string, value: string) => run(() => props(byId(id)).onChange({ target: { value } }));
const fieldValue = (id: string) => String(props(byId(id)).value ?? "");
const chooseType = (type: "standard" | "event" | "offer") => setField("google-post-type", type);

async function typeEvent() {
  await chooseType("event");
  await setField("google-event-title", "Full moon paddle");
  await setField("google-event-start-date", "2030-06-01");
  await setField("google-event-end-date", "2030-06-02");
}
async function typeOffer() {
  await chooseType("offer");
  await setField("google-offer-title", "Two lessons for one");
  await setField("google-offer-start-date", "2030-06-01");
  await setField("google-offer-end-date", "2030-06-30");
}
/** Submit, then confirm "Schedule without a photo?" (a text-only post asks first). */
async function send() {
  await submit();
  const dialog = find(body, (n) => n.attributes?.role === "dialog");
  if (!dialog) throw new Error("no confirm dialog");
  await run(() => props(buttonTexted("Schedule without a photo", dialog)).onClick());
}
async function scheduleWithGoogle() {
  await typeCaption("Surf lesson today");
  await pressSchedule();
}

describe("Create: the Google box is fresh after a sent post (R67 item 8 review)", () => {
  it("post 1 with an Event then an Offer, sent: post 2's Event fields are empty", async () => {
    await scheduleWithGoogle();
    await typeEvent();
    await typeOffer();
    await send();
    expect(posted).toHaveLength(1);
    expect(pageSays(UNEXPECTED)).toBe(false);

    await chooseType("event");
    expect(fieldValue("google-event-title")).toBe("");
    expect(fieldValue("google-event-start-date")).toBe("");
    await chooseType("offer");
    expect(fieldValue("google-offer-title")).toBe("");
  }, 15_000);

  it("within one post, Event, Offer, then Event: the same box stays, with the Offer kept on the way", async () => {
    await scheduleWithGoogle();
    const before = googlePanel();
    await typeEvent();
    await typeOffer();
    expect(fieldValue("google-offer-title")).toBe("Two lessons for one");
    await chooseType("event");
    expect(googlePanel()).toBe(before);
    expect(posted).toHaveLength(0);
  }, 15_000);

  it("a failed send: nothing is forgotten", async () => {
    postAnswer = REFUSED;
    await scheduleWithGoogle();
    await typeEvent();
    await typeOffer();
    await send();
    expect(posted).toHaveLength(1);

    expect(fieldValue("google-post-type")).toBe("offer");
    expect(fieldValue("google-offer-title")).toBe("Two lessons for one");
    expect(fieldValue("google-offer-end-date")).toBe("2030-06-30");
    await chooseType("event");
    expect(fieldValue("google-event-title")).toBe("Full moon paddle");
  }, 15_000);
});

const pick = (...files: File[]) => run(() => props(byId("post-media")).onChange({ target: { files } }));
/** A pick that renders while it prepares (the Google box leaves the page meanwhile), then finishes. */
async function slowPick(file: File) {
  await pick(file);
  expect(find(container, (n) => n.attributes?.id === "google-post-box-settings")).toBeNull();
  await run(() => prepareDone.shift()?.());
}
const photo = (name: string) => new File([name], `${name}.jpg`, { type: "image/jpeg" });
const BOOK = { type: "BOOK", url: "https://e.com/book" };
async function setBook() {
  await setField("google-button-type", "BOOK");
  await setField("google-button-url", BOOK.url);
}

/**
 * R68 pages-b L1: the box leaves the page while a new pick prepares (no file
 * type yet), so the memory of other types' details lives in Create, and a new
 * file never wipes it.
 */
describe("Create: a new file pick keeps the remembered Google details (R68 pages-b L1)", () => {
  it("Event typed on a photo, Offer, a new photo, then Event: the event's fields come back", async () => {
    await scheduleWithGoogle();
    await pick(photo("first1"));
    await typeEvent();
    await chooseType("offer");
    await slowPick(photo("slowpick1"));
    expect(fieldValue("google-post-type")).toBe("offer");
    await chooseType("event");

    expect(fieldValue("google-event-title")).toBe("Full moon paddle");
    expect(fieldValue("google-event-start-date")).toBe("2030-06-01");
    expect(fieldValue("google-event-end-date")).toBe("2030-06-02");
  }, 15_000);

  it("Update with a Book button, Offer, a new photo, then Update: the button comes back", async () => {
    await scheduleWithGoogle();
    await pick(photo("first2"));
    await setBook();
    await chooseType("offer");
    await slowPick(photo("slowpick2"));
    await setField("google-post-type", "update");

    expect(fieldValue("google-button-type")).toBe("BOOK");
    expect(fieldValue("google-button-url")).toBe(BOOK.url);
  }, 15_000);

  it("a text post with an event, switched to Update, gets its first photo, then Event: the fields come back", async () => {
    await scheduleWithGoogle();
    await typeEvent();
    await setField("google-post-type", "update");
    await slowPick(photo("slowpick3"));
    await chooseType("event");

    expect(fieldValue("google-event-title")).toBe("Full moon paddle");
    expect(fieldValue("google-event-end-date")).toBe("2030-06-02");
  }, 15_000);

  it("after the new pick, the request sends only the chosen type's details", async () => {
    await scheduleWithGoogle();
    await pick(photo("first4"));
    await typeEvent();
    await typeOffer();
    await slowPick(photo("slowpick4"));
    await chooseType("event");
    await submit();

    expect(posted).toHaveLength(1);
    expect(postedBodies[0].googleMetadata).toEqual({
      postType: "event",
      event: { title: "Full moon paddle", startDate: "2030-06-01", endDate: "2030-06-02" },
    });
  }, 15_000);
});
