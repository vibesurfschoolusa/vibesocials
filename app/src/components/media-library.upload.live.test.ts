import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * R65 pages-b L2: the caption box and the file picker stay usable while an
 * upload runs. The POST reads the caption when it is built, after the upload,
 * and the success reset clears the box and the file only while they still
 * hold what was sent. Nothing is disabled, so focus is never lost.
 */
const h = vi.hoisted(() => ({
  upload: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock("next/image", async () => {
  const { createElement: el } = await import("react");
  return { default: (props: { alt?: string }) => el("img", { alt: props.alt }) };
});
vi.mock("@/components/ui/toast", () => ({ useToast: () => ({ success: h.success, error: h.error }) }));
vi.mock("@vercel/blob/client", () => ({ upload: h.upload }));
vi.mock("@/lib/prepareUploadFile", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/prepareUploadFile")>()),
  // The file as picked: no HEIC conversion or shrinking in this test.
  prepareUploadFile: async (file: File) => file,
}));

import { makeDocument, type FakeNode } from "@/components/shell/fakeDom.testkit";

import { MediaLibrary } from "./media-library";

let root: Root;
let container: FakeNode;
let doc: { activeElement: unknown };
const fetchMock = vi.fn();
let mediaPost: (body: Record<string, unknown>) => Promise<Response>;

function find(node: FakeNode, test: (n: FakeNode) => boolean): FakeNode | null {
  if (test(node)) return node;
  for (const child of node.childNodes) {
    const hit = find(child, test);
    if (hit) return hit;
  }
  return null;
}

function props(node: FakeNode): Record<string, (arg?: unknown) => unknown> & { value?: unknown } {
  const key = Object.keys(node).find((k) => k.startsWith("__reactProps$"));
  return node[key as string] as Record<string, (arg?: unknown) => unknown>;
}

const byId = (id: string) => find(container, (n) => n.attributes?.id === id)!;
const captionBox = () => byId("media-caption");

async function settle() {
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function pick(file: File) {
  await act(async () => {
    props(byId("media-file")).onChange({ target: { files: [file], value: "" } });
  });
}

async function type(text: string) {
  await act(async () => {
    props(captionBox()).onChange({ target: { value: text } });
  });
}

async function submit() {
  const form = find(container, (n) => n.nodeName === "FORM")!;
  await act(async () => {
    void props(form).onSubmit({ preventDefault: () => {} });
  });
  await settle();
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function created(body: Record<string, unknown>): Response {
  return Response.json({
    mediaItem: {
      id: "m-1",
      storageLocation: "https://blob.example/a.jpg",
      originalFilename: body.filename,
      mimeType: body.mimeType,
      sizeBytes: body.sizeBytes,
      baseCaption: body.baseCaption,
      perPlatformOverrides: null,
      createdAt: "2026-11-21T12:00:00.000Z",
      lastUsedAt: null,
    },
  });
}

const posted = () =>
  fetchMock.mock.calls
    .filter(([url, init]) => String(url) === "/api/media" && (init as RequestInit | undefined)?.method === "POST")
    .map(([, init]) => JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>);

const photo = (name: string) => new File(["x"], name, { type: "image/jpeg" });
const fileShown = (name: string) => (container.textContent as string).includes(name);

beforeEach(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const made = makeDocument();
  container = made.container;
  doc = made.doc as unknown as { activeElement: unknown };
  vi.stubGlobal("window", made.doc.defaultView);
  vi.stubGlobal("document", made.doc);
  h.upload.mockReset();
  h.success.mockReset();
  h.error.mockReset();
  fetchMock.mockReset();
  mediaPost = async (body) => created(body);
  fetchMock.mockImplementation(async (url: string | URL, init?: RequestInit) => {
    const path = String(url);
    if (path === "/api/media" && init?.method === "POST") return mediaPost(JSON.parse(String(init.body)));
    if (path.startsWith("/api/media?")) return Response.json({ items: [], nextCursor: null });
    return Response.json({ link: null });
  });
  vi.stubGlobal("fetch", fetchMock);
  root = createRoot(container as unknown as HTMLElement);
  await act(async () => {
    root.render(createElement(MediaLibrary, { workspaceId: "ws-1" }));
  });
  await settle();
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});

describe("Media library upload: changes made while it runs", () => {
  it("a caption typed during the upload is saved with the item", async () => {
    const blob = deferred<{ url: string }>();
    h.upload.mockReturnValue(blob.promise);
    await pick(photo("a.jpg"));
    await submit();

    await type("Typed while uploading");
    blob.resolve({ url: "https://blob.example/a.jpg" });
    await settle();

    expect(posted()).toEqual([expect.objectContaining({ baseCaption: "Typed while uploading" })]);
    expect(props(captionBox()).value).toBe("");
    expect(h.success).toHaveBeenCalledWith("Media uploaded successfully.");
  }, 5_000);

  it("a caption typed after the POST was built stays in the box", async () => {
    h.upload.mockResolvedValue({ url: "https://blob.example/a.jpg" });
    const answer = deferred<void>();
    mediaPost = async (body) => {
      await answer.promise;
      return created(body);
    };
    await type("Sent");
    await pick(photo("a.jpg"));
    await submit();
    expect(posted()).toEqual([expect.objectContaining({ baseCaption: "Sent" })]);

    await type("Sent, then more");
    answer.resolve();
    await settle();

    expect(h.success).toHaveBeenCalledWith("Media uploaded successfully.");
    expect(props(captionBox()).value).toBe("Sent, then more");
  }, 5_000);

  it("a different file picked during the upload is kept after success", async () => {
    const blob = deferred<{ url: string }>();
    h.upload.mockReturnValue(blob.promise);
    await pick(photo("first.jpg"));
    await submit();

    await pick(photo("second.jpg"));
    blob.resolve({ url: "https://blob.example/first.jpg" });
    await settle();

    expect(posted()).toEqual([expect.objectContaining({ filename: "first.jpg" })]);
    expect(h.success).toHaveBeenCalledWith("Media uploaded successfully.");
    expect(fileShown("second.jpg")).toBe(true);
  }, 5_000);

  // R65 fix review L1: rebuilding the input would drop focus to the page body.
  it("a file picked during the upload: after success the input is the same element, and focus stays on it", async () => {
    const blob = deferred<{ url: string }>();
    h.upload.mockReturnValue(blob.promise);
    await pick(photo("first.jpg"));
    await submit();

    await pick(photo("second.jpg"));
    const input = byId("media-file");
    doc.activeElement = input;
    blob.resolve({ url: "https://blob.example/first.jpg" });
    await settle();

    expect(h.success).toHaveBeenCalledWith("Media uploaded successfully.");
    expect(byId("media-file")).toBe(input);
    expect(doc.activeElement).toBe(input);
    expect(find(container, (n) => n === input)).toBe(input);
  }, 5_000);

  it("a normal upload: the file input is reset, a new element, as before", async () => {
    h.upload.mockResolvedValue({ url: "https://blob.example/a.jpg" });
    await pick(photo("plain.jpg"));
    const input = byId("media-file");
    await submit();
    expect(h.success).toHaveBeenCalledWith("Media uploaded successfully.");
    expect(byId("media-file")).not.toBe(input);
  }, 5_000);

  it("a normal upload: as before, the caption and file are sent and both are cleared", async () => {
    h.upload.mockResolvedValue({ url: "https://blob.example/a.jpg" });
    await type("Hello");
    await pick(photo("plain.jpg"));
    expect(fileShown("plain.jpg")).toBe(true);
    await submit();

    expect(posted()).toEqual([expect.objectContaining({ baseCaption: "Hello", filename: "plain.jpg", workspaceId: "ws-1" })]);
    expect(h.success).toHaveBeenCalledWith("Media uploaded successfully.");
    expect(props(captionBox()).value).toBe("");
    // The new item's card names the file; the picker no longer does.
    expect(find(byId("media-file").parentNode as FakeNode, (n) => (n.textContent as string)?.includes("plain.jpg") && n.nodeName === "P")).toBeNull();
  }, 5_000);
});
