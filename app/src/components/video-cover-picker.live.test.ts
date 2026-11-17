import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * R45 new-customer L2: the uploaded cover's preview was the picker's own
 * state, made only when a file was picked. Add many unmounts the picker when
 * its panel closes, so reopening "Change cover" showed "No file chosen" and
 * no image while the row still kept the file. The preview now comes from the
 * chosen file itself, and its object URL is freed on change and on unmount.
 */

import { makeDocument, type FakeNode } from "@/components/shell/fakeDom.testkit";
import type { CoverChoice } from "@/lib/videoCover";

import { VideoCoverPicker } from "./video-cover-picker";

let root: Root;
let container: FakeNode;
let made: string[];
let revoked: string[];

function find(node: FakeNode, test: (n: FakeNode) => boolean): FakeNode | null {
  if (test(node)) return node;
  for (const child of node.childNodes) {
    const hit = find(child, test);
    if (hit) return hit;
  }
  return null;
}

function props(node: FakeNode): Record<string, (arg?: unknown) => unknown> & Record<string, unknown> {
  const key = Object.keys(node).find((k) => k.startsWith("__reactProps$"));
  return node[key as string] as Record<string, (arg?: unknown) => unknown> & Record<string, unknown>;
}

const preview = () => find(container, (n) => n.nodeName === "IMG");

async function show(value: CoverChoice, onChange: (choice: CoverChoice) => void = () => {}) {
  await act(async () => {
    root.render(createElement(VideoCoverPicker, { videoUrl: "blob:video", durationSec: 12, value, onChange }));
  });
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const dom = makeDocument();
  container = dom.container;
  vi.stubGlobal("document", dom.doc);
  vi.stubGlobal("window", dom.doc.defaultView);
  made = [];
  revoked = [];
  vi.spyOn(URL, "createObjectURL").mockImplementation((file) => {
    const url = `blob:${(file as File).name}-${made.length + 1}`;
    made.push(url);
    return url;
  });
  vi.spyOn(URL, "revokeObjectURL").mockImplementation((url) => {
    revoked.push(url);
  });
  root = createRoot(container as unknown as HTMLElement);
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const jpeg = (name: string) => new File(["x"], name, { type: "image/jpeg" });

describe("Change cover: the chosen image", () => {
  it("pick, close, reopen: the preview and the file name show", async () => {
    let chosen: CoverChoice = { kind: "default" };
    await show(chosen, (choice) => (chosen = choice));
    const upload = find(container, (n) => n.nodeName === "INPUT" && props(n)?.value === "upload")!;
    await act(async () => {
      props(upload).onChange();
    });
    const field = find(container, (n) => n.attributes.id === "video-cover-file")!;
    await act(async () => {
      props(field).onChange({ target: { files: [jpeg("cover.jpg")] } });
    });
    expect(chosen.kind).toBe("upload");
    await show(chosen);
    expect(preview()?.attributes.src).toBe(made.at(-1));
    expect(container.textContent).toContain("cover.jpg");

    // Done: the panel and the picker go. Reopened with the row's choice.
    await act(async () => root.unmount());
    root = createRoot(container as unknown as HTMLElement);
    await show(chosen);
    expect(preview()?.attributes.src).toBe(made.at(-1));
    expect(container.textContent).toContain("cover.jpg");
  });

  it("a new file frees the old preview", async () => {
    await show({ kind: "upload", file: jpeg("first.jpg") });
    const first = preview()?.attributes.src as string;
    expect(first).toBeTruthy();
    await show({ kind: "upload", file: jpeg("second.jpg") });
    expect(revoked).toContain(first);
    expect(preview()?.attributes.src).not.toBe(first);
    expect(container.textContent).toContain("second.jpg");
  });

  it("closing frees the preview", async () => {
    await show({ kind: "upload", file: jpeg("cover.jpg") });
    const url = preview()?.attributes.src as string;
    await act(async () => root.unmount());
    root = createRoot(container as unknown as HTMLElement);
    expect(revoked).toContain(url);
  });
});
