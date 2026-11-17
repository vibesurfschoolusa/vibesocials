import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * R40 client-journey L1/L2: the report's Try again goes with the failure it
 * answers, so focus fell to the page body; and a 429 kept Try again under a
 * sentence that says to wait. Mounted with the page's focus keeper.
 */

// The shared report is not under test: a stand-in with its h1.
vi.mock("@/components/reports/monthly-report", async () => {
  const { createElement: make } = await import("react");
  return {
    MonthlyReportView: ({ report }: { report: { month: string } }) =>
      make("article", null, make("div", null, make("h1", null, `Report ${report.month}`))),
  };
});

import { makeDocument, type FakeNode } from "@/components/shell/fakeDom.testkit";
import { makeFocusable, type FocusDoc } from "@/lib/focusDom.testkit";
import { installKeeperOnFakePage } from "@/lib/focusKeeperDom.testkit";

import { ClientReportView } from "./client-report-view";

const UNCHECKED = "We couldn't check that just now. Nothing was changed. Try again in a minute.";
const REPORT = { month: "2026-10", workspaceName: "Surf Co", logoUrl: null, inProgress: false, postCount: 0, posts: [] };

let root: Root;
let container: FakeNode;
let doc: FocusDoc;
let terms: FakeNode;
let stopKeeper: () => void;
const fetchMock = vi.fn();

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

async function settle() {
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

function deferred() {
  let resolve!: (value: Response) => void;
  const promise = new Promise<Response>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const made = makeDocument();
  container = made.container;
  doc = made.doc as unknown as FocusDoc;
  makeFocusable(doc);
  const keeper = installKeeperOnFakePage(made as never);
  terms = keeper.terms;
  stopKeeper = keeper.stop;
  vi.stubGlobal("window", made.doc.defaultView);
  vi.stubGlobal("document", made.doc);
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  root = createRoot(container as unknown as HTMLElement);
});

afterEach(async () => {
  await act(async () => root.unmount());
  stopKeeper();
  vi.unstubAllGlobals();
});

async function mount() {
  await act(async () => {
    root.render(createElement(ClientReportView, { token: "tok", month: "2026-10" }));
  });
  await settle();
}

async function failedThenRetry(next: Response): Promise<void> {
  const later = deferred();
  fetchMock
    .mockReturnValueOnce(Promise.resolve(Response.json({ error: UNCHECKED }, { status: 503 })))
    .mockReturnValueOnce(later.promise);
  await mount();
  const retry = find(container, (n) => n.nodeName === "BUTTON" && (n.textContent as string).trim() === "Try again")!;
  expect(retry).not.toBeNull();
  (retry.focus as () => void)();
  await act(async () => {
    void props(retry).onClick();
  });
  await settle();

  const status = doc.activeElement as FakeNode;
  expect(status.attributes.role).toBe("status");
  expect(status.textContent).toBe("Loading the report…");

  await act(async () => {
    later.resolve(next);
  });
  await settle();
}

describe("/v report: focus after Try again", () => {
  it("goes to the loading line, then to the report's heading", async () => {
    await failedThenRetry(Response.json(REPORT));
    const active = doc.activeElement as FakeNode;
    expect(active.nodeName).toBe("H1");
    expect(active.textContent).toBe("Report 2026-10");
  });

  it("goes to the loading line, then to the new failure", async () => {
    await failedThenRetry(Response.json({ error: UNCHECKED }, { status: 503 }));
    const active = doc.activeElement as FakeNode;
    expect(active.attributes.role).toBe("alert");
    expect(active.textContent).toBe(UNCHECKED);
    expect(active).not.toBe(terms);
  });
});

describe("/v report: the network limit", () => {
  it("shows one instruction from Retry-After and no button", async () => {
    fetchMock.mockReturnValueOnce(
      Promise.resolve(
        Response.json(
          { error: "Too many requests from this network in the last hour. Try again later.", retryAfterSeconds: 300 },
          { status: 429, headers: { "Retry-After": "300" } },
        ),
      ),
    );
    await mount();
    expect(container.textContent).toBe(
      "Monthly reportToo many requests from this network in the last hour. Reload this page in 5 minutes.",
    );
    expect(find(container, (n) => n.nodeName === "BUTTON")).toBeNull();
  });
});
