import { act, createElement, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { makeDocument, type FakeNode } from "@/components/shell/fakeDom.testkit";
import { useCaptionBox } from "./useCaptionBox";

/**
 * R37 lead review: Create's caption requests outlive the render that started
 * them (a pick's upload, a set's queue). Each test keeps the hook's API from
 * an earlier render, as runAutoCaptionFromMedia's closure does, and checks the
 * press and the answer read the box as it is now.
 */

type Box = ReturnType<typeof useCaptionBox>;
let root: Root;
let container: FakeNode;
let latest: Box;

function Harness({ onBox }: { onBox: (box: Box) => void }) {
  const box = useCaptionBox();
  useEffect(() => onBox(box));
  return null;
}

async function mount(): Promise<Box> {
  await act(async () => {
    root.render(createElement(Harness, { onBox: (box: Box) => { latest = box; } }));
  });
  return latest;
}

/** Runs a step as an event handler would, and renders. */
async function step(run: () => void) {
  await act(async () => {
    run();
  });
}

const fileA = new File(["a"], "a.jpg", { type: "image/jpeg" });
const fileB = new File(["b"], "b.jpg", { type: "image/jpeg" });
const fileC = new File(["c"], "c.jpg", { type: "image/jpeg" });

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const made = makeDocument();
  container = made.container;
  vi.stubGlobal("window", made.doc.defaultView);
  root = createRoot(container as unknown as HTMLElement);
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});

describe("Create's caption box: a press and its late answer", () => {
  it("pick A, its caption X lands, pick B: B's caption lands", async () => {
    let selected: unknown = fileA;
    const pickA = await mount();
    const pressA = pickA.pressed(selected);
    await step(() => pickA.answered(pressA, { caption: "X", selectedNow: selected, overwrite: false }));
    expect(latest.caption).toBe("X");

    // Pick B: the handler (an earlier render) drops X, then B's upload and
    // automatic caption run on in that same closure.
    const pickB = latest;
    await step(() => {
      pickB.forgetMediaCaption();
      selected = fileB;
    });
    expect(latest.caption).toBe("");
    const pressB = pickB.pressed(selected);
    await step(() => pickB.answered(pressB, { caption: "Y", selectedNow: selected, overwrite: false }));
    expect(latest.caption).toBe("Y");
    expect(latest.lastAiCaption).toBe("Y");
  });

  it("the same with a several-photos replace (the set's queue keeps the pick's closure)", async () => {
    let selected: unknown = fileA;
    const box = await mount();
    const pressA = box.pressed(selected);
    await step(() => box.answered(pressA, { caption: "X", selectedNow: selected, overwrite: false }));

    const replace = latest;
    await step(() => {
      replace.forgetMediaCaption();
      selected = fileB; // the new set's cover
    });
    // Several renders later the queue's first upload finishes.
    await step(() => latest.setCaption((current) => current));
    const pressSet = replace.pressed(selected);
    await step(() => replace.answered(pressSet, { caption: "Z", selectedNow: selected, overwrite: false }));
    expect(latest.caption).toBe("Z");
    expect(latest.lastAiCaption).toBe("Z");
  });

  it("the person types after the press: the answer is dropped", async () => {
    const box = await mount();
    const press = box.pressed(fileA);
    await step(() => latest.setCaption("My own words"));
    await step(() => box.answered(press, { caption: "X", selectedNow: fileA, overwrite: true }));
    expect(latest.caption).toBe("My own words");
  });

  it("Add photos mid-call (the single File becomes the set's cover): the caption lands", async () => {
    const box = await mount();
    const press = box.pressed(fileA);
    // selectedMediaOf gives the cover's File, which is still fileA.
    await step(() => box.answered(press, { caption: "X", selectedNow: fileA, overwrite: false }));
    expect(latest.caption).toBe("X");
  });

  it("dismiss a reused item mid-call: the answer is dropped", async () => {
    const item = { id: "m1" };
    const box = await mount();
    const press = box.pressed(item);
    await step(() => box.answered(press, { caption: "X", selectedNow: null, overwrite: true }));
    expect(latest.caption).toBe("");
  });

  it("lastAiCaption is unchanged when an answer is dropped", async () => {
    const box = await mount();
    const pressA = box.pressed(fileA);
    await step(() => box.answered(pressA, { caption: "X", selectedNow: fileA, overwrite: false }));
    await step(() => latest.setCaption("X, edited"));
    const pressStale = latest.pressed(fileB);
    await step(() => latest.answered(pressStale, { caption: "Y", selectedNow: fileC, overwrite: false }));
    expect(latest.caption).toBe("X, edited");
    expect(latest.lastAiCaption).toBe("X");
  });

  it("forgetMediaCaption clears only an unedited AI caption, read from the box as it is now", async () => {
    const box = await mount();
    const press = box.pressed(fileA);
    await step(() => box.answered(press, { caption: "X", selectedNow: fileA, overwrite: false }));
    await step(() => latest.setCaption("X, edited"));
    await step(() => box.forgetMediaCaption());
    expect(latest.caption).toBe("X, edited");
    expect(latest.lastAiCaption).toBe("X");
  });

  it("R38: the form is saved and reset after the press: the answer is dropped, even on an unchanged box", async () => {
    const box = await mount();
    const press = box.pressed(null);
    await step(() => box.formReset());
    await step(() => box.answered(press, { caption: "X", selectedNow: null, overwrite: true }));
    expect(latest.caption).toBe("");
    // A press after the reset still writes.
    const next = latest.pressed(null);
    await step(() => latest.answered(next, { caption: "Y", selectedNow: null, overwrite: true }));
    expect(latest.caption).toBe("Y");
  });

  it("R38: formGeneration moves on with each reset, read live", async () => {
    const box = await mount();
    const before = box.formGeneration();
    await step(() => box.formReset());
    expect(box.formGeneration()).toBe(before + 1);
  });

  it("R38: Improve's answer (not from media) writes the box but is not remembered as the media's caption", async () => {
    const box = await mount();
    await step(() => box.setCaption("My words"));
    const press = latest.pressed(null);
    await step(() => latest.answered(press, { caption: "Better words", selectedNow: null, overwrite: true, fromMedia: false }));
    expect(latest.caption).toBe("Better words");
    expect(latest.lastAiCaption).toBe(null);
  });
});
