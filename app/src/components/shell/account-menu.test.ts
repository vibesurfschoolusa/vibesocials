import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next-auth/react", async () => {
  const { createContext, useContext } = await import("react");
  const SessionContext = createContext<unknown>(undefined);
  return { SessionContext, useSession: () => useContext(SessionContext) ?? { data: null }, signOut: vi.fn() };
});
vi.mock("@/components/ui/toast", () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn() }) }));

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { SIGN_OUT_FAILED_MESSAGE, SIGN_OUT_NOT_SENT_MESSAGE, SIGN_OUT_STILL_SIGNED_IN_MESSAGE } from "@/lib/signOutChecked";
import { announceWorkspaceChange, newestAnswer } from "@/lib/workspaceChangeEvent";

import {
  closeOnEscape,
  createWorkspaceFailureText,
  focusWhenPending,
  readWorkspaceListOnce,
  signOutFromMenu,
  watchWorkspaceList,
  WORKSPACE_MAYBE_MADE_MESSAGE,
} from "./account-menu";

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

  // R30 PP2: only the menu's empty status line stays, so it is on the page from the first render.
  it("a cached session with no user: no menu", async () => {
    expect(await menu({ status: "authenticated", data: { expires: "1970-01-01T00:00:00.000Z" } })).toBe(
      '<p role="status" class="sr-only"></p>',
    );
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

// R24 pages L6: the menu is a disclosure (a button that shows a group), so
// focus stays where the person put it, and Cancel in the New workspace form
// hands focus to the "New workspace" button that comes back in its place.
describe("AccountMenu: focus and the button's attributes", () => {
  it("Cancel: focus moves to the New workspace button once it is back", () => {
    const pending = { current: true };
    const button = { focus: vi.fn() };
    focusWhenPending(button, pending);
    expect(button.focus).toHaveBeenCalledTimes(1);
    expect(pending.current).toBe(false);

    // Later renders (or the first open, with no Cancel) leave focus alone.
    focusWhenPending(button, pending);
    focusWhenPending(null, { current: true });
    expect(button.focus).toHaveBeenCalledTimes(1);
  });

  it("the New workspace button takes focus through that ref, and Cancel asks for it", () => {
    const source = readFileSync(fileURLToPath(new URL("./account-menu.tsx", import.meta.url)), "utf8");
    expect(source).toMatch(/ref=\{\(node\) => focusWhenPending\(node, focusNewWorkspaceButton\)\}/);
    const cancel = source.slice(source.indexOf("setCreatingWorkspace(false);") - 200, source.indexOf("setCreatingWorkspace(false);"));
    expect(cancel).toContain("focusNewWorkspaceButton.current = true;");
  });

  it("Escape closes the menu and returns focus to its button; other keys do nothing", () => {
    const close = vi.fn();
    const focusButton = vi.fn();
    expect(closeOnEscape("Enter", close, focusButton)).toBe(false);
    expect(close).not.toHaveBeenCalled();
    expect(closeOnEscape("Escape", close, focusButton)).toBe(true);
    expect(close).toHaveBeenCalledTimes(1);
    expect(focusButton).toHaveBeenCalledTimes(1);
  });

  it("the button: aria-expanded, no aria-haspopup (the panel is a group, not a dialog)", async () => {
    const { createElement } = await import("react");
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { SessionContext } = await import("next-auth/react");
    const { AccountMenu } = await import("./account-menu");
    const html = renderToStaticMarkup(
      createElement(
        SessionContext.Provider as never,
        { value: { status: "authenticated", data: { user: { name: "Owner", email: "owner@example.com" }, expires: "2099-01-01T00:00:00Z" } } } as never,
        createElement(AccountMenu),
      ),
    );
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain("aria-haspopup");
    const source = readFileSync(fileURLToPath(new URL("./account-menu.tsx", import.meta.url)), "utf8");
    expect(source).toContain("aria-controls={open ? panelId : undefined}");
    expect(source).toMatch(/role="group"\s+aria-label="Account"/);
  });
});

// R26 pages L1 (= new-customer L5): nothing in the menu disables itself while
// it works, so keyboard focus stays where it was. Create shows Button's
// loading; the field is read-only; Cancel and the switch buttons are
// aria-disabled and their handlers ignore a press while busy.
describe("AccountMenu: busy controls keep focus", () => {
  const source = readFileSync(fileURLToPath(new URL("./account-menu.tsx", import.meta.url)), "utf8");
  const form = source.slice(source.indexOf("<form onSubmit={handleCreateWorkspace}"), source.indexOf("</form>"));
  const switches = source.slice(source.indexOf('aria-label="Switch workspace"'), source.indexOf("{!workspacesLoading ? ("));

  it("no busy flag reaches disabled", () => {
    expect(form).not.toMatch(/\sdisabled=\{createBusy/);
    expect(switches).not.toMatch(/\sdisabled=\{switchingId/);
  });

  it("the name field is read-only, Cancel aria-disabled, Create loading", () => {
    expect(form).toContain("readOnly={createBusy}");
    expect(form).toMatch(/aria-disabled=\{createBusy \|\| undefined\}[\s\S]*if \(createBusy\) return;/);
    expect(form).toMatch(/type="submit"[^>]*loading=\{createBusy\}/);
    expect(switches).toContain("aria-disabled={switchingId !== null || undefined}");
    expect(source).toMatch(/if \(workspace\.isActive \|\| switchingId\) return;/);
  });
});

// R27 MM3 (new-customer L3 = pages L4): Install app closes the menu and opens
// the instructions in one press, so the dialog saw the page body as its
// trigger. Focus goes to the menu button first, so closing the instructions
// returns it there.
describe("AccountMenu: Install app instructions", () => {
  const source = readFileSync(fileURLToPath(new URL("./account-menu.tsx", import.meta.url)), "utf8");

  it("focuses the menu button before the menu closes and the instructions open", () => {
    expect(source).toMatch(
      /onClick=\{\(\) => \{\s+\/\/[^\n]*\n\s+buttonRef\.current\?\.focus\(\);\s+setOpen\(false\);\s+installApp\.install\(\);/,
    );
  });
});

// R27 MM3 (new-customer L1): the workspace may exist when the answer is lost,
// and a second Create would make another. Never "nothing changed".
describe("AccountMenu: Create workspace when the answer is lost", () => {
  const source = readFileSync(fileURLToPath(new URL("./account-menu.tsx", import.meta.url)), "utf8");
  const create = source.slice(source.indexOf("async function handleCreateWorkspace("), source.indexOf("const initials ="));

  it("says it may have been made and to check the workspace list", () => {
    expect(WORKSPACE_MAYBE_MADE_MESSAGE).toBe(
      "Vibe Socials' answer didn't reach you, so the workspace may have been made. If your connection dropped, reconnect first. Open this menu again and check the workspace list before you create it again.",
    );
  });

  it("no answer or an unreadable 5xx: that sentence; a refusal: the route's own", () => {
    expect(createWorkspaceFailureText(502, null)).toBe(WORKSPACE_MAYBE_MADE_MESSAGE);
    expect(createWorkspaceFailureText(500, {})).toBe(WORKSPACE_MAYBE_MADE_MESSAGE);
    expect(createWorkspaceFailureText(429, { error: "Too many new workspaces today." })).toBe("Too many new workspaces today.");
    expect(createWorkspaceFailureText(400, null)).toBe("Couldn't create the workspace. Try again.");
    expect(create).toMatch(/toast\.error\(createWorkspaceFailureText\(response\.status, data\)\);/);
    expect(create).toMatch(/confirmFailureText\(error, WORKSPACE_MAYBE_MADE_MESSAGE\)/);
  });
});

// R29 OO1 (new-customer L2): Sign out in the menu closed the menu and awaited
// signOut with no catch, so a failure said nothing; the person could walk
// away from a shared computer thinking they were signed out.
describe("AccountMenu: Sign out", () => {
  const source = readFileSync(fileURLToPath(new URL("./account-menu.tsx", import.meta.url)), "utf8");

  // R32 new-customer L2: through the one checked sign-out; the page leaves
  // only after it, so next-auth's own sign-out page never shows.
  it("success: closes the menu and loads the home page, no toast", async () => {
    const close = vi.fn();
    const error = vi.fn();
    const leave = vi.fn();
    await signOutFromMenu(async () => ({ ok: true as const }), close, error, leave);
    expect(close).toHaveBeenCalledTimes(1);
    expect(leave).toHaveBeenCalledWith("/");
    expect(error).not.toHaveBeenCalled();
  });

  it("a failure: the sign-out lost-answer toast, as Log in and Register's notice, and the menu stays open on this page", async () => {
    const close = vi.fn();
    const error = vi.fn();
    const leave = vi.fn();
    await signOutFromMenu(async () => ({ ok: false as const, kind: "lost" as const }), close, error, leave);
    expect(error).toHaveBeenCalledWith(SIGN_OUT_FAILED_MESSAGE);
    // R32 lead review: an answer that left the person signed in says so.
    await signOutFromMenu(async () => ({ ok: false as const, kind: "refused" as const }), close, error, leave);
    expect(error).toHaveBeenLastCalledWith(SIGN_OUT_STILL_SIGNED_IN_MESSAGE);
    // R33 pages L4: no answer to the token read, so nothing was sent.
    await signOutFromMenu(async () => ({ ok: false as const, kind: "not_sent" as const }), close, error, leave);
    expect(error).toHaveBeenLastCalledWith(SIGN_OUT_NOT_SENT_MESSAGE);
    expect(close).not.toHaveBeenCalled();
    expect(leave).not.toHaveBeenCalled();
  });

  it("the menu's Sign out button goes through it", () => {
    expect(source).toMatch(/signOutFromMenu\(signOutChecked, \(\) => setOpen\(false\), toast\.error\)/);
  });
});
