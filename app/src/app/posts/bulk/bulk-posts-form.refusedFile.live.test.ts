import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * R48 publishing L4: a file prepareUploadFile refuses for its own type (an
 * AVIF, a TIFF, a typeless "IMG_0042") is refused on every Retry, so its row
 * offers only Remove and keeps the file's sentence. A network failure keeps
 * Retry. Schedule all sends the other rows and leaves the refused one out with
 * a line that offers no Retry, as for any row that can't be sent.
 */

vi.mock("next/link", async () => {
  const { createElement: h } = await import("react");
  return { default: ({ href, children, ...rest }: { href: string; children: unknown }) => h("a", { href, ...rest }, children as never) };
});
vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams(), useRouter: () => ({ push() {}, refresh() {} }) }));
vi.mock("@/hooks/useConnections", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/useConnections")>()),
  useConnections: () => ({ connections: [{ platform: "x", connected: true }], loading: false, error: null, reload: () => {} }),
}));
vi.mock("@/lib/prepareUploadFile", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/prepareUploadFile")>();
  return {
    ...actual,
    prepareUploadFile: (file: File) =>
      file.type === "image/avif" ? Promise.reject(new Error(actual.unsupportedTypeMessage(file.type))) : Promise.resolve(file),
  };
});
/** Upload keys whose next upload fails as a dropped connection does. */
const failNext = new Set<string>();
vi.mock("@vercel/blob/client", () => ({
  upload: (key: string) => {
    for (const name of failNext) {
      if (key.includes(name)) {
        failNext.delete(name);
        return Promise.reject(new Error("The upload stalled."));
      }
    }
    return Promise.resolve({ url: `https://blob.example/${key}` });
  },
}));

import { makeDocument, type FakeNode } from "@/components/shell/fakeDom.testkit";
import { ToastProvider } from "@/components/ui/toast";
import { unsupportedTypeMessage } from "@/lib/prepareUploadFile";
import { BulkPostsForm } from "./bulk-posts-form";

let root: Root;
let container: FakeNode;
let posts: number;

const fetchMock = vi.fn(async (input: unknown, init?: { method?: string }) => {
  const url = String(input);
  if (url.startsWith("/api/posts/scheduled-times")) return Response.json({ times: [], slots: [] });
  if (url === "/api/posts" && init?.method === "POST") {
    posts += 1;
    return Response.json({ postJob: { id: `post-${posts}` } });
  }
  return Response.json({});
});

function findAll(node: FakeNode, test: (n: FakeNode) => boolean, hits: FakeNode[] = []): FakeNode[] {
  if (test(node)) hits.push(node);
  for (const child of node.childNodes) findAll(child, test, hits);
  return hits;
}

function props(node: FakeNode): Record<string, (arg?: unknown) => unknown> & { value?: string } {
  const key = Object.keys(node).find((k) => k.startsWith("__reactProps$"));
  return node[key as string] as Record<string, (arg?: unknown) => unknown> & { value?: string };
}

function byId(id: string): FakeNode {
  const hit = findAll(container, (n) => n.attributes?.id === id)[0];
  if (!hit) throw new Error(`no #${id}`);
  return hit;
}

function rowInput(index: number, nodeName: "TEXTAREA" | "INPUT"): FakeNode {
  const rows = findAll(container, (n) => n.nodeName === "LI" && findAll(n, (m) => m.nodeName === "TEXTAREA").length > 0);
  return findAll(rows[index]!, (n) =>
    nodeName === "TEXTAREA" ? n.nodeName === "TEXTAREA" : n.nodeName === "INPUT" && props(n)?.type === ("datetime-local" as never),
  )[0]!;
}

async function settle() {
  for (let i = 0; i < 8; i += 1) {
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

async function mountWith(files: File[], captions: string[]) {
  await act(async () => {
    root.render(createElement(ToastProvider, null, createElement(BulkPostsForm, { workspaceId: "ws-1" })));
  });
  await settle();
  await run(() => props(byId("bulk-ai-captions")).onChange({ target: { checked: false } }));
  await run(() => props(byId("bulk-files")).onChange({ target: { files } }));
  for (const [index, caption] of captions.entries()) {
    await run(() => props(rowInput(index, "TEXTAREA")).onChange({ target: { value: caption } }));
  }
}

function buttons(label: string): FakeNode[] {
  return findAll(container, (n) => n.nodeName === "BUTTON" && (n.textContent as string).trim() === label);
}

const photo = (name: string) => new File([name], `${name}.jpg`, { type: "image/jpeg" });
const avif = () => new File(["avif"], "beach.avif", { type: "image/avif" });
const AVIF_SENTENCE = unsupportedTypeMessage("image/avif");

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const made = makeDocument();
  container = made.container;
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
  vi.stubGlobal("URL", Object.assign(Object.create(URL), URL, { createObjectURL: () => "blob:thumb", revokeObjectURL() {} }));
  Object.assign(made.doc.defaultView as object, {
    matchMedia: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }),
    location: { href: "http://localhost/posts/bulk" },
    localStorage: { getItem: () => null, setItem() {} },
  });
  posts = 0;
  failNext.clear();
  root = createRoot(container as unknown as HTMLElement);
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});

describe("Add many: a file refused for its own type", () => {
  it("an AVIF row: the file's sentence and Remove, no Retry", async () => {
    await mountWith([avif()], []);
    expect(container.textContent).toContain(AVIF_SENTENCE);
    expect(buttons("Retry")).toHaveLength(0);
    expect(buttons("Remove").length).toBeGreaterThan(0);
  }, 10_000);

  it("a network failure: Retry is still offered", async () => {
    failNext.add("net");
    await mountWith([photo("net")], []);
    expect(container.textContent).toContain("did not upload");
    expect(buttons("Retry")).toHaveLength(1);
  }, 10_000);

  it("Schedule all with one refused row: the others are scheduled, the refused one is left out with no Retry", async () => {
    await mountWith([photo("a"), avif(), photo("b")], ["One", "Two", "Three"]);
    const schedule = buttons("Schedule all")[0]!;
    expect(props(schedule).disabled).toBeFalsy();
    await run(() => props(schedule).onClick({ currentTarget: null }));
    expect(posts).toBe(2);
    expect(container.textContent).toContain(AVIF_SENTENCE);
    expect(container.textContent).not.toContain("Retry it");
    expect(buttons("Retry")).toHaveLength(0);
  }, 10_000);
});
