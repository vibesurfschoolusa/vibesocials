import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * R43 pages-a L5: the month heading wasn't announced, so after Next or
 * Previous month a screen-reader user didn't know which month was shown. The
 * new label goes through the page's shared announcer; the first one doesn't.
 */

vi.mock("next/navigation", () => ({ usePathname: () => "/queue" }));

import { makeDocument, type FakeNode } from "@/components/shell/fakeDom.testkit";
import { AnnouncerProvider } from "@/components/ui/announcer";
import { ToastProvider } from "@/components/ui/toast";

import { QueueCalendar } from "./queue-calendar";

let root: Root;
let container: FakeNode;

function find(node: FakeNode, test: (n: FakeNode) => boolean): FakeNode | null {
  if (test(node)) return node;
  for (const child of node.childNodes) {
    const hit = find(child, test);
    if (hit) return hit;
  }
  return null;
}

function attr(node: FakeNode, name: string): string | null {
  return (node as unknown as { getAttribute(n: string): string | null }).getAttribute(name);
}

function props(node: FakeNode): Record<string, (arg?: unknown) => unknown> {
  const key = Object.keys(node).find((k) => k.startsWith("__reactProps$"));
  return node[key as string] as Record<string, (arg?: unknown) => unknown>;
}

// The page's announcer region (the toasts have a polite region of their own).
const region = () =>
  find(container, (n) => n.nodeName === "DIV" && attr(n, "aria-live") === "polite" && attr(n, "aria-atomic") === "true")!;
const labelled = (label: string) => find(container, (n) => n.nodeName === "BUTTON" && attr(n, "aria-label") === label)!;
const monthOf = (offset: number) => {
  const now = new Date();
  return new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" }).format(
    new Date(now.getFullYear(), now.getMonth() + offset, 1),
  );
};

async function settle(ms = 150) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const made = makeDocument();
  container = made.container;
  // The announcer sets its text on a later tick through window.setTimeout.
  Object.assign(made.doc.defaultView as object, { setTimeout, clearTimeout });
  vi.stubGlobal("window", made.doc.defaultView);
  vi.stubGlobal("document", made.doc);
  root = createRoot(container as unknown as HTMLElement);
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});

async function mount() {
  await act(async () => {
    root.render(
      createElement(
        AnnouncerProvider,
        null,
        createElement(
          ToastProvider,
          null,
          createElement(QueueCalendar, { jobs: [], onShowList: () => {}, onEdit: () => {}, onRescheduled: () => {} }),
        ),
      ),
    );
  });
  await settle();
}

describe("Queue calendar: the month is announced when it changes", () => {
  it("the first month is not read out on load", async () => {
    await mount();
    expect(region().textContent).toBe("");
  });

  it("Next month announces the new month, and Previous month the one before", async () => {
    await mount();
    await act(async () => {
      void props(labelled("Next month")).onClick();
    });
    await settle();
    expect(region().textContent).toBe(monthOf(1));

    await act(async () => {
      void props(labelled("Previous month")).onClick();
    });
    await settle();
    expect(region().textContent).toBe(monthOf(0));
  });
});
