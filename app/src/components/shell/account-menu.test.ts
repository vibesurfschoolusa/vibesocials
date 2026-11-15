import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next-auth/react", async () => {
  const { createContext, useContext } = await import("react");
  const SessionContext = createContext<unknown>(undefined);
  return { SessionContext, useSession: () => useContext(SessionContext) ?? { data: null }, signOut: vi.fn() };
});
vi.mock("@/components/ui/toast", () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn() }) }));

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { announceWorkspaceChange, newestAnswer } from "@/lib/workspaceChangeEvent";

import { readWorkspaceListOnce, watchWorkspaceList } from "./account-menu";

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

// Review note: the page-load read and the announce read share one order, so
// the name from the later read shows, however they answer.
describe("the menu keeps the newest answer", () => {
  beforeEach(() => {
    vi.stubGlobal("window", new EventTarget());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const list = (name: string) => ({ workspaces: [{ id: "w1", name, role: "owner", isActive: true }] });
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  it("announce read and page-load read answer out of order: the newer one shows", async () => {
    const pending: Array<(body: unknown) => void> = [];
    const fetchImpl = (() =>
      new Promise<Response>((resolve) => pending.push((body) => resolve(new Response(JSON.stringify(body), { status: 200 }))))) as unknown as typeof fetch;
    const reads = newestAnswer();
    const names: string[] = [];
    const onList = (workspaces: Array<{ name: string }>) => names.push(workspaces[0].name);
    readWorkspaceListOnce(onList, fetchImpl, reads); // page load, old name
    watchWorkspaceList(onList, fetchImpl, reads);
    announceWorkspaceChange(); // after the rename

    pending[1](list("Surf Co Miami"));
    await settle();
    pending[0](list("Surf Co"));
    await settle();
    expect(names).toEqual(["Surf Co Miami"]);
  });

  it("every list read in the menu takes its place in the order", () => {
    const source = readFileSync(fileURLToPath(new URL("./account-menu.tsx", import.meta.url)), "utf8");
    const reads = source.match(/\b(?:fetch|fetchImpl)\("\/api\/workspaces"\)/g) ?? [];
    expect(reads.length).toBeGreaterThan(0);
    expect((source.match(/\breads\.next\(\)/g) ?? []).length).toBe(reads.length);
  });
});

// R19 new-customer L1: the menu names the signed-in person, so a session the
// server ended (no user, still "authenticated" to next-auth) shows no menu.
describe("AccountMenu: who it is for", () => {
  async function menu(session: unknown): Promise<string> {
    const { createElement } = await import("react");
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { SessionContext } = await import("next-auth/react");
    const { AccountMenu } = await import("./account-menu");
    return renderToStaticMarkup(
      createElement(SessionContext.Provider as never, { value: session } as never, createElement(AccountMenu)),
    );
  }

  it("a cached session with no user: no menu", async () => {
    expect(await menu({ status: "authenticated", data: { expires: "1970-01-01T00:00:00.000Z" } })).toBe("");
  });

  it("signed in: the menu names the person", async () => {
    const html = await menu({
      status: "authenticated",
      data: { user: { name: "Owner", email: "owner@example.com" }, expires: "2099-01-01T00:00:00Z" },
    });
    expect(html).toContain("Account menu for");
    expect(html).toContain("Owner");
  });

  it("while the session loads in the app frame: the button shows, as today", async () => {
    expect(await menu({ status: "loading", data: undefined })).toContain("Account menu for");
  });
});
