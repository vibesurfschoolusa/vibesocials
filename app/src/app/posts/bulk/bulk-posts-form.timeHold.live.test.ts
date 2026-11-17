import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * R45 publishing L1, L2: the rows re-spread after every change in which rows
 * hold a time ("It is in the Queue" too), but a row the last press refused
 * for a time that has passed keeps its time and its line until it is edited.
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
vi.mock("@/lib/prepareUploadFile", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/prepareUploadFile")>()),
  prepareUploadFile: (file: File) => Promise.resolve(file),
}));
vi.mock("@vercel/blob/client", () => ({
  upload: (key: string) => Promise.resolve({ url: `https://blob.example/${key}` }),
}));

import { makeDocument, type FakeNode } from "@/components/shell/fakeDom.testkit";
import { ToastProvider } from "@/components/ui/toast";
import { BULK_PAST_TIME_MESSAGE } from "@/lib/bulkPosts";
import { BulkPostsForm } from "./bulk-posts-form";

let root: Root;
let container: FakeNode;
/** The posting times the workspace has; none means the box is not offered. */
let slots: { day: number; time: string }[];
let posts: number;
/** What the nth POST answers: a post, a refusal, or no answer at all. */
let answers: ("ok" | "refused" | "lost")[];

const fetchMock = vi.fn(async (input: unknown, init?: { method?: string }) => {
  const url = String(input);
  if (url.startsWith("/api/posts/scheduled-times")) return Response.json({ times: [], slots });
  if (url === "/api/posts" && init?.method === "POST") {
    posts += 1;
    const answer = answers[posts - 1] ?? "ok";
    if (answer === "lost") throw new TypeError("Failed to fetch");
    return answer === "refused"
      ? Response.json({ error: "That post was refused." }, { status: 400 })
      : Response.json({ postJob: { id: `post-${posts}` } });
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

function button(label: string): FakeNode {
  const hit = findAll(container, (n) => n.nodeName === "BUTTON" && (n.textContent as string).trim() === label)[0];
  if (!hit) throw new Error(`no ${label} button`);
  return hit;
}

/** Each row's date and time as shown, or "none" for a draft's "no time yet" line. */
function rowTimes(): string[] {
  return findAll(container, (n) => n.nodeName === "LI" && findAll(n, (m) => m.nodeName === "TEXTAREA").length > 0).map(
    (row) => {
      const input = findAll(row, (n) => n.nodeName === "INPUT" && props(n)?.type === ("datetime-local" as never))[0];
      return input ? String(props(input).value) : "none";
    },
  );
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

const photo = (name: string) => new File([name], `${name}.jpg`, { type: "image/jpeg" });

async function mountWithThreePhotos(captions: string[] = ["One", "Two", "Three"]) {
  await act(async () => {
    root.render(createElement(ToastProvider, null, createElement(BulkPostsForm, { workspaceId: "ws-1" })));
  });
  await settle();
  await run(() => props(byId("bulk-ai-captions")).onChange({ target: { checked: false } }));
  await run(() => props(byId("bulk-files")).onChange({ target: { files: [photo("a"), photo("b"), photo("c")] } }));
  for (const [index, caption] of captions.entries()) {
    await run(() => props(rowInput(index, "TEXTAREA")).onChange({ target: { value: caption } }));
  }
}

const saveAllAsDrafts = () => run(() => props(button("Save all as drafts")).onClick({ currentTarget: null }));

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
  Object.assign(made.doc.defaultView as object, {
    matchMedia: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }),
    location: { href: "http://localhost/posts/bulk" },
    localStorage: { getItem: () => null, setItem() {} },
  });
  slots = [];
  posts = 0;
  answers = [];
  root = createRoot(container as unknown as HTMLElement);
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const scheduleAll = () => run(() => props(button("Schedule all")).onClick({ currentTarget: null }));

function usePostingTimes() {
  const box = findAll(
    container,
    (n) => n.nodeName === "INPUT" && props(n)?.type === ("checkbox" as never) && String(n.parentNode?.textContent).includes("Use my posting times"),
  )[0]!;
  return run(() => props(box).onChange({ target: { checked: true } }));
}

describe("R45 publishing L1: It is in the Queue gives up a draft's place", () => {
  it("row 3 moves back to the First day once row 1 is confirmed as a draft", async () => {
    // Row 1 gets no answer, row 2 is saved; row 3 has no caption, so it is not sent.
    answers = ["lost", "ok"];
    await mountWithThreePhotos(["One", "Two", ""]);
    const [first, second] = rowTimes();

    await saveAllAsDrafts();
    expect(posts).toBe(2);
    // Row 1 may exist, so it keeps its place; row 3 takes the next one.
    expect(rowTimes()).toEqual([first, "none", second]);

    await run(() => props(button("It is in the Queue")).onClick({ currentTarget: null }));
    expect(rowTimes()).toEqual(["none", "none", first]);
  });
});

describe("R45 publishing L2: a row refused for a past time keeps it", () => {
  it("keeps its time and line while the others are scheduled; editing it lets it join the spread", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2030, 5, 10, 11, 45));
    slots = [0, 1, 2, 3, 4, 5, 6].flatMap((day) => [
      { day, time: "12:00" },
      { day, time: "18:00" },
    ]);
    await mountWithThreePhotos();
    await usePostingTimes();
    expect(rowTimes()).toEqual(["2030-06-10T12:00", "2030-06-10T18:00", "2030-06-11T12:00"]);

    // The captions took a while: the press is after 12:00.
    vi.setSystemTime(new Date(2030, 5, 10, 12, 1));
    await scheduleAll();
    expect(posts).toBe(2);
    expect(rowTimes()).toEqual(["2030-06-10T12:00", "2030-06-10T18:00", "2030-06-11T12:00"]);
    expect(container.textContent).toContain(BULK_PAST_TIME_MESSAGE);

    // An edit to the row lets it take the next free posting time.
    await run(() => props(rowInput(0, "TEXTAREA")).onChange({ target: { value: "One, edited" } }));
    expect(rowTimes()).toEqual(["2030-06-11T18:00", "2030-06-10T18:00", "2030-06-11T12:00"]);
    expect(container.textContent).not.toContain(BULK_PAST_TIME_MESSAGE);
  });
});

// R45 lead review: a change to the batch's schedule is an edit too.
describe("R45 lead review: the batch controls end a time hold", () => {
  it("refused for a past time, First day moved to tomorrow: the row moves with the others", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2030, 5, 10, 11, 45));
    await mountWithThreePhotos();
    await run(() => props(byId("bulk-first-day")).onChange({ target: { value: "2030-06-10" } }));
    await run(() => props(byId("bulk-time")).onChange({ target: { value: "12:00" } }));
    expect(rowTimes()).toEqual(["2030-06-10T12:00", "2030-06-11T12:00", "2030-06-12T12:00"]);

    vi.setSystemTime(new Date(2030, 5, 10, 12, 1));
    await scheduleAll();
    expect(posts).toBe(2);
    expect(rowTimes()[0]).toBe("2030-06-10T12:00");
    expect(container.textContent).toContain(BULK_PAST_TIME_MESSAGE);

    await run(() => props(byId("bulk-first-day")).onChange({ target: { value: "2030-06-11" } }));
    expect(rowTimes()).toEqual(["2030-06-11T12:00", "2030-06-11T12:00", "2030-06-12T12:00"]);
    expect(container.textContent).not.toContain(BULK_PAST_TIME_MESSAGE);
  });
});
