import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next-auth/react", () => ({ useSession: () => ({ data: null }), signOut: vi.fn() }));
vi.mock("@/components/ui/toast", () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn() }) }));

import { announceWorkspaceChange } from "@/lib/workspaceChangeEvent";

import { watchWorkspaceList } from "./account-menu";

// R16 L1 (all four reviewers): a rename no longer loads the page again, so the
// menu reads its list again when the Team card announces it, and its button
// and panel name the new workspace name.
describe("watchWorkspaceList", () => {
  beforeEach(() => {
    vi.stubGlobal("window", new EventTarget());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const list = (name: string) => ({ workspaces: [{ id: "w1", name, role: "owner", isActive: true }] });
  const answer = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status }));

  it("rename: the menu gets the new name on the announce", async () => {
    const fetchImpl = vi.fn(() => answer(list("Surf Co Miami")));
    const onList = vi.fn();
    watchWorkspaceList(onList, fetchImpl as unknown as typeof fetch);
    expect(fetchImpl).not.toHaveBeenCalled();

    announceWorkspaceChange();
    await vi.waitFor(() => expect(onList).toHaveBeenCalledTimes(1));
    expect(fetchImpl).toHaveBeenCalledWith("/api/workspaces");
    expect(onList.mock.calls[0][0]).toEqual(list("Surf Co Miami").workspaces);
  });

  it("stops listening, and ignores a failed or malformed read", async () => {
    const onList = vi.fn();
    const stop = watchWorkspaceList(onList, (() => answer({ error: "x" }, 500)) as unknown as typeof fetch);
    announceWorkspaceChange();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onList).not.toHaveBeenCalled();
    stop();

    const fetchImpl = vi.fn(() => answer({ workspaces: "nope" }));
    const stopSecond = watchWorkspaceList(onList, fetchImpl as unknown as typeof fetch);
    announceWorkspaceChange();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onList).not.toHaveBeenCalled();
    stopSecond();
    announceWorkspaceChange();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
