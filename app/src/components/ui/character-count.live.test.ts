import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * R44 new-customer L3: the count under a name field. Crossing the limit is
 * said once each way, never on every key.
 */

const { announce } = vi.hoisted(() => ({ announce: vi.fn() }));
vi.mock("@/components/ui/announcer", () => ({ useAnnounce: () => announce }));

import { makeDocument, type FakeNode } from "@/components/shell/fakeDom.testkit";

import { CharacterCount } from "./character-count";

let root: Root;
let container: FakeNode;

async function show(length: number) {
  await act(async () => {
    root.render(createElement(CharacterCount, { id: "c", label: "Workspace name", text: "x".repeat(length), max: 60 }));
  });
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const made = makeDocument();
  container = made.container;
  vi.stubGlobal("document", made.doc);
  vi.stubGlobal("window", made.doc.defaultView);
  announce.mockReset();
  root = createRoot(container as unknown as HTMLElement);
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});

describe("CharacterCount", () => {
  it("says the count, and how far over with what to do", async () => {
    await show(12);
    expect(container.textContent).toBe("12 of 60 characters");
    await show(66);
    expect(container.textContent).toBe("66 of 60 characters (6 over). Shorten it to save.");
  });

  it("announces crossing the limit once each way", async () => {
    await show(59);
    await show(60);
    expect(announce).not.toHaveBeenCalled();
    await show(61);
    await show(66);
    expect(announce.mock.calls).toEqual([["Workspace name: 1 character over the limit."]]);
    await show(40);
    expect(announce.mock.calls.at(-1)).toEqual(["Workspace name: back under the limit."]);
    expect(announce).toHaveBeenCalledTimes(2);
  });

  it("counts trimmed text by default, or by the field's own rule", async () => {
    await act(async () => {
      root.render(createElement(CharacterCount, { id: "c", label: "Website", text: "  abc  ", max: 60 }));
    });
    expect(container.textContent).toBe("3 of 60 characters");
    await act(async () => {
      root.render(
        createElement(CharacterCount, {
          id: "c",
          label: "Name",
          text: " a   b ",
          max: 60,
          count: (text: string) => text.replace(/\s+/g, " ").trim().length,
        }),
      );
    });
    expect(container.textContent).toBe("3 of 60 characters");
  });

  // R44 lead review: one counter rule; the Settings footer uses this one.
  it("is the only copy of the rule: Settings has none of its own", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const settings = readFileSync(join(__dirname, "../settings-form.tsx"), "utf8");
    expect(settings).not.toContain("function FooterFieldCount");
    expect(settings).not.toContain("over the limit");
    expect(settings.match(/<CharacterCount /g)).toHaveLength(2);
  });

  it("an opening already over is not announced", async () => {
    await show(70);
    expect(announce).not.toHaveBeenCalled();
  });
});
