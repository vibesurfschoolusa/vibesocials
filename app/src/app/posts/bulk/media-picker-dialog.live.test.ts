import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * R44 pages-a L2 (= publishing L2): a reopened picker whose first page failed
 * kept the last opening's tiles and Load more, and announced their count
 * under the alert. A failed first page now lists nothing and says nothing
 * else.
 */

const { announced } = vi.hoisted(() => ({ announced: [] as string[] }));

vi.mock("@/components/ui/dialog", async () => {
  const { createElement: h } = await import("react");
  const pass = ({ children }: { children?: ReactNode }) => h("div", null, children);
  return {
    Dialog: ({ open, children }: { open: boolean; children?: ReactNode }) => (open ? h("div", { role: "dialog" }, children) : null),
    DialogBody: pass,
    DialogDescription: pass,
    DialogFooter: pass,
    DialogHeader: pass,
    DialogTitle: pass,
  };
});
vi.mock("@/components/ui/announcer", async (importOriginal) => {
  const { createElement: h, useEffect } = await import("react");
  return {
    ...(await importOriginal<object>()),
    AnnouncedText: ({ text }: { text: string }) => {
      useEffect(() => {
        announced.push(text);
      }, [text]);
      return h("p", { "data-announced": "" }, text);
    },
  };
});

import { makeDocument, type FakeNode } from "@/components/shell/fakeDom.testkit";

import { FIRST_LOAD_FAILED_MESSAGE, MediaPickerDialog, mediaCountLine } from "./media-picker-dialog";

let root: Root;
let container: FakeNode;
let reply: () => Promise<Response>;

const ITEMS = Array.from({ length: 12 }, (_, index) => ({
  id: `m${index}`,
  originalFilename: `photo-${index}.jpg`,
  mimeType: "image/jpeg",
  storageLocation: `https://blob.example/photo-${index}.jpg`,
}));

function text(): string {
  return container.textContent as string;
}

function count(node: FakeNode, nodeName: string): number {
  return (node.nodeName === nodeName ? 1 : 0) + node.childNodes.reduce((sum, child) => sum + count(child, nodeName), 0);
}

async function show(open: boolean, room = 20) {
  await act(async () => {
    root.render(
      createElement(MediaPickerDialog, {
        workspaceId: "ws-1",
        open,
        onOpenChange: () => {},
        addedIds: new Set<string>(),
        room,
        onAdd: () => {},
      }),
    );
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const made = makeDocument();
  container = made.container;
  vi.stubGlobal("document", made.doc);
  vi.stubGlobal("window", made.doc.defaultView);
  vi.stubGlobal("fetch", vi.fn(async () => reply()));
  announced.length = 0;
  root = createRoot(container as unknown as HTMLElement);
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});

describe("Media picker: a reopening whose first page fails", () => {
  it("shows no old tiles, no Load more and no count line; only the alert", async () => {
    reply = async () => Response.json({ items: ITEMS, nextCursor: "next" });
    await show(true);
    expect(count(container, "LI")).toBe(12);
    expect(text()).toContain(mediaCountLine(12));
    expect(text()).toContain("Load more");

    await show(false);
    reply = async () => {
      throw new TypeError("Failed to fetch");
    };
    announced.length = 0;
    await show(true);

    expect(text()).toContain(FIRST_LOAD_FAILED_MESSAGE);
    expect(count(container, "LI")).toBe(0);
    expect(count(container, "INPUT")).toBe(0);
    expect(text()).not.toContain("Load more");
    expect(text()).not.toContain("Showing");
    expect(announced.filter((line) => line !== "Loading your media…")).toEqual([]);
  });
});

// R45 pages-a L1: the error was cleared only by a good first page, so a
// reopening showed and announced the old failure above the skeletons.
describe("Media picker: reopened after a failure", () => {
  it("shows no alert while the new load is still on its way", async () => {
    reply = async () => {
      throw new TypeError("Failed to fetch");
    };
    await show(true);
    expect(text()).toContain(FIRST_LOAD_FAILED_MESSAGE);

    await show(false);
    let answer: (response: Response) => void = () => {};
    reply = () => new Promise<Response>((resolve) => (answer = resolve));
    await show(true);
    expect(text()).toContain("Loading your media…");
    expect(text()).not.toContain(FIRST_LOAD_FAILED_MESSAGE);

    await act(async () => answer(Response.json({ items: ITEMS.slice(0, 2), nextCursor: null })));
    await show(true);
    expect(count(container, "LI")).toBe(2);
    expect(text()).not.toContain(FIRST_LOAD_FAILED_MESSAGE);
  });
});

// R68 pages-a L1: the line counted the room at opening and never went down,
// and the tiles the limit locks kept a tappable look.
function findAll(node: FakeNode, test: (n: FakeNode) => boolean, hits: FakeNode[] = []): FakeNode[] {
  if (test(node)) hits.push(node);
  for (const child of node.childNodes) findAll(child, test, hits);
  return hits;
}
function props(node: FakeNode): Record<string, unknown> {
  const key = Object.keys(node).find((k) => k.startsWith("__reactProps$"));
  return node[key as string] as Record<string, unknown>;
}
const tiles = () => findAll(container, (n) => n.nodeName === "LABEL");
const boxIn = (tile: FakeNode) => findAll(tile, (n) => n.nodeName === "INPUT")[0]!;
const classesOf = (node: FakeNode) => String(node.attributes.class ?? "").split(/\s+/).filter(Boolean);
async function toggle(index: number) {
  await act(async () => (props(boxIn(tiles()[index]!)).onChange as () => void)());
}
const LIMIT_LINE = "You've chosen as many as fit. Untick one to choose another.";
const TILE_AS_NOW = "relative block cursor-pointer overflow-hidden rounded-[var(--radius)] border border-border";
const TICKED_AS_NOW = "relative block cursor-pointer overflow-hidden rounded-[var(--radius)] border border-primary ring-2 ring-primary";

describe("Media picker: the count goes down and the limit's locked tiles look locked (R68 pages-a L1)", () => {
  it("room 2: ticking 1 says 1 more, ticking 2 says the limit sentence", async () => {
    reply = async () => Response.json({ items: ITEMS.slice(0, 4), nextCursor: null });
    await show(true, 2);
    expect(text()).toContain("2 more can be added.");
    await toggle(0);
    expect(text()).toContain("1 more can be added.");
    await toggle(1);
    expect(text()).toContain(LIMIT_LINE);
    expect(text()).not.toContain("more can be added");
  });

  it("at the limit, an unticked tile is disabled and looks it, with no hover; ticked tiles are as now", async () => {
    reply = async () => Response.json({ items: ITEMS.slice(0, 4), nextCursor: null });
    await show(true, 2);
    await toggle(0);
    await toggle(1);
    const [first, second, third, fourth] = tiles();
    for (const tile of [third!, fourth!]) {
      expect(props(boxIn(tile)).disabled).toBe(true);
      expect(classesOf(tile)).toEqual(expect.arrayContaining(["cursor-not-allowed", "opacity-50"]));
      expect(classesOf(tile)).not.toContain("cursor-pointer");
      expect(classesOf(tile).filter((c) => c.includes("hover:"))).toEqual([]);
    }
    for (const tile of [first!, second!]) {
      expect(props(boxIn(tile)).disabled).toBe(false);
      expect(tile.attributes.class).toBe(TICKED_AS_NOW);
    }
  });

  it("unticking one at the limit unlocks the tiles and brings the count back", async () => {
    reply = async () => Response.json({ items: ITEMS.slice(0, 4), nextCursor: null });
    await show(true, 2);
    await toggle(0);
    await toggle(1);
    await toggle(1);
    expect(text()).toContain("1 more can be added.");
    expect(text()).not.toContain(LIMIT_LINE);
    for (const tile of tiles().slice(1)) {
      expect(props(boxIn(tile)).disabled).toBe(false);
      expect(tile.attributes.class).toBe(TILE_AS_NOW);
    }
  });

  it("room 20: the line and the tiles are as now", async () => {
    reply = async () => Response.json({ items: ITEMS.slice(0, 4), nextCursor: null });
    await show(true, 20);
    expect(text()).toContain("Tick the photos and videos to add. 20 more can be added.");
    for (const tile of tiles()) {
      expect(props(boxIn(tile)).disabled).toBe(false);
      expect(tile.attributes.class).toBe(TILE_AS_NOW);
    }
  });

  it("room 0: the line and the tiles are as now", async () => {
    reply = async () => Response.json({ items: ITEMS.slice(0, 4), nextCursor: null });
    await show(true, 0);
    expect(text()).toContain("Tick the photos and videos to add. 0 more can be added.");
    expect(text()).not.toContain(LIMIT_LINE);
    for (const tile of tiles()) {
      expect(props(boxIn(tile)).disabled).toBe(true);
      expect(tile.attributes.class).toBe(TILE_AS_NOW);
    }
  });
});
