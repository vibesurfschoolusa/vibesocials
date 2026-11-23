import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * R69 pages-a L2: the countdown ("{n} more can be added.") and the limit
 * sentence sat in the dialog's description, which is read once when the
 * dialog opens, so a screen-reader user never heard them change. A change is
 * now read out through the page's announcer, once.
 */

const { announced } = vi.hoisted(() => ({ announced: [] as string[] }));

vi.mock("next/navigation", () => ({ usePathname: () => "/posts/bulk" }));
vi.mock("@/lib/announcer", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/announcer")>()),
  createAnnouncer: () => (text: string) => {
    announced.push(text);
  },
}));
vi.mock("@/components/ui/dialog", async () => {
  const { createElement: h } = await import("react");
  const pass = ({ children }: { children?: ReactNode }) => h("div", null, children);
  return {
    Dialog: ({ open, children }: { open: boolean; children?: ReactNode }) => (open ? h("div", { role: "dialog" }, children) : null),
    DialogBody: pass,
    DialogDescription: ({ children }: { children?: ReactNode }) => h("p", { "data-description": "" }, children),
    DialogFooter: pass,
    DialogHeader: pass,
    DialogTitle: pass,
  };
});

import { makeDocument, type FakeNode } from "@/components/shell/fakeDom.testkit";
import { AnnouncerProvider } from "@/components/ui/announcer";

import { MediaPickerDialog, mediaCountLine } from "./media-picker-dialog";

let root: Root;
let container: FakeNode;

const ITEMS = Array.from({ length: 4 }, (_, index) => ({
  id: `m${index}`,
  originalFilename: `photo-${index}.jpg`,
  mimeType: "image/jpeg",
  storageLocation: `https://blob.example/photo-${index}.jpg`,
}));
const LIMIT_LINE = "You've chosen as many as fit. Untick one to choose another.";

function findAll(node: FakeNode, test: (n: FakeNode) => boolean, hits: FakeNode[] = []): FakeNode[] {
  if (test(node)) hits.push(node);
  for (const child of node.childNodes) findAll(child, test, hits);
  return hits;
}
function props(node: FakeNode): Record<string, unknown> {
  const key = Object.keys(node).find((k) => k.startsWith("__reactProps$"));
  return node[key as string] as Record<string, unknown>;
}
const boxes = () => findAll(container, (n) => n.nodeName === "INPUT");
async function toggle(index: number) {
  await act(async () => (props(boxes()[index]!).onChange as () => void)());
}

async function show(open: boolean, room: number) {
  await act(async () => {
    root.render(
      createElement(
        AnnouncerProvider,
        null,
        createElement(MediaPickerDialog, {
          workspaceId: "ws-1",
          open,
          onOpenChange: () => {},
          addedIds: new Set<string>(),
          room,
          onAdd: () => {},
        }),
      ),
    );
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/** Mounted closed, so the opening comes after the page's first render, as on the page. */
async function open(room: number) {
  await show(false, room);
  await show(true, room);
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const made = makeDocument();
  container = made.container;
  vi.stubGlobal("document", made.doc);
  vi.stubGlobal("window", made.doc.defaultView);
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ items: ITEMS, nextCursor: null })));
  announced.length = 0;
  root = createRoot(container as unknown as HTMLElement);
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});

describe("Media picker: the countdown and the limit sentence are read out when they change (R69 pages-a L2)", () => {
  it("ticking to the limit announces the countdown, then the limit sentence, each once", async () => {
    await open(2);
    announced.length = 0;
    await toggle(0);
    expect(announced).toEqual(["1 more can be added."]);
    await toggle(1);
    expect(announced).toEqual(["1 more can be added.", LIMIT_LINE]);
  });

  it("unticking at the limit announces the count again, once", async () => {
    await open(2);
    await toggle(0);
    await toggle(1);
    announced.length = 0;
    await toggle(1);
    expect(announced).toEqual(["1 more can be added."]);
  });

  it("opening reads the description once, as now: the announcer says only the loading and count lines", async () => {
    await open(2);
    expect(announced).toEqual(["Loading your media…", mediaCountLine(4)]);
    const descriptions = findAll(container, (n) => n.attributes?.["data-description"] === "");
    expect(descriptions).toHaveLength(1);
    expect(descriptions[0]!.textContent).toBe("Tick the photos and videos to add. 2 more can be added.");
  });

  it("reopened after reaching the limit: the fresh opening announces no countdown", async () => {
    await open(2);
    await toggle(0);
    await toggle(1);
    await show(false, 2);
    announced.length = 0;
    await show(true, 2);
    expect(announced).toEqual(["Loading your media…", mediaCountLine(4)]);
  });
});
