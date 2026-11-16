import { act, createElement, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { renderedWorkspaceRefusal, WORKSPACE_CHANGED_SAVE_MESSAGE } from "@/lib/workspaceChanged";

import {
  LOAD_MORE_FAILED_TEXT,
  LOAD_MORE_OFFLINE_TEXT,
  loadMoreFailureText,
  usePostJobs,
  type UsePostJobsResult,
} from "./usePostJobs";

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
    platformCaptions: null,
    ...overrides,
  };
}

let visibility: "visible" | "hidden";
let listeners: Map<string, Set<() => void>>;
let payloadJobs: ReturnType<typeof jobFixture>[];
let latest: UsePostJobsResult;
// Every committed result, in order (N3 fix 1: catches a one-render flash).
let history: UsePostJobsResult[] = [];
let root: Root | null;
const fetchMock = vi.fn();

// Publishes the hook's result from an effect (not during render) so the tests
// can read the latest value after each `act`.
function Probe({ onResult }: { onResult: (result: UsePostJobsResult) => void }) {
  const result = usePostJobs("ws-1");
  useEffect(() => {
    onResult(result);
  });
  return null;
}

// N3: the Activity page's call, with a filter that can change between renders.
function FilteredProbe({
  onResult,
  options,
}: {
  onResult: (result: UsePostJobsResult) => void;
  options?: { show?: "problems" };
}) {
  const result = usePostJobs("ws-1", options);
  useEffect(() => {
    onResult(result);
  });
  return null;
}

type MountOptions = { show?: "problems" } | "filtered-all" | undefined;

function probe(options: MountOptions) {
  const onResult = (result: UsePostJobsResult) => {
    latest = result;
    history.push(result);
  };
  if (options === undefined) return createElement(Probe, { onResult });
  return createElement(FilteredProbe, {
    onResult,
    options: options === "filtered-all" ? undefined : options,
  });
}

async function mount(options?: MountOptions) {
  // nodeType 9 makes React treat the stub as its own ownerDocument, so no real
  // DOM is needed; Probe renders null.
  const container = {
    nodeType: 9,
    addEventListener() {},
    removeEventListener() {},
  } as unknown as HTMLElement;
  root = createRoot(container);
  await act(async () => {
    root!.render(probe(options));
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
  history = [];
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

// N3: Activity's "Had a problem" tab.
describe("usePostJobs show filter", () => {
  const urls = () => fetchMock.mock.calls.map((call) => String(call[0]));

  it("sends no show param when called with no argument", async () => {
    await mount();
    await advance(STEP_MS);
    expect(urls().length).toBeGreaterThanOrEqual(2);
    expect(urls().every((url) => !url.includes("show="))).toBe(true);
  });

  it("puts the filter on the first load, the poll, a watched retry and Load more", async () => {
    fetchMock.mockImplementation(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ jobs: payloadJobs, nextCursor: "c1", workspaceMemberCount: 1 }),
    }));
    await mount({ show: "problems" });
    expect(urls()[0]).toBe("/api/posts?show=problems&workspaceId=ws-1");

    await advance(STEP_MS);
    expect(urls()[1]).toBe("/api/posts?show=problems&workspaceId=ws-1");

    await act(async () => {
      latest.watchRetry("j1");
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(urls()[2]).toBe("/api/posts?show=problems&workspaceId=ws-1");

    await act(async () => {
      latest.loadMore();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(urls()[3]).toBe("/api/posts?show=problems&cursor=c1&workspaceId=ws-1");
  });

  it("restarts the list when the filter changes, and a late answer for the old filter is dropped", async () => {
    let releaseOld: (() => void) | null = null;
    fetchMock.mockImplementation(async (url: string) => {
      if (!url.includes("show=")) {
        // The all-posts answer arrives only after the switch.
        await new Promise<void>((resolve) => {
          releaseOld = resolve;
        });
        return {
          ok: true,
          status: 200,
          json: async () => ({ jobs: [jobFixture({ id: "all-1", status: "completed" })], nextCursor: "old", workspaceMemberCount: 1 }),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ jobs: [jobFixture({ id: "bad-1", status: "failed" })], nextCursor: null, workspaceMemberCount: 1 }),
      };
    });
    await mount("filtered-all");
    expect(latest.loading).toBe(true);

    await act(async () => {
      root!.render(probe({ show: "problems" }));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(latest.jobs?.map((j) => j.id)).toEqual(["bad-1"]);

    await act(async () => {
      releaseOld?.();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(latest.jobs?.map((j) => j.id)).toEqual(["bad-1"]);
    expect(latest.hasMore).toBe(false);
  });
});

// N3 fix round 1.
describe("usePostJobs show filter - fix round 1", () => {
  it("on the problems tab, a watched retried post stays in place with the fresh copy, and polling runs until it settles", async () => {
    payloadJobs = [jobFixture({ id: "a", status: "failed" }), jobFixture({ id: "j1", status: "failed" }), jobFixture({ id: "b", status: "failed" })];
    await mount({ show: "problems" });
    const afterMount = fetchMock.mock.calls.length;
    // Nothing in flight: no poll.
    await advance(STEP_MS * 3);
    expect(fetchMock).toHaveBeenCalledTimes(afterMount);

    // The server keeps the retried post on show=problems (retriedAt), now running.
    payloadJobs = [jobFixture({ id: "a", status: "failed" }), jobFixture({ id: "j1", status: "in_progress" }), jobFixture({ id: "b", status: "failed" })];
    await act(async () => {
      latest.watchRetry("j1");
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(latest.jobs?.map((j) => [j.id, j.status])).toEqual([["a", "failed"], ["j1", "in_progress"], ["b", "failed"]]);

    await advance(STEP_MS);
    expect(fetchMock).toHaveBeenCalledTimes(afterMount + 2);
    expect(String(fetchMock.mock.calls.at(-1)?.[0])).toBe("/api/posts?show=problems&workspaceId=ws-1");
    expect(latest.jobs?.map((j) => j.id)).toEqual(["a", "j1", "b"]);

    // It settles: polling stops.
    payloadJobs = [jobFixture({ id: "a", status: "failed" }), jobFixture({ id: "j1", status: "completed" }), jobFixture({ id: "b", status: "failed" })];
    await advance(STEP_MS);
    const settled = fetchMock.mock.calls.length;
    expect(latest.jobs?.map((j) => [j.id, j.status])).toEqual([["a", "failed"], ["j1", "completed"], ["b", "failed"]]);
    await advance(STEP_MS * 6);
    expect(fetchMock).toHaveBeenCalledTimes(settled);
  });

  it("right after a tab switch, before any answer, returns no rows and loading; the old tab's late answer never lands", async () => {
    let releaseAll: (() => void) | null = null;
    let releaseProblems: (() => void) | null = null;
    let allCalls = 0;
    fetchMock.mockImplementation(async (url: string) => {
      const problems = url.includes("show=problems");
      if (!problems) allCalls += 1;
      // The first all-posts answer is quick; the second (after switching back
      // and forth) and the problems answer wait.
      if (problems) {
        await new Promise<void>((resolve) => {
          releaseProblems = resolve;
        });
      } else if (allCalls > 1) {
        await new Promise<void>((resolve) => {
          releaseAll = resolve;
        });
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          jobs: [jobFixture({ id: problems ? "bad-1" : "all-1", status: problems ? "failed" : "completed" })],
          nextCursor: problems ? null : "old",
          workspaceMemberCount: 1,
        }),
      };
    });
    await mount("filtered-all");
    expect(latest.jobs?.map((j) => j.id)).toEqual(["all-1"]);
    expect(latest.loading).toBe(false);

    history = [];
    await act(async () => {
      root!.render(probe({ show: "problems" }));
    });
    // The very first render for the new tab already hides the other tab's rows.
    expect(history[0].jobs).toBeNull();
    expect(history[0].loading).toBe(true);
    expect(history[0].hasMore).toBe(false);
    expect(history.every((r) => r.jobs === null && r.loading)).toBe(true);

    // Switch back to all posts and then to problems again while answers wait.
    await act(async () => {
      root!.render(probe("filtered-all"));
    });
    await act(async () => {
      root!.render(probe({ show: "problems" }));
    });
    history = [];
    await act(async () => {
      releaseAll?.();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(history.every((r) => !r.jobs?.some((j) => j.id === "all-1"))).toBe(true);
    expect(latest.jobs).toBeNull();
    expect(latest.loading).toBe(true);

    await act(async () => {
      releaseProblems?.();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(latest.jobs?.map((j) => j.id)).toEqual(["bad-1"]);
    expect(latest.loading).toBe(false);
  });

  it("a failed first load for the new tab shows the error, not a skeleton forever", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes("show=problems")) return { ok: false, status: 500, json: async () => ({}) };
      return {
        ok: true,
        status: 200,
        json: async () => ({ jobs: [jobFixture({ id: "all-1", status: "completed" })], nextCursor: null, workspaceMemberCount: 1 }),
      };
    });
    await mount("filtered-all");
    expect(latest.jobs?.map((j) => j.id)).toEqual(["all-1"]);

    await act(async () => {
      root!.render(probe({ show: "problems" }));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(latest.loading).toBe(false);
    expect(latest.error).not.toBeNull();
    expect(latest.jobs).toBeNull();
  });
});

// R10-client-journey L1: the cards need the viewer's role, from the list answer.
describe("usePostJobs viewer role", () => {
  it("is null until the first answer, then the answer's workspaceRole", async () => {
    payloadJobs = [jobFixture({ status: "completed" })];
    fetchMock.mockImplementation(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ jobs: payloadJobs, nextCursor: null, workspaceMemberCount: 2, workspaceRole: "member" }),
    }));
    await mount();
    expect(history[0].workspaceRole).toBeNull();
    expect(latest.workspaceRole).toBe("member");
  });
});

// R21 pages L3: Activity says what every other page says after a 401.
describe("usePostJobs signed out", () => {
  it("a 401 shows the shared signed-out sentence", async () => {
    fetchMock.mockImplementation(async () => ({ ok: false, status: 401, json: async () => ({}) }));
    await mount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(latest.error).toBe("You were signed out. Sign in again.");
  });
});

// R26 LL3 item 3: a Load more that fails says so under the button, and keeps
// the cursor so the next press asks for the same page again.
describe("usePostJobs Load more failure", () => {
  const firstPage = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ jobs: payloadJobs, nextCursor: "c1", workspaceMemberCount: 1 }),
  });

  async function pressLoadMore() {
    await act(async () => {
      latest.loadMore();
      await vi.advanceTimersByTimeAsync(0);
    });
  }

  it.each([
    [
      "offline",
      async () => {
        throw new TypeError("Failed to fetch");
      },
      LOAD_MORE_OFFLINE_TEXT,
    ],
    ["a server error", async () => ({ ok: false, status: 500, json: async () => ({}) }), LOAD_MORE_FAILED_TEXT],
    // R29 OO1: a gateway's page came over a working connection: not "there's no connection".
    [
      "a gateway's page",
      async () => new Response("<html>504</html>", { status: 504, headers: { "content-type": "text/html" } }),
      LOAD_MORE_FAILED_TEXT,
    ],
    [
      "a 200 that isn't JSON",
      async () => ({
        ok: true,
        status: 200,
        json: async () => {
          throw new SyntaxError("Unexpected token '<'");
        },
      }),
      LOAD_MORE_FAILED_TEXT,
    ],
    ["signed out", async () => ({ ok: false, status: 401, json: async () => ({}) }), "You were signed out. Sign in again."],
  ])("%s: a status line, the list and cursor kept; the next press retries and clears it", async (_name, failing, text) => {
    fetchMock.mockImplementation(firstPage);
    await mount();
    fetchMock.mockImplementationOnce(failing);
    await pressLoadMore();

    expect(latest.loadMoreError).toBe(text);
    expect(latest.hasMore).toBe(true);
    expect(latest.jobs).toHaveLength(1);
    expect(latest.error).toBeNull();

    fetchMock.mockImplementationOnce(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ jobs: [jobFixture({ id: "j2", status: "succeeded" })], nextCursor: null, workspaceMemberCount: 1 }),
    }));
    await pressLoadMore();
    const urls = fetchMock.mock.calls.map((call) => String(call[0]));
    expect(urls.filter((url) => url.includes("cursor=c1"))).toHaveLength(2);
    expect(latest.loadMoreError).toBeNull();
    expect(latest.jobs).toHaveLength(2);
  });

  it("is null before any Load more", async () => {
    await mount();
    expect(latest.loadMoreError).toBeNull();
  });
});

// R32 publishing L1: every read names the page's workspace; a refusal (another
// tab switched workspace) says the shared sentence and never fills the page
// with the other workspace's posts.
describe("usePostJobs and the page's workspace", () => {
  const urls = () => fetchMock.mock.calls.map((call) => String(call[0]));
  const refused = async () => renderedWorkspaceRefusal("ws-1", "ws-2") as Response;

  it("sends the page's id on the first load, the poll and Load more, and reports it before any answer", async () => {
    fetchMock.mockImplementation(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ jobs: payloadJobs, nextCursor: "c1", workspaceMemberCount: 1 }),
    }));
    await mount();
    expect(history[0].workspaceId).toBe("ws-1");
    await advance(STEP_MS);
    await act(async () => {
      latest.loadMore();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(urls().slice(0, 3)).toEqual(["/api/posts?workspaceId=ws-1", "/api/posts?workspaceId=ws-1", "/api/posts?cursor=c1&workspaceId=ws-1"]);
  });

  it("a refused first load shows the sentence in place of the list", async () => {
    fetchMock.mockImplementation(refused);
    await mount();
    expect(latest.error).toBe(WORKSPACE_CHANGED_SAVE_MESSAGE);
    expect(latest.jobs).toBeNull();
  });

  it("a refused poll keeps the list, says the sentence and stops polling", async () => {
    await mount();
    expect(latest.jobs).toHaveLength(1);
    fetchMock.mockImplementation(refused);
    await advance(STEP_MS);
    const calls = fetchMock.mock.calls.length;
    expect(latest.jobs).toHaveLength(1);
    expect(latest.error).toBeNull();
    expect(latest.workspaceChanged).toBe(WORKSPACE_CHANGED_SAVE_MESSAGE);
    await advance(5 * 60_000);
    await fireVisibilityChange();
    expect(fetchMock.mock.calls.length).toBe(calls);
    expect(latest.pollingStopped).toBe(false);
  });

  it("a refused Load more says the sentence under the button and keeps the list", async () => {
    fetchMock.mockImplementation(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ jobs: [jobFixture({ status: "completed" })], nextCursor: "c1", workspaceMemberCount: 1 }),
    }));
    await mount();
    fetchMock.mockImplementationOnce(refused);
    await act(async () => {
      latest.loadMore();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(latest.loadMoreError).toBe(WORKSPACE_CHANGED_SAVE_MESSAGE);
    expect(latest.jobs).toHaveLength(1);
  });

  it("is null while every read is answered", async () => {
    await mount();
    expect(latest.workspaceChanged).toBeNull();
  });
});

describe("loadMoreFailureText", () => {
  it("words offline, signed out and anything else", () => {
    expect(loadMoreFailureText("offline")).toBe(LOAD_MORE_OFFLINE_TEXT);
    expect(loadMoreFailureText(401)).toBe("You were signed out. Sign in again.");
    expect(loadMoreFailureText(500)).toBe(LOAD_MORE_FAILED_TEXT);
    expect(LOAD_MORE_OFFLINE_TEXT).toBe(
      "Couldn't load more posts: there's no connection. Check your connection, then press Load more again.",
    );
    expect(LOAD_MORE_FAILED_TEXT).toBe("Couldn't load more posts. Press Load more to try again.");
  });
});
