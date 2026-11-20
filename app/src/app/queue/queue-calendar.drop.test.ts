import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * R49 pages-a L3: a drop onto a time under a minute away said "That time has
 * already passed". The calendar's move says the one too-soon sentence the
 * Queue's edit dialog, Create, Add many and PATCH say, by the same buffer.
 */

vi.mock("next/navigation", () => ({ usePathname: () => "/queue" }));

import { makeDocument, type FakeNode } from "@/components/shell/fakeDom.testkit";
import { AnnouncerProvider } from "@/components/ui/announcer";
import { ToastProvider } from "@/components/ui/toast";
import { buildCalendarMonth, localDayKey } from "@/lib/queueCalendar";
import { SCHEDULED_TIME_TOO_SOON_MESSAGE } from "@/lib/scheduling";

import { QueueCalendar } from "./queue-calendar";
import type { QueueCard } from "./pairActions";

let root: Root;
let container: FakeNode;

function findAll(node: FakeNode, test: (n: FakeNode) => boolean, out: FakeNode[] = []): FakeNode[] {
  if (test(node)) out.push(node);
  for (const child of node.childNodes) findAll(child, test, out);
  return out;
}

function props(node: FakeNode): Record<string, (arg?: unknown) => unknown> {
  const key = Object.keys(node).find((k) => k.startsWith("__reactProps$"));
  return (node[key as string] ?? {}) as Record<string, (arg?: unknown) => unknown>;
}

// "Today" is fixed at 20 Nov 2026, 14:59:20 local; only Date is faked so the
// toast and React keep their real timers.
const NOW = new Date(2026, 10, 20, 14, 59, 20);

function job(scheduledFor: Date): QueueCard {
  return {
    id: "j1",
    status: "scheduled",
    createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-01T00:00:00.000Z",
    scheduledFor: scheduledFor.toISOString(),
    caption: "Summer sale",
    platformCaptions: null,
    results: [],
    media: null,
    mediaCount: 1,
    publish: null,
    createdBy: null,
    approvalState: "none",
  } as QueueCard;
}

const onRescheduled = vi.fn<(card: QueueCard, patch: unknown, answer: unknown) => void>();
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const made = makeDocument();
  container = made.container;
  Object.assign(made.doc.defaultView as object, { setTimeout, clearTimeout });
  vi.stubGlobal("window", made.doc.defaultView);
  vi.stubGlobal("document", made.doc);
  fetchMock = vi.fn(async () => new Response(JSON.stringify({}), { status: 200, headers: { "Content-Type": "application/json" } }));
  vi.stubGlobal("fetch", fetchMock);
  onRescheduled.mockClear();
  root = createRoot(container as unknown as HTMLElement);
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function dragOnto(card: QueueCard, day: Date) {
  await act(async () => {
    root.render(
      createElement(
        AnnouncerProvider,
        null,
        createElement(
          ToastProvider,
          null,
          createElement(QueueCalendar, { jobs: [card], onShowList: () => {}, onEdit: () => {}, onRescheduled }),
        ),
      ),
    );
  });
  const chip = findAll(container, (n) => n.nodeName === "BUTTON" && typeof props(n).onDragStart === "function")[0]!;
  await act(async () => {
    props(chip).onDragStart({ dataTransfer: { setData: () => {}, effectAllowed: "" } });
  });
  const keys = buildCalendarMonth(NOW.getFullYear(), NOW.getMonth()).flat().map((d) => d.key);
  const cells = findAll(container, (n) => n.nodeName === "DIV" && typeof props(n).onDrop === "function");
  const cell = cells[keys.indexOf(localDayKey(day))]!;
  await act(async () => {
    props(cell).onDrop({ preventDefault: () => {} });
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

const alerts = () => findAll(container, (n) => n.nodeName === "DIV" && (n as unknown as { getAttribute(a: string): string | null }).getAttribute("role") === "alert").map((n) => n.textContent ?? "");

describe("Queue calendar: a drop too soon says the shared sentence", () => {
  it("a drop at 14:59:20 onto today's 15:00 is refused with the too-soon sentence", async () => {
    await dragOnto(job(new Date(2026, 10, 21, 15, 0)), NOW);
    expect(alerts().join(" ")).toContain(SCHEDULED_TIME_TOO_SOON_MESSAGE);
    expect(alerts().join(" ")).not.toContain("already passed");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a drop onto a time already past today is refused with the same sentence", async () => {
    await dragOnto(job(new Date(2026, 10, 21, 10, 0)), NOW);
    expect(alerts().join(" ")).toContain(SCHEDULED_TIME_TOO_SOON_MESSAGE);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a drop onto a future day moves the post", async () => {
    const target = new Date(2026, 10, 23, 15, 0);
    await dragOnto(job(new Date(2026, 10, 21, 15, 0)), target);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string) as { scheduledFor: string };
    expect(body.scheduledFor).toBe(target.toISOString());
    expect(onRescheduled).toHaveBeenCalledTimes(1);
    expect(alerts()).toEqual([]);
  });
});
