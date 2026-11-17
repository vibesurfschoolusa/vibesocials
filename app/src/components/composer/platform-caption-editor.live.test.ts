import { act, createElement, useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { makeDocument, type FakeNode } from "@/components/shell/fakeDom.testkit";
import { ToastProvider } from "@/components/ui/toast";
import type { PlatformOverrides } from "@/lib/platformOverrides";
import { PlatformCaptionEditor } from "./platform-caption-editor";

/**
 * R38 new-customer M1: "Adapt for {platform}" writes its answer only while that
 * platform's own text is as it was at the press, and (on Create) the form has
 * not been saved or reset since. The box stays editable while it runs.
 */

let root: Root;
let container: FakeNode;
let overridesNow: PlatformOverrides | null = null;
let setOverridesNow: (next: PlatformOverrides | null) => void = () => {};
let generation = 0;

type Pending = { resolve: (body: unknown) => void };
let pending: Pending[] = [];
const fetchMock = vi.fn(
  () =>
    new Promise<Response>((resolve) => {
      pending.push({ resolve: (body) => resolve(Response.json(body)) });
    }),
);

function Harness({ initial, withGeneration }: { initial: PlatformOverrides; withGeneration: boolean }) {
  const [overrides, setOverrides] = useState<PlatformOverrides | null>(initial);
  useEffect(() => {
    overridesNow = overrides;
    setOverridesNow = setOverrides;
  }, [overrides]);
  return createElement(
    ToastProvider,
    null,
    createElement(PlatformCaptionEditor, {
      idPrefix: "t",
      platforms: ["x", "linkedin"],
      caption: "Main caption",
      overrides,
      onChange: (update) => setOverrides(update),
      workspaceId: "ws-1",
      ...(withGeneration ? { formGeneration: () => generation } : {}),
    }),
  );
}

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

function adaptButton(label: string): FakeNode {
  const hit = find(container, (n) => n.nodeName === "BUTTON" && (n.textContent as string).includes(`Adapt for ${label}`));
  if (!hit) throw new Error(`no Adapt for ${label}`);
  return hit;
}

async function mount(initial: PlatformOverrides, withGeneration = false) {
  await act(async () => {
    root.render(createElement(Harness, { initial, withGeneration }));
  });
}

async function pressAdapt(label: string) {
  await act(async () => {
    void props(adaptButton(label)).onClick();
  });
}

async function type(platform: string, value: string) {
  const box = find(container, (n) => n.nodeName === "TEXTAREA" && n.attributes.id === `t-${platform}-caption`);
  if (!box) throw new Error(`no box for ${platform}`);
  await act(async () => {
    props(box).onChange({ target: { value } });
  });
}

async function answer(text: string) {
  await act(async () => {
    pending.shift()?.resolve({ enhancedCaption: text });
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const made = makeDocument();
  container = made.container;
  vi.stubGlobal("window", made.doc.defaultView);
  vi.stubGlobal("document", made.doc);
  pending = [];
  generation = 0;
  fetchMock.mockClear();
  vi.stubGlobal("fetch", fetchMock);
  root = createRoot(container as unknown as HTMLElement);
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});

describe("Adapt for X: a late answer", () => {
  it("a normal Adapt writes X's caption", async () => {
    await mount({ x: "Surf lesson today" });
    await pressAdapt("X");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await answer("Surf today!");
    expect(overridesNow).toEqual({ x: "Surf today!" });
  });

  it("text typed in X's box during the call is kept and the answer dropped", async () => {
    await mount({ x: "Surf lesson today" });
    await pressAdapt("X");
    await type("x", "Surf lesson today #sunset");
    await answer("Surf today!");
    expect(overridesNow).toEqual({ x: "Surf lesson today #sunset" });
  });

  it("another platform's text typed meanwhile is kept, and X's answer lands", async () => {
    await mount({ x: "Surf lesson today", linkedin: "Hello" });
    await pressAdapt("X");
    await type("linkedin", "Hello there");
    await answer("Surf today!");
    expect(overridesNow).toEqual({ x: "Surf today!", linkedin: "Hello there" });
  });

  it("X's own text empty at the press (the main caption is adapted): the answer fills it", async () => {
    await mount({ x: "" });
    await pressAdapt("X");
    await answer("Main, for X");
    expect(overridesNow).toEqual({ x: "Main, for X" });
  });

  it("the form was saved and reset meanwhile (a new generation): the answer is dropped", async () => {
    await mount({ x: "" }, true);
    await pressAdapt("X");
    // Saving resets the form; the next post switches X on again, still empty.
    await act(async () => {
      generation += 1;
      setOverridesNow({ x: "" });
    });
    await answer("Main, for X");
    expect(overridesNow).toEqual({ x: "" });
  });

  it("with the same generation, an answer still lands", async () => {
    await mount({ x: "Old" }, true);
    await pressAdapt("X");
    await answer("New");
    expect(overridesNow).toEqual({ x: "New" });
  });
});
