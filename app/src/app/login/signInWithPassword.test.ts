import { describe, expect, it, vi } from "vitest";

const { getSessionMock } = vi.hoisted(() => ({ getSessionMock: vi.fn(async () => null) }));
vi.mock("next-auth/react", () => ({ getSession: getSessionMock, signOut: vi.fn() }));

import { LOGIN_FAILED_MESSAGE, LOGIN_UNREACHABLE_MESSAGE, signInWithPassword } from "./signInWithPassword";

// F7 (R1 L7): a sign-in call that never answers (offline, the server down)
// left the spinner on for ever.
describe("signInWithPassword", () => {
  it("is ok when the credentials are accepted", async () => {
    const signIn = vi.fn(async () => ({ ok: true, error: null, status: 200, url: null }));

    await expect(signInWithPassword(signIn, "a@example.test", "secret12")).resolves.toEqual({ ok: true });
    expect(signIn).toHaveBeenCalledWith("credentials", {
      redirect: false,
      email: "a@example.test",
      password: "secret12",
    });
  });

  it("says the email or password is wrong when they are refused", async () => {
    const signIn = vi.fn(async () => ({ ok: false, error: "CredentialsSignin", status: 401, url: null }));

    await expect(signInWithPassword(signIn, "a@example.test", "x")).resolves.toEqual({
      ok: false,
      error: LOGIN_FAILED_MESSAGE,
    });
    expect(LOGIN_FAILED_MESSAGE).toBe("Invalid email or password.");
  });

  it("gives a plain sentence when the call itself fails", async () => {
    const signIn = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });

    await expect(signInWithPassword(signIn, "a@example.test", "x")).resolves.toEqual({
      ok: false,
      error: LOGIN_UNREACHABLE_MESSAGE,
    });
    expect(LOGIN_UNREACHABLE_MESSAGE).toBe(
      "We couldn't reach Vibe Socials. Check your internet connection and try again.",
    );
  });

  it("treats no answer at all as refused", async () => {
    const signIn = vi.fn(async () => undefined);

    await expect(signInWithPassword(signIn, "a@example.test", "x")).resolves.toEqual({
      ok: false,
      error: LOGIN_FAILED_MESSAGE,
    });
  });

  // R21 pages L2: the other tabs hear of an accepted sign-in (getSession()
  // broadcasts by default), so an open page's signed-out line goes.
  it("an accepted sign-in tells the other tabs once; a refused one does not", async () => {
    getSessionMock.mockClear();
    await signInWithPassword(vi.fn(async () => ({ ok: true })), "a@example.test", "secret12");
    expect(getSessionMock).toHaveBeenCalledTimes(1);
    expect(getSessionMock).toHaveBeenCalledWith();
    getSessionMock.mockClear();
    await signInWithPassword(vi.fn(async () => ({ ok: false })), "a@example.test", "x");
    expect(getSessionMock).not.toHaveBeenCalled();
  });
});
