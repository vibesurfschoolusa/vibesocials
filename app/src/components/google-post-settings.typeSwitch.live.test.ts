import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * R67 pages-a-3 L4: switching the post type wiped the event or offer details
 * already typed; only the button came back. What was typed for each type is
 * now kept across a switch, and the options passed up (what Create sends)
 * still hold only the chosen type's fields.
 */

// The fake DOM has no <select> options list: the picker is a plain element
// whose onChange the test calls as the browser would.
vi.mock("@/components/ui/select", async () => {
  const { createElement: make } = await import("react");
  return {
    Select: (props: Record<string, unknown>) => make("div", { ...props, children: undefined }),
  };
});

import { makeDocument, type FakeNode } from "@/components/shell/fakeDom.testkit";
import type { GoogleBusinessPostMetadata } from "@/server/platforms/types";

import { GooglePostSettings, NO_GOOGLE_TYPE_MEMORY, type GoogleTypeMemory } from "./google-post-settings";

let root: Root;
let container: FakeNode;
let sent: GoogleBusinessPostMetadata[];

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

function props(node: FakeNode): Record<string, unknown> {
  const key = Object.keys(node).find((k) => k.startsWith("__reactProps$"));
  return node[key as string] as Record<string, unknown>;
}

function value(id: string): unknown {
  return props(byId(id)).value;
}

async function type(id: string, text: string) {
  await act(async () => {
    (props(byId(id)).onChange as (e: { target: { value: string } }) => void)({ target: { value: text } });
  });
}

async function choose(postType: GoogleBusinessPostMetadata["postType"]) {
  await type("google-post-type", postType);
}

/** Holds the memory as Create does (R68 pages-b L1): the box keeps none of its own. */
function Host({ initial }: { initial: GoogleBusinessPostMetadata }) {
  const [metadata, setMetadata] = useState(initial);
  const [memory, setMemory] = useState<GoogleTypeMemory>({ fields: {}, button: initial.button });
  return createElement(GooglePostSettings, {
    metadata,
    memory,
    onMemoryChange: setMemory,
    onChange: (next: GoogleBusinessPostMetadata) => {
      sent.push(next);
      setMetadata(next);
    },
  });
}

async function show(initial: GoogleBusinessPostMetadata) {
  await act(async () => {
    root.render(createElement(Host, { initial }));
  });
}

const last = () => sent[sent.length - 1];

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const made = makeDocument();
  container = made.container;
  sent = [];
  // The fields call setCustomValidity, which the fake DOM lacks.
  const doc = made.doc as unknown as { createElement: (tag: string) => FakeNode };
  const make = doc.createElement.bind(doc);
  doc.createElement = (tag: string) => Object.assign(make(tag), { setCustomValidity: () => {} });
  vi.stubGlobal("document", made.doc);
  vi.stubGlobal("window", made.doc.defaultView);
  root = createRoot(container as unknown as HTMLElement);
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});

describe("GooglePostSettings: switching the post type keeps what was typed", () => {
  it("Event typed, then Offer, then Event: the event's title, dates and times come back", async () => {
    await show({ postType: "event", event: { title: "", startDate: "", endDate: "" } });
    await type("google-event-title", "Full moon paddle");
    await type("google-event-start-date", "2026-12-04");
    await type("google-event-start-time", "18:00");
    await type("google-event-end-date", "2026-12-04");

    await choose("offer");
    expect(value("google-offer-title")).toBe("");
    await choose("event");

    expect(value("google-event-title")).toBe("Full moon paddle");
    expect(value("google-event-start-date")).toBe("2026-12-04");
    expect(value("google-event-start-time")).toBe("18:00");
    expect(value("google-event-end-date")).toBe("2026-12-04");
  });

  it("Offer typed (title, dates, coupon, terms), then Update, then Offer: the offer comes back", async () => {
    await show({ postType: "offer", offer: { title: "", startDate: "", endDate: "" } });
    await type("google-offer-title", "Winter wetsuit sale");
    await type("google-offer-start-date", "2026-12-01");
    await type("google-offer-end-date", "2026-12-24");
    await type("google-offer-coupon", "SURF20");
    await type("google-offer-terms", "One per customer.");

    await choose("update");
    await choose("offer");

    expect(value("google-offer-title")).toBe("Winter wetsuit sale");
    expect(value("google-offer-start-date")).toBe("2026-12-01");
    expect(value("google-offer-end-date")).toBe("2026-12-24");
    expect(value("google-offer-coupon")).toBe("SURF20");
    expect(value("google-offer-terms")).toBe("One per customer.");
  });

  it("the options passed up hold only the chosen type's fields", async () => {
    await show({ postType: "event", event: { title: "", startDate: "", endDate: "" } });
    await type("google-event-title", "Full moon paddle");
    await choose("offer");
    await type("google-offer-title", "Deal");

    await choose("update");
    expect(last()).toEqual({ postType: "update" });
    await choose("offer");
    expect(last()).toEqual({ postType: "offer", offer: { title: "Deal", startDate: "", endDate: "" } });
    await choose("event");
    expect(last()).toEqual({ postType: "event", event: { title: "Full moon paddle", startDate: "", endDate: "" } });
  });

  it("without a memory from its caller, a switch keeps nothing", async () => {
    let shown: GoogleBusinessPostMetadata = { postType: "event", event: { title: "Paddle", startDate: "", endDate: "" } };
    const render = () =>
      root.render(
        createElement(GooglePostSettings, {
          metadata: shown,
          onChange: (next: GoogleBusinessPostMetadata) => {
            shown = next;
            render();
          },
        }),
      );
    await act(async () => render());
    await choose("offer");
    await choose("event");
    expect(shown).toEqual({ postType: "event", event: { title: "", startDate: "", endDate: "" } });
    expect(NO_GOOGLE_TYPE_MEMORY).toEqual({ fields: {}, button: undefined });
  });

  it("the button round trip through Offer is as before", async () => {
    const book = { type: "BOOK" as const, url: "https://e.com/book" };
    await show({ postType: "update", button: book });

    await choose("offer");
    expect(last().button).toBeUndefined();
    await choose("event");

    expect(last()).toEqual({ postType: "event", event: { title: "", startDate: "", endDate: "" }, button: book });
  });
});
