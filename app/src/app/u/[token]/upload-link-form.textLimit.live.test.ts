import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * R45 pages-a L3: the name and note had maxLength 200, so a pasted note was
 * cut without a word and the owner got half the instructions. The paste now
 * stays whole, a count says how long it is, and Send is refused while either
 * is over, with its sentence, and nothing is sent.
 */

const { sent, tried, refuseNext } = vi.hoisted(() => ({
  sent: [] as { senderName: string; note: string }[],
  tried: [] as { file: string; senderName: string; note: string }[],
  refuseNext: { message: null as string | null },
}));
vi.mock("./send-file", async (importOriginal) => {
  const real = await importOriginal<typeof import("./send-file")>();
  return {
    ...real,
    sendClientFile: vi.fn(async (input: { file: File; senderName: string; note: string }) => {
      tried.push({ file: input.file.name, senderName: input.senderName, note: input.note });
      if (refuseNext.message) {
        const message = refuseNext.message;
        refuseNext.message = null;
        throw new real.ClientFileError("refused", message);
      }
      sent.push({ senderName: input.senderName, note: input.note });
    }),
  };
});
vi.mock("@/components/ui/announcer", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/ui/announcer")>()),
  useAnnounce: () => () => {},
}));

import { makeDocument, type FakeNode } from "@/components/shell/fakeDom.testkit";
import { makeFocusable, type FocusDoc } from "@/lib/focusDom.testkit";
import { UPLOAD_LINK_TEXT_MAX, cleanSenderText } from "@/lib/uploadLink";

import { UPLOAD_NAME_TOO_LONG_TEXT, UPLOAD_NOTE_TOO_LONG_TEXT, UploadLinkForm } from "./upload-link-form";

let root: Root;
let container: FakeNode;
let doc: FocusDoc;

function find(node: FakeNode, test: (n: FakeNode) => boolean): FakeNode | null {
  if (test(node)) return node;
  for (const child of node.childNodes) {
    const hit = find(child, test);
    if (hit) return hit;
  }
  return null;
}

function byId(id: string): FakeNode {
  const hit = find(container, (n) => n.attributes.id === id);
  if (!hit) throw new Error(`no #${id}`);
  return hit;
}

function props(node: FakeNode): Record<string, (arg?: unknown) => unknown> & Record<string, unknown> {
  const key = Object.keys(node).find((k) => k.startsWith("__reactProps$"));
  return node[key as string] as Record<string, (arg?: unknown) => unknown> & Record<string, unknown>;
}

async function settle() {
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function type(id: string, value: string) {
  await act(async () => {
    props(byId(id)).onChange({ target: { value } });
  });
}

async function pickPhoto() {
  const file = new File(["x"], "beach.jpg", { type: "image/jpeg", lastModified: 1 });
  await act(async () => {
    props(byId("upload-link-files")).onChange({ target: { files: [file], value: "" } });
  });
}

async function send() {
  const form = find(container, (n) => n.nodeName === "FORM")!;
  await act(async () => {
    void props(form).onSubmit({ preventDefault() {}, nativeEvent: { submitter: null }, currentTarget: form });
  });
  await settle();
}

beforeEach(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const made = makeDocument();
  container = made.container;
  doc = made.doc as unknown as FocusDoc;
  makeFocusable(doc);
  vi.stubGlobal("document", made.doc);
  const view = made.doc.defaultView as unknown as Record<string, unknown>;
  view.requestAnimationFrame = (run: () => void) => setTimeout(run, 0);
  view.cancelAnimationFrame = (id: number) => clearTimeout(id);
  view.setTimeout = setTimeout;
  view.clearTimeout = clearTimeout;
  vi.stubGlobal("window", view);
  vi.stubGlobal("requestAnimationFrame", view.requestAnimationFrame);
  vi.stubGlobal("cancelAnimationFrame", view.cancelAnimationFrame);
  URL.createObjectURL = () => "blob:preview";
  URL.revokeObjectURL = () => {};
  sent.length = 0;
  tried.length = 0;
  refuseNext.message = null;
  root = createRoot(container as unknown as HTMLElement);
  await act(async () => {
    root.render(createElement(UploadLinkForm, { token: "t" }));
  });
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});

const LONG_NOTE = `Please use the sunset ones first. ${"Then the group shots by the pier, ".repeat(8)}`.trim();

describe("/u: a name or note longer than 200 characters", () => {
  it("a pasted note stays whole, and the count says how long it is", async () => {
    expect(LONG_NOTE.length).toBeGreaterThan(UPLOAD_LINK_TEXT_MAX);
    const note = byId("upload-link-note");
    expect(props(note).maxLength).toBeUndefined();
    expect(props(byId("upload-link-name")).maxLength).toBeUndefined();
    await type("upload-link-note", LONG_NOTE);
    expect(props(byId("upload-link-note")).value).toBe(LONG_NOTE);
    const count = byId(String(props(note)["aria-describedby"]));
    const over = LONG_NOTE.length - 200;
    expect(count.textContent).toBe(`${LONG_NOTE.length} of 200 characters (${over} over). Shorten it to send.`);
  });

  it("Send is refused: nothing is sent, the sentence shows and the note takes the focus", async () => {
    await pickPhoto();
    await type("upload-link-note", LONG_NOTE);
    await send();
    expect(sent).toEqual([]);
    const alert = find(container, (n) => n.attributes.role === "alert" && n.textContent === UPLOAD_NOTE_TOO_LONG_TEXT);
    expect(alert).not.toBeNull();
    expect(doc.activeElement).toBe(byId("upload-link-note"));
  });

  it("the name counts on one line, as the route stores it", async () => {
    await pickPhoto();
    const name = `${"a".repeat(100)}\n\n\n${"b".repeat(99)}`;
    // Stored as 100 + 1 + 99: fits.
    expect(cleanSenderText(name, { singleLine: true })).toHaveLength(200);
    await type("upload-link-name", name);
    expect(byId(String(props(byId("upload-link-name"))["aria-describedby"])).textContent).toBe("200 of 200 characters");
    await type("upload-link-name", `${name}c`);
    await send();
    expect(sent).toEqual([]);
    expect(container.textContent).toContain(UPLOAD_NAME_TOO_LONG_TEXT);
    expect(doc.activeElement).toBe(byId("upload-link-name"));
  });

  it("under the limit: sent as before, with no sentence", async () => {
    await pickPhoto();
    await type("upload-link-name", "Maria");
    await type("upload-link-note", "a".repeat(200));
    await send();
    expect(sent).toEqual([{ senderName: "Maria", note: "a".repeat(200) }]);
    expect(container.textContent).not.toContain(UPLOAD_NOTE_TOO_LONG_TEXT);
  });
});

// R45 lead review: a refused try says to wait, then press the retry button,
// which sends the same files with the name and note kept.
describe("/u: after a limit refusal", () => {
  it("the retry button sends the same file, with the name and note kept", async () => {
    refuseNext.message = "Too many files from this network in the last hour. Wait 12 minutes, then try the files that didn't send.";
    await pickPhoto();
    await type("upload-link-name", "Maria");
    await type("upload-link-note", "Sunset ones first");
    await send();
    expect(sent).toEqual([]);
    const retry = find(container, (n) => n.nodeName === "BUTTON" && (n.textContent as string).trim() === "Try the file that didn't send");
    expect(retry).not.toBeNull();
    expect(props(retry!).type).toBe("submit");

    await send();
    expect(tried).toEqual([
      { file: "beach.jpg", senderName: "Maria", note: "Sunset ones first" },
      { file: "beach.jpg", senderName: "Maria", note: "Sunset ones first" },
    ]);
    expect(sent).toEqual([{ senderName: "Maria", note: "Sunset ones first" }]);
  });
});
