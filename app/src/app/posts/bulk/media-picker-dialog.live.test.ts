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

async function show(open: boolean) {
  await act(async () => {
    root.render(
      createElement(MediaPickerDialog, {
        workspaceId: "ws-1",
        open,
        onOpenChange: () => {},
        addedIds: new Set<string>(),
        room: 20,
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
