import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * R50 pages-b L1, on the mounted Create page: a single pick refused for the
 * file itself (over 512 MB, 0 bytes) can never be added, so the line that
 * stays is the refusal's own sentence and nothing says "Add it again". The
 * first press still stops once, with a toast giving the two steps that work.
 * A pick that failed for the network keeps the lost-file notice.
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
import { CreatePostForm, FILE_LOST_MESSAGE, FILE_LOST_PRESS_TOAST, fileRefusedPressToast } from "./create-post-form";

let root: Root;
let container: FakeNode;
let body: FakeNode;
const calls: string[] = [];

const fetchMock = vi.fn((input: unknown) => {
  const url = String(input);
  calls.push(url);
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
  prep.network = false;
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

describe("R50 pages-b L1: a file that can never be added", () => {
  it.each([
    ["a 600 MB video", () => sized("long.mp4", "video/mp4", 600 * 1024 * 1024), TOO_LARGE],
    ["a 0-byte photo", () => new File([], "placeholder.jpg", { type: "image/jpeg" }), EMPTY],
  ])("%s: the refusal's own sentence stays, and nothing says Add it again", async (_name, file, sentence) => {
    await typeCaption("Surf lesson today");
    await pick(file());

    expect(lineSays(sentence)).toBe(true);
    expect(pageSays(FILE_LOST_MESSAGE)).toBe(false);
    expect(pageSays("Add it again")).toBe(false);
  });

  // The first press stops once in every mode, so the post can't go out without
  // the file by accident; a text draft has no confirm dialog to catch it.
  it.each([
    ["Publish now", "Publish without a photo", true],
    ["Schedule", "Schedule without a photo", true],
    ["Save draft", "Save draft without a photo", false],
  ])("%s: the first press stops with the two steps, the second goes through", async (mode, label, confirms) => {
    await typeCaption("Surf lesson today");
    await chooseMode(mode);
    if (mode === "Schedule") await run(() => props(byId("post-schedule")).onChange({ target: { value: "2099-06-10T12:00" } }));
    await pick(sized("long.mp4", "video/mp4", 600 * 1024 * 1024));

    await submit();
    expect(pageSays(fileRefusedPressToast(label))).toBe(true);
    expect(pageSays(FILE_LOST_PRESS_TOAST)).toBe(false);
    expect(pageSays("Add it again")).toBe(false);
    // The refusal's own line is still on screen after the stopped press.
    expect(lineSays(TOO_LARGE)).toBe(true);
    expect(dialogShown()).toBe(false);
    expect(calls).not.toContain("/api/posts");

    await submit();
    if (confirms) {
      expect(dialogShown()).toBe(true);
      await run(() => props(dialogButton(label)).onClick());
    }
    expect(calls).toContain("/api/posts");
  });

  it("names the press's own button in the toast", () => {
    expect(fileRefusedPressToast("Publish without a photo")).toBe(
      "Nothing was sent: the file wasn't added. Choose another file, or press \"Publish without a photo\" to post without it.",
    );
  });

  it("a network failure, then a 600 MB pick: nothing says Add it again", async () => {
    await typeCaption("Surf lesson today");
    prep.network = true;
    await pick(new File(["a"], "beach.heic", { type: "image/heic" }));
    expect(lineSays(FILE_LOST_MESSAGE)).toBe(true);

    prep.network = false;
    await pick(sized("long.mp4", "video/mp4", 600 * 1024 * 1024));
    expect(lineSays(TOO_LARGE)).toBe(true);
    expect(pageSays("Add it again")).toBe(false);

    await submit();
    expect(pageSays(fileRefusedPressToast("Publish without a photo"))).toBe(true);
    expect(pageSays(FILE_LOST_PRESS_TOAST)).toBe(false);
    expect(pageSays("Add it again")).toBe(false);
  });

  it("a network failure in preparing keeps the lost-file notice and its press toast", async () => {
    prep.network = true;
    await typeCaption("Surf lesson today");
    await pick(new File(["a"], "beach.heic", { type: "image/heic" }));

    expect(lineSays(FILE_LOST_MESSAGE)).toBe(true);

    await submit();
    expect(pageSays(FILE_LOST_PRESS_TOAST)).toBe(true);
    expect(calls).not.toContain("/api/posts");
  });
});
