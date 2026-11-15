import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { announceWorkspaceChange, newestAnswer, subscribeWorkspaceChange, WORKSPACE_CHANGED_EVENT } from "./workspaceChangeEvent";

/**
 * R16 L1/L2: a rename or an owner stepping down keeps the active workspace, so
 * the page is not loaded again; the account menu and the workspace banner hear
 * this event and read their data again.
 */

beforeEach(() => {
  vi.stubGlobal("window", new EventTarget());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("workspace changed event", () => {
  it("an announce reaches each listener until it unsubscribes", () => {
    const first = vi.fn();
    const second = vi.fn();
    const stopFirst = subscribeWorkspaceChange(first);
    subscribeWorkspaceChange(second);

    announceWorkspaceChange();
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);

    stopFirst();
    announceWorkspaceChange();
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(2);
  });

  it("is one named event on the window", () => {
    const listener = vi.fn();
    window.addEventListener(WORKSPACE_CHANGED_EVENT, listener);
    announceWorkspaceChange();
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

// Review note: two reads of the same data can answer out of order; an older
// read finishing last must not overwrite a newer one.
describe("newestAnswer", () => {
  it("lets an answer show only when no newer read has shown one", () => {
    const reads = newestAnswer();
    const older = reads.next();
    const newer = reads.next();
    expect(newer()).toBe(true);
    expect(older()).toBe(false);
  });

  it("in order, each answer shows", () => {
    const reads = newestAnswer();
    const first = reads.next();
    expect(first()).toBe(true);
    const second = reads.next();
    expect(second()).toBe(true);
  });

  // A newer read that failed never shows, so it must not hold back the older answer.
  it("an older answer still shows when the newer read never answers", () => {
    const reads = newestAnswer();
    const older = reads.next();
    reads.next();
    expect(older()).toBe(true);
  });
});
