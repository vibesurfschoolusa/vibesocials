import { describe, expect, it, vi } from "vitest";

const { getSessionMock } = vi.hoisted(() => ({ getSessionMock: vi.fn() }));

vi.mock("next-auth/react", async () => {
  const { createContext } = await import("react");
  return { getSession: getSessionMock, SessionContext: createContext(undefined) };
});

import { accountKey, readServerAccount, shownAccount, startServerCheck } from "./signed-in-swap";

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
