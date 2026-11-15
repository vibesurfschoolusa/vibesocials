import { describe, expect, it, vi } from "vitest";

const { getSessionMock, signOutMock } = vi.hoisted(() => ({ getSessionMock: vi.fn(), signOutMock: vi.fn() }));

vi.mock("next-auth/react", async () => {
  const { createContext } = await import("react");
  return { getSession: getSessionMock, signOut: signOutMock, SessionContext: createContext(undefined) };
});

import {
  accountKey,
  endStaleSession,
  readServerAccount,
  showAndEndStale,
  shownAccount,
  startServerCheck,
  startSignedOutSync,
} from "./signed-in-swap";

const OWNER = { name: "Owner", email: "owner@example.com" };

// R18 new-customer L1 (= security L1, pages L1): the cached client session can
// still say "signed in" after a password reset ended the session on the
// server, so Log in and Register ask the server before showing the notice.
describe("the server's answer behind the signed-in notice", () => {
  it("reads the server's session without making every other tab refetch", async () => {
    getSessionMock.mockResolvedValueOnce({ user: OWNER, expires: "2099-01-01T00:00:00Z" });
    await expect(readServerAccount()).resolves.toEqual(OWNER);
    expect(getSessionMock).toHaveBeenCalledWith({ broadcast: false });
  });

  it("is nobody when the server has no session", async () => {
    await expect(readServerAccount(async () => null)).resolves.toBeNull();
    await expect(readServerAccount(async () => ({ expires: "2099-01-01T00:00:00Z" }) as never)).resolves.toBeNull();
  });

  it("is nobody when the read fails", async () => {
    await expect(
      readServerAccount(async () => {
        throw new Error("offline");
      }),
    ).resolves.toBeNull();
  });

  it("does not ask the server when the cached session is already signed out", () => {
    const read = vi.fn(async () => OWNER);
    const onAnswer = vi.fn();
    expect(startServerCheck(null, read, onAnswer)).toBeUndefined();
    expect(read).not.toHaveBeenCalled();
    expect(onAnswer).not.toHaveBeenCalled();
  });

  it("passes on the server's answer for the cached account it asked about", async () => {
    const key = accountKey(OWNER)!;
    const onAnswer = vi.fn();
    startServerCheck(key, async () => null, onAnswer);
    await vi.waitFor(() => expect(onAnswer).toHaveBeenCalledWith({ key, account: null }));
  });

  it("drops an answer that arrives after the page moved on", async () => {
    const key = accountKey(OWNER)!;
    const onAnswer = vi.fn();
    let answer: (value: typeof OWNER) => void = () => undefined;
    const stop = startServerCheck(key, () => new Promise((resolve) => (answer = resolve)), onAnswer);
    stop?.();
    answer(OWNER);
    await Promise.resolve();
    await Promise.resolve();
    expect(onAnswer).not.toHaveBeenCalled();
  });

  it("shows the notice only once the server said someone is signed in", () => {
    const key = accountKey(OWNER);
    // Cached signed in, server not answered yet: the form.
    expect(shownAccount(key, null)).toBeNull();
    // Cached signed in, server empty (session ended by a reset): the form.
    expect(shownAccount(key, { key: key!, account: null })).toBeNull();
    // Cached signed in, server signed in: the notice, with the server's account.
    expect(shownAccount(key, { key: key!, account: OWNER })).toEqual(OWNER);
    // Cached signed out (Sign out pressed): the form, whatever was answered before.
    expect(shownAccount(null, { key: key!, account: OWNER })).toBeNull();
    // An answer about another cached account does not count.
    expect(shownAccount(accountKey({ name: null, email: "other@example.com" }), { key: key!, account: OWNER })).toBeNull();
  });
});

// DD1 review: a session the server ended answers {"expires":"1970-..."} with
// no user, and next-auth still calls that "authenticated". The header's
// Dashboard and About's button must read it as signed out, or Dashboard ->
// landing -> Dashboard loops.
describe("a cached session with no user", () => {
  async function swap(value: unknown): Promise<string> {
    const { createElement } = await import("react");
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { SessionContext } = await import("next-auth/react");
    const { SignedInSwap } = await import("./signed-in-swap");
    return renderToStaticMarkup(
      createElement(
        SessionContext.Provider as never,
        { value } as never,
        createElement(SignedInSwap, { signedIn: "IN", signedOut: "OUT" }),
      ),
    );
  }

  it("is signed out when the server's answer has no user", async () => {
    expect(await swap({ status: "authenticated", data: { expires: "1970-01-01T00:00:00.000Z" } })).toBe("OUT");
  });

  it("is signed out when the user has neither an email nor a name", async () => {
    expect(await swap({ status: "authenticated", data: { user: {}, expires: "2099-01-01T00:00:00Z" } })).toBe("OUT");
  });

  it("is signed in for a real user", async () => {
    expect(await swap({ status: "authenticated", data: { user: OWNER, expires: "2099-01-01T00:00:00Z" } })).toBe("IN");
  });
});

// R19 new-customer L1 (= pages L1): the client follows the server when they
// disagree. Where the server rendered the signed-out view but the cached
// session still names someone, the session is read again: nobody -> sign out
// (clears the stale cookie and context here and in other tabs); someone (the
// server page saw a blip) -> refresh the page once, no sign-out.
describe("the signed-out page and a cached session that names someone", () => {
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  it("signs out once, without leaving the page, when the server says nobody", async () => {
    signOutMock.mockReset().mockResolvedValue({ url: "/" });
    endStaleSession();
    expect(signOutMock).toHaveBeenCalledTimes(1);
    expect(signOutMock).toHaveBeenCalledWith({ redirect: false });
  });

  it("a failed sign-out leaves the page as it is", async () => {
    signOutMock.mockReset().mockRejectedValue(new Error("offline"));
    expect(() => endStaleSession()).not.toThrow();
    await settle();
  });

  it("the Landing: the fresh read names nobody -> sign out, no refresh", async () => {
    const signOut = vi.fn();
    const refresh = vi.fn();
    startSignedOutSync(accountKey(OWNER), async () => null, { signOut, refresh }, new Set());
    await settle();
    expect(signOut).toHaveBeenCalledTimes(1);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("the Landing: the fresh read names the person -> refresh once, no sign-out", async () => {
    const signOut = vi.fn();
    const refresh = vi.fn();
    const refreshed = new Set<string>();
    startSignedOutSync(accountKey(OWNER), async () => OWNER, { signOut, refresh }, refreshed);
    await settle();
    // The refreshed page still shows the Landing and the check runs again: no second refresh.
    startSignedOutSync(accountKey(OWNER), async () => OWNER, { signOut, refresh }, refreshed);
    await settle();
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(signOut).not.toHaveBeenCalled();
  });

  it("the Landing for someone signed out: nothing is read and nothing happens", async () => {
    const read = vi.fn(async () => null);
    const signOut = vi.fn();
    const refresh = vi.fn();
    expect(startSignedOutSync(null, read, { signOut, refresh }, new Set())).toBeUndefined();
    await settle();
    expect(read).not.toHaveBeenCalled();
    expect(signOut).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("Log in and Register: the answer is shown, and nobody also signs the stale session out", () => {
    const show = vi.fn();
    const end = vi.fn();
    const key = accountKey(OWNER)!;
    const onAnswer = showAndEndStale(show, end);

    onAnswer({ key, account: OWNER });
    expect(show).toHaveBeenLastCalledWith({ key, account: OWNER });
    expect(end).not.toHaveBeenCalled();

    onAnswer({ key, account: null });
    expect(show).toHaveBeenLastCalledWith({ key, account: null });
    expect(end).toHaveBeenCalledTimes(1);
  });

  it("renders nothing, so the signed-out page's HTML is unchanged", async () => {
    vi.doMock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
    const { createElement } = await import("react");
    const { renderToString } = await import("react-dom/server");
    const { SessionContext } = await import("next-auth/react");
    const { ServerSignedOutSync } = await import("./server-signed-out-sync");
    expect(renderToString(createElement(ServerSignedOutSync))).toBe("");
    expect(
      renderToString(
        createElement(
          SessionContext.Provider as never,
          { value: { status: "authenticated", data: { user: OWNER, expires: "2099-01-01T00:00:00Z" } } } as never,
          createElement(ServerSignedOutSync),
        ),
      ),
    ).toBe("");
  });
});
