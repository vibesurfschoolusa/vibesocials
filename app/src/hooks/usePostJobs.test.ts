import { act, createElement, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { usePostJobs, type UsePostJobsResult } from "./usePostJobs";

/**
 * 2026-11-01 scale audit (W5): hook-level pins for the feed poll - backoff,
 * pause in hidden tabs, immediate fetch on return, stop after 30 minutes.
 *
 * The repo's vitest runs in a node environment with no DOM library (see
 * vitest.config.ts), so this mounts the real hook with react-dom/client against
 * a stubbed `document`/`window` and fake timers. The scheduling decisions
 * themselves are unit-tested in lib/postJobPolling.test.ts; this file only
 * proves the hook wires them up (timer, visibilitychange listener, cleanup).
 */

const STEP_MS = 10_000;

function jobFixture(overrides: { id?: string; status?: string } = {}) {
  return {
    id: "j1",
    status: "in_progress",
    createdAt: "2026-07-10T00:00:00.000Z",
    updatedAt: "2026-07-10T00:00:00.000Z",
    scheduledFor: null,
    caption: "c",
    results: [],
    media: null,
    publish: null,
    createdBy: null,
    approvalState: "none",
    ...overrides,
  };
}

let visibility: "visible" | "hidden";
let listeners: Map<string, Set<() => void>>;
let payloadJobs: ReturnType<typeof jobFixture>[];
let latest: UsePostJobsResult;
let root: Root | null;
const fetchMock = vi.fn();

// Publishes the hook's result from an effect (not during render) so the tests
// can read the latest value after each `act`.
function Probe({ onResult }: { onResult: (result: UsePostJobsResult) => void }) {
  const result = usePostJobs();
  useEffect(() => {
    onResult(result);
  });
  return null;
}

async function mount() {
  // nodeType 9 makes React treat the stub as its own ownerDocument, so no real
  // DOM is needed; Probe renders null.
  const container = {
    nodeType: 9,
    addEventListener() {},
    removeEventListener() {},
  } as unknown as HTMLElement;
  root = createRoot(container);
  await act(async () => {
    root!.render(
      createElement(Probe, {
        onResult: (result) => {
          latest = result;
        },
      }),
    );
  });
}

async function unmount() {
  await act(async () => {
    root?.unmount();
  });
  root = null;
}

/** Advance fake time in 10 s steps, flushing React between steps (a poll re-arms via a re-render). */
async function advance(ms: number) {
  for (let elapsed = 0; elapsed < ms; elapsed += STEP_MS) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(Math.min(STEP_MS, ms - elapsed));
    });
  }
}

async function fireVisibilityChange() {
  await act(async () => {
    for (const listener of listeners.get("visibilitychange") ?? []) listener();
    await vi.advanceTimersByTimeAsync(0);
  });
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  visibility = "visible";
  listeners = new Map();
  payloadJobs = [jobFixture()];
  root = null;
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ jobs: payloadJobs, nextCursor: null, workspaceMemberCount: 1 }),
  }));
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("window", {
    event: undefined,
    document: {},
    HTMLIFrameElement: class {},
    addEventListener() {},
    removeEventListener() {},
  });
  vi.stubGlobal("document", {
    get visibilityState() {
      return visibility;
    },
    addEventListener(type: string, listener: () => void) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(listener);
    },
    removeEventListener(type: string, listener: () => void) {
      listeners.get(type)?.delete(listener);
    },
  });
});

afterEach(async () => {
  await unmount();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

describe("usePostJobs polling", () => {
  it("polls on the backoff schedule and stops after 30 minutes, then says so", async () => {
    await mount();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await advance(9_999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // 12 polls in the first 2 minutes (10 s apart), 16 more until 10 minutes
    // (30 s apart), 19 more until 30 minutes (60 s apart), plus the initial load.
    await advance(30 * 60_000 - 10_000);
    expect(latest.pollingStopped).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1 + 12 + 16 + 19);

    // Stopped means no timer: nothing fires on its own.
    await advance(10 * 60_000);
    expect(fetchMock).toHaveBeenCalledTimes(1 + 12 + 16 + 19);
  });

  it("refetches exactly once when the tab returns after polling stopped, without resuming the poll", async () => {
    await mount();
    await advance(31 * 60_000);
    expect(latest.pollingStopped).toBe(true);
    const stoppedAt = fetchMock.mock.calls.length;

    // Away and back, job still running: one fetch on return, hint stays, and no
    // timer is armed afterwards.
    visibility = "hidden";
    await advance(5 * 60_000);
    visibility = "visible";
    await fireVisibilityChange();
    expect(fetchMock).toHaveBeenCalledTimes(stoppedAt + 1);
    expect(latest.pollingStopped).toBe(true);
    await advance(10 * 60_000);
    expect(fetchMock).toHaveBeenCalledTimes(stoppedAt + 1);
    expect(latest.pollingStopped).toBe(true);
  });

  it("clears the hint on return when the job finished while polling was stopped", async () => {
    await mount();
    await advance(31 * 60_000);
    expect(latest.pollingStopped).toBe(true);
    const stoppedAt = fetchMock.mock.calls.length;

    payloadJobs = [jobFixture({ status: "completed" })];
    await fireVisibilityChange();
    expect(fetchMock).toHaveBeenCalledTimes(stoppedAt + 1);
    expect(latest.jobs?.[0].status).toBe("completed");
    expect(latest.pollingStopped).toBe(false);

    // Settled: nothing more to fetch, on a timer or on a later return.
    await advance(10 * 60_000);
    await fireVisibilityChange();
    expect(fetchMock).toHaveBeenCalledTimes(stoppedAt + 1);
  });

  it("does not poll, and does not claim to have stopped, when nothing is in flight", async () => {
    payloadJobs = [jobFixture({ status: "completed" })];
    await mount();
    await advance(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(latest.pollingStopped).toBe(false);
  });

  it("fires no fetch in a hidden tab, then exactly one immediately when it becomes visible", async () => {
    await mount();
    await advance(20_000);
    expect(fetchMock).toHaveBeenCalledTimes(3);

    visibility = "hidden";
    await advance(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(latest.pollingStopped).toBe(false);

    // The jobs finished while the tab was away: return shows fresh state with no
    // wait for a tick, and polling ends because nothing is in flight any more.
    visibility = "visible";
    payloadJobs = [jobFixture({ status: "completed" })];
    await fireVisibilityChange();
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(latest.jobs?.[0].status).toBe("completed");

    await advance(5 * 60_000);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(latest.pollingStopped).toBe(false);
  });

  it("a tab hidden for longer than the whole schedule is not stopped; it fetches once on return, then stops", async () => {
    await mount();
    visibility = "hidden";
    await advance(40 * 60_000);
    const whileHidden = fetchMock.mock.calls.length;
    expect(latest.pollingStopped).toBe(false);

    visibility = "visible";
    await fireVisibilityChange();
    expect(fetchMock).toHaveBeenCalledTimes(whileHidden + 1);
    await advance(STEP_MS);
    expect(latest.pollingStopped).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(whileHidden + 1);
  });

  it("registers one visibilitychange listener and removes it on unmount", async () => {
    await mount();
    expect(listeners.get("visibilitychange")?.size).toBe(1);
    await advance(30_000);
    expect(listeners.get("visibilitychange")?.size).toBe(1);
    await unmount();
    expect(listeners.get("visibilitychange")?.size).toBe(0);
  });

  it("restarts the schedule when a retry is watched after polling stopped", async () => {
    await mount();
    await advance(31 * 60_000);
    expect(latest.pollingStopped).toBe(true);
    const before = fetchMock.mock.calls.length;

    payloadJobs = [jobFixture({ id: "j2" })];
    await act(async () => {
      latest.watchRetry("j2");
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(latest.pollingStopped).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(before + 1);

    await advance(STEP_MS);
    expect(fetchMock).toHaveBeenCalledTimes(before + 2);
  });
});
