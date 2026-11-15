import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { announceWorkspaceChange, subscribeWorkspaceChange, WORKSPACE_CHANGED_EVENT } from "./workspaceChangeEvent";

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
