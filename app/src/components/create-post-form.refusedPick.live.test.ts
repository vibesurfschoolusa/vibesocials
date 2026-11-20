import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * R50 pages-b L1, R51 new-customer L1-L2, on the mounted Create page: a single
 * pick refused for the file itself (over 512 MB, 0 bytes) can never be added.
 * Its line comes from one stored state that only an attached file, a library
 * item, Remove all, a saved post or a newer refusal clears. No press stops for
 * it: the confirm dialog and the "without a photo" button already say so. A
 * pick that failed for the network keeps the lost-file notice and its stop.
 */

vi.mock("next/link", async () => {
  const { createElement: h } = await import("react");
  return { default: ({ href, children, ...rest }: { href: string; children: unknown }) => h("a", { href, ...rest }, children as never) };
});
vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams() }));
vi.mock("@/hooks/useConnections", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/useConnections")>()),
  useConnections: () => ({
    connections: conn.platforms.map((platform) => ({ platform, connected: true })),
    loading: false,
    error: null,
    reload: () => {},
  }),
}));
// x takes text alone; instagram does not.
const conn = vi.hoisted(() => ({ platforms: ["x"] as string[] }));
// The real preparation for the file refusals; `network` stands in for a converter that didn't download.
const prep = vi.hoisted(() => ({ network: false }));
vi.mock("@/lib/prepareUploadFile", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/prepareUploadFile")>();
  return {
    ...real,
    prepareUploadFile: (file: File) =>
      prep.network
        ? Promise.reject(new real.PrepareFileError("network", "The photo converter did not load. Check your connection, then choose it again."))
        : real.prepareUploadFile(file),
  };
});
vi.mock("@vercel/blob/client", () => ({
  upload: (key: string) => Promise.resolve({ url: `https://blob.example/${key}` }),
}));

import { makeDocument, type FakeNode } from "@/components/shell/fakeDom.testkit";
import { ToastProvider } from "@/components/ui/toast";
import { CreatePostForm, FILE_LOST_MESSAGE, FILE_LOST_PRESS_TOAST, UNTOUCHED_SUBMIT_MESSAGE } from "./create-post-form";

let root: Root;
let container: FakeNode;
let body: FakeNode;
const calls: string[] = [];
const postBodies: Record<string, unknown>[] = [];

const fetchMock = vi.fn((input: unknown, init?: { body?: unknown }) => {
  const url = String(input);
  calls.push(url);
  if (url === "/api/posts") {
    postBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return Promise.resolve(Response.json({ id: "job-1" }));
  }
  if (url.startsWith("/api/posts/enhance-caption")) {
    return Promise.resolve(Response.json({ enhancedCaption: "Surf lesson today, the waves were great" }));
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
/** The page's text without the toasts (they live under aria-live and fade). */
function textOutsideToasts(node: FakeNode): string {
  if (node.attributes?.["aria-live"]) return "";
  if (node.childNodes.length === 0) return String(node.textContent ?? "");
  return node.childNodes.map(textOutsideToasts).join("");
}
const lineSays = (text: string) => textOutsideToasts(body).includes(text);
const pick = (...files: File[]) => run(() => props(byId("post-media")).onChange({ target: { files } }));
const typeCaption = (value: string) => run(() => props(byId("post-caption")).onChange({ target: { value } }));
function button(text: string): FakeNode {
  const hit = find(container, (n) => n.nodeName === "BUTTON" && (n.textContent as string).trim() === text);
  if (!hit) throw new Error(`no button ${text}`);
  return hit;
}
const chooseMode = (text: string) => run(() => props(button(text)).onClick());
const dialogShown = () => find(body, (n) => n.attributes?.role === "dialog") !== null;
function dialogButton(text: string): FakeNode {
  const dialog = find(body, (n) => n.attributes?.role === "dialog");
  const hit = dialog && find(dialog, (n) => n.nodeName === "BUTTON" && (n.textContent as string).trim() === text);
  if (!hit) throw new Error(`no dialog button ${text}`);
  return hit;
}
const submit = () => run(() => props(byId("create-post-form")).onSubmit({ preventDefault() {} }));

function sized(name: string, type: string, size: number): File {
  const file = new File(["x"], name, { type });
  Object.defineProperty(file, "size", { value: size });
  return file;
}

/** Tomorrow at 12:00 local, as a datetime-local value: always in the future. */
function tomorrowNoon(): string {
  const now = new Date(Date.now());
  const at = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 12, 0);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T12:00`;
}

const TOO_LARGE = "This file is over 512 MB. Choose a shorter or smaller one.";
const EMPTY = "This file is empty (0 bytes). Choose another file.";

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
  calls.length = 0;
  postBodies.length = 0;
  prep.network = false;
  conn.platforms = ["x"];
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

const BIG = () => sized("long.mp4", "video/mp4", 600 * 1024 * 1024);
/** A toast that offers a press to post without the file. */
const offersWithout = () => pageSays("to post without it");

describe("R51: a refused file is a stored line, not a one-press stop", () => {
  it.each([
    ["a 600 MB video", () => BIG(), TOO_LARGE],
    ["a 0-byte photo", () => new File([], "placeholder.jpg", { type: "image/jpeg" }), EMPTY],
  ])("%s: the refusal's own sentence stays, and nothing says Add it again", async (_name, file, sentence) => {
    await typeCaption("Surf lesson today");
    await pick(file());

    expect(lineSays(sentence)).toBe(true);
    expect(pageSays(FILE_LOST_MESSAGE)).toBe(false);
    expect(pageSays("Add it again")).toBe(false);
  });

  it("untouched page: the press gives the page's own refusal, and the refusal line stays", async () => {
    await pick(BIG());
    expect(lineSays(TOO_LARGE)).toBe(true);

    await submit();
    expect(lineSays(UNTOUCHED_SUBMIT_MESSAGE)).toBe(true);
    expect(offersWithout()).toBe(false);
    expect(lineSays(TOO_LARGE)).toBe(true);
    expect(calls).not.toContain("/api/posts");

    // A second press changes nothing either.
    await submit();
    expect(lineSays(TOO_LARGE)).toBe(true);
    expect(calls).not.toContain("/api/posts");
  });

  it("text page with no platform that takes text: the normal refusal, and no toast offers to post without the file", async () => {
    conn.platforms = ["instagram"];
    await mount();
    await typeCaption("Surf lesson today");
    await pick(BIG());

    await submit();
    expect(lineSays("None of your connected platforms can publish a post without a photo or video.")).toBe(true);
    expect(offersWithout()).toBe(false);
    expect(lineSays(TOO_LARGE)).toBe(true);
    expect(dialogShown()).toBe(false);
    expect(calls).not.toContain("/api/posts");
  });

  it.each([
    ["Publish now", "Publish without a photo"],
    ["Schedule", "Schedule without a photo"],
  ])("%s: the first press opens the confirm dialog, and confirming posts text only", async (mode, label) => {
    await typeCaption("Surf lesson today");
    await chooseMode(mode);
    if (mode === "Schedule") await run(() => props(byId("post-schedule")).onChange({ target: { value: tomorrowNoon() } }));
    await pick(BIG());
    expect(button(label)).toBeTruthy();

    await submit();
    expect(offersWithout()).toBe(false);
    expect(dialogShown()).toBe(true);
    await run(() => props(dialogButton(label)).onClick());
    expect(postBodies).toHaveLength(1);
    expect(postBodies[0].textOnly).toBe(true);
    expect(postBodies[0].blobUrl).toBeUndefined();
    // A saved post clears the line.
    expect(lineSays(TOO_LARGE)).toBe(false);
  });

  it("Draft: the first press saves text only", async () => {
    await typeCaption("Surf lesson today");
    await chooseMode("Save draft");
    await pick(BIG());
    expect(button("Save draft without a photo")).toBeTruthy();

    await submit();
    expect(offersWithout()).toBe(false);
    expect(postBodies).toHaveLength(1);
    expect(postBodies[0].textOnly).toBe(true);
  });

  it("Improve caption keeps the refusal line", async () => {
    await typeCaption("Surf lesson today");
    await pick(BIG());
    await run(() => props(button("Improve caption")).onClick());
    expect(calls.some((url) => url.startsWith("/api/posts/enhance-caption"))).toBe(true);
    expect(lineSays(TOO_LARGE)).toBe(true);
  });

  it("picking a file that can be added clears it", async () => {
    await typeCaption("Surf lesson today");
    await pick(BIG());
    expect(lineSays(TOO_LARGE)).toBe(true);
    await pick(sized("beach.mp4", "video/mp4", 1024));
    expect(lineSays(TOO_LARGE)).toBe(false);
  });

  it("a newer refusal replaces it", async () => {
    await typeCaption("Surf lesson today");
    await pick(BIG());
    await pick(new File([], "placeholder.jpg", { type: "image/jpeg" }));
    expect(lineSays(EMPTY)).toBe(true);
    expect(lineSays(TOO_LARGE)).toBe(false);
  });

  it("a network failure, then a 600 MB pick: the refusal replaces the notice", async () => {
    await typeCaption("Surf lesson today");
    prep.network = true;
    await pick(new File(["a"], "beach.heic", { type: "image/heic" }));
    expect(lineSays(FILE_LOST_MESSAGE)).toBe(true);

    prep.network = false;
    await pick(BIG());
    expect(lineSays(TOO_LARGE)).toBe(true);
    expect(pageSays("Add it again")).toBe(false);

    await submit();
    expect(pageSays(FILE_LOST_PRESS_TOAST)).toBe(false);
    expect(offersWithout()).toBe(false);
    expect(dialogShown()).toBe(true);
  });

  it("a network failure in preparing keeps the lost-file notice, its press toast and its stop", async () => {
    prep.network = true;
    await typeCaption("Surf lesson today");
    await pick(new File(["a"], "beach.heic", { type: "image/heic" }));

    expect(lineSays(FILE_LOST_MESSAGE)).toBe(true);

    await submit();
    expect(pageSays(FILE_LOST_PRESS_TOAST)).toBe(true);
    expect(dialogShown()).toBe(false);
    expect(calls).not.toContain("/api/posts");

    // The second press goes on to the confirm dialog, as before.
    await submit();
    expect(dialogShown()).toBe(true);
  });
});
