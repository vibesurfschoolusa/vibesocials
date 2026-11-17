import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * R45 pages-b L1: the Google post fields had maxLength, so a pasted event
 * title went to Google cut mid-word without a word. The paste now stays whole
 * with a count, and while a field is over the browser's own check refuses
 * Create's press on it, with the box's sentence (setCustomValidity), so
 * nothing is sent.
 */

const { announced } = vi.hoisted(() => ({ announced: [] as string[] }));
vi.mock("@/components/ui/announcer", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/ui/announcer")>()),
  useAnnounce: () => (text: string) => announced.push(text),
}));
// The fake DOM has no <select> options list; the type and button pickers are not under test here.
vi.mock("@/components/ui/select", () => ({ Select: () => null }));

import { makeDocument, type FakeNode } from "@/components/shell/fakeDom.testkit";
import { parseGooglePostMetadata } from "@/lib/googlePostOptions";
import type { GoogleBusinessPostMetadata } from "@/server/platforms/types";

import { GooglePostSettings } from "./google-post-settings";

let root: Root;
let container: FakeNode;
let validity: Map<string, string>;

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

async function show(metadata: GoogleBusinessPostMetadata) {
  await act(async () => {
    root.render(createElement(GooglePostSettings, { metadata, onChange: () => {} }));
  });
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const made = makeDocument();
  container = made.container;
  validity = new Map();
  announced.length = 0;
  // Fields made from now on keep what setCustomValidity was given, by id.
  const doc = made.doc as unknown as { createElement: (tag: string) => FakeNode };
  const make = doc.createElement.bind(doc);
  doc.createElement = (tag: string) => {
    const element = make(tag) as FakeNode & { setCustomValidity?: (text: string) => void };
    element.setCustomValidity = (text: string) => validity.set(String(element.attributes.id), text);
    return element;
  };
  vi.stubGlobal("document", made.doc);
  vi.stubGlobal("window", made.doc.defaultView);
  root = createRoot(container as unknown as HTMLElement);
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});

const TITLE = "Summer Surf Camp Open Day: free lessons for kids at Dania Beach";
const event = (title: string): GoogleBusinessPostMetadata => ({
  postType: "event",
  event: { title, startDate: "2026-12-01", endDate: "2026-12-01" },
});
const offer = (fields: { title?: string; couponCode?: string; terms?: string }): GoogleBusinessPostMetadata => ({
  postType: "offer",
  offer: { title: fields.title ?? "Winter deal", startDate: "2026-12-01", endDate: "2026-12-02", couponCode: fields.couponCode, terms: fields.terms },
});

describe("Google post fields: a paste longer than Google takes", () => {
  it("an event title stays whole, is counted, and refuses the press with the box's sentence", async () => {
    expect(TITLE.length).toBe(63);
    await show(event(TITLE));
    const field = byId("google-event-title");
    expect(props(field).maxLength).toBeUndefined();
    expect(props(field).value).toBe(TITLE);
    const count = byId(String(props(field)["aria-describedby"]));
    expect(count.textContent).toBe("63 of 58 characters (5 over). Shorten it to post to Google.");

    const check = parseGooglePostMetadata(event(TITLE));
    expect(check).toEqual({ ok: false, error: "The event title must be 58 characters or fewer." });
    expect(validity.get("google-event-title")).toBe("The event title must be 58 characters or fewer.");
  });

  it("the offer title, coupon and terms each refuse with their own sentence", async () => {
    await show(offer({ title: "x".repeat(59) }));
    expect(validity.get("google-offer-title")).toBe("The offer title must be 58 characters or fewer.");
    expect(props(byId("google-offer-title")).maxLength).toBeUndefined();

    await show(offer({ couponCode: "C".repeat(59) }));
    expect(validity.get("google-offer-title")).toBe("");
    expect(validity.get("google-offer-coupon")).toBe("The coupon code must be 58 characters or fewer.");
    expect(props(byId("google-offer-coupon")).maxLength).toBeUndefined();

    const terms = "t".repeat(5001);
    await show(offer({ terms }));
    expect(validity.get("google-offer-coupon")).toBe("");
    expect(validity.get("google-offer-terms")).toBe("The terms and conditions must be 5,000 characters or fewer.");
    expect(parseGooglePostMetadata(offer({ terms }))).toEqual({
      ok: false,
      error: "The terms and conditions must be 5,000 characters or fewer.",
    });
    expect(props(byId("google-offer-terms")).maxLength).toBeUndefined();
  });

  it("counts trimmed text, as the check does", async () => {
    await show(event(`  ${"x".repeat(58)}  `));
    expect(byId(String(props(byId("google-event-title"))["aria-describedby"])).textContent).toBe("58 of 58 characters");
    expect(validity.get("google-event-title")).toBe("");
  });

  it("under the limit: nothing is refused", async () => {
    await show(event("Full moon paddle"));
    expect(validity.get("google-event-title")).toBe("");
    expect(byId(String(props(byId("google-event-title"))["aria-describedby"])).textContent).toBe("16 of 58 characters");
  });
});

// R45 lead review: the count's announcement and the box's alert line both
// said a field went over. The count says it; the alert line keeps the rest.
describe("Google post fields: going over is said once", () => {
  const alertText = () => find(container, (n) => n.attributes.role === "alert")?.textContent ?? null;

  it("crossing the limit: one announcement, and no alert line for it", async () => {
    await show(event("Full moon paddle"));
    await show(event(TITLE));
    expect(announced).toEqual(["Event title: 5 characters over the limit."]);
    expect(alertText()).toBeNull();
    // The press is still refused with the box's sentence.
    expect(validity.get("google-event-title")).toBe("The event title must be 58 characters or fewer.");
  });

  it("another problem still shows in the alert line while a field is over", async () => {
    await show({ postType: "event", event: { title: TITLE, startDate: "2026-12-02", endDate: "2026-12-01" } });
    expect(alertText()).toBe("The event end date can't be before its start date.");
  });
});
