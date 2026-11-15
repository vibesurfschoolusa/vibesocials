import { afterEach, describe, expect, it, vi } from "vitest";

const { getSessionMock, signOutMock } = vi.hoisted(() => ({ getSessionMock: vi.fn(), signOutMock: vi.fn() }));

vi.mock("next-auth/react", () => ({ getSession: getSessionMock, signOut: signOutMock }));

import { BroadcastChannel as NextAuthChannel } from "next-auth/client/_utils";

import { beforeSignIn, rereadSessionHere } from "./staleSignOut";

afterEach(() => {
  vi.unstubAllGlobals();
});

// R21 pages L2: in next-auth 4.24.15 a credentials signIn({ redirect: false })
// re-reads only its own tab (react/index.js:273-275 passes event "storage",
// so getSession runs with broadcast: false, :399-402). The other tabs never
// hear of it. getSession() with no options broadcasts (:129-136).
describe("beforeSignIn tells the other tabs about a password sign-in", () => {
  it("an accepted sign-in reads the session once, with the default broadcast", async () => {
    getSessionMock.mockReset().mockResolvedValue({ user: { email: "a@example.test" } });
    const order: string[] = [];
    getSessionMock.mockImplementation(async (...args: unknown[]) => {
      order.push(`getSession(${args.length})`);
      return null;
    });
    await expect(
      beforeSignIn(async () => {
        order.push("signIn");
        return { ok: true, error: null, status: 200, url: "/" };
      }),
    ).resolves.toEqual({ ok: true, error: null, status: 200, url: "/" });
    expect(order).toEqual(["signIn", "getSession(0)"]);
  });

  for (const [label, result] of [
    ["refused", { ok: false, error: "CredentialsSignin", status: 401, url: null }],
    ["no answer", undefined],
  ] as const) {
    it(`a ${label} sign-in tells nobody`, async () => {
      getSessionMock.mockReset();
      await beforeSignIn(async () => result);
      expect(getSessionMock).not.toHaveBeenCalled();
    });
  }

  it("a sign-in that throws tells nobody and still throws", async () => {
    getSessionMock.mockReset();
    await expect(
      beforeSignIn(async () => {
        throw new TypeError("Failed to fetch");
      }),
    ).rejects.toThrow("Failed to fetch");
    expect(getSessionMock).not.toHaveBeenCalled();
  });

  it("a failed broadcast read does not turn a good sign-in into a failure", async () => {
    getSessionMock.mockReset().mockRejectedValue(new Error("storage blocked"));
    await expect(beforeSignIn(async () => ({ ok: true }))).resolves.toEqual({ ok: true });
  });
});

// R21 pages L2: a tab whose session is null is never re-read on focus
// (react/index.js:408-412), and update() does nothing without a session
// (:492-496). The one call that re-reads this tab and sets its context is the
// broadcast receiver (:443-448 -> _getSession({ event: "storage" }) -> :398-405),
// which listens for the window's "storage" event. rereadSessionHere hands it one.
describe("rereadSessionHere", () => {
  class FakeStorageEvent {
    type: string;
    key: string | null;
    newValue: string | null;
    constructor(type: string, init: { key?: string; newValue?: string }) {
      this.type = type;
      this.key = init.key ?? null;
      this.newValue = init.newValue ?? null;
    }
  }

  it("dispatches a storage event that next-auth's own receiver accepts", () => {
    vi.stubGlobal("StorageEvent", FakeStorageEvent);
    const handlers: Array<(event: unknown) => void> = [];
    const win = {
      addEventListener: (type: string, handler: (event: unknown) => void) => {
        if (type === "storage") handlers.push(handler);
      },
      removeEventListener: () => {},
      dispatchEvent: (event: unknown) => {
        for (const handler of handlers) handler(event);
        return true;
      },
    };
    vi.stubGlobal("window", win);
    const received = vi.fn();
    const stop = NextAuthChannel().receive(received);

    rereadSessionHere(win as unknown as Window);

    expect(received).toHaveBeenCalledTimes(1);
    expect(received.mock.calls[0][0]).toMatchObject({ event: "session" });
    stop();
  });

  it("does nothing where there is no StorageEvent (old browser, server)", () => {
    vi.stubGlobal("StorageEvent", undefined);
    const dispatchEvent = vi.fn();
    expect(() => rereadSessionHere({ dispatchEvent } as unknown as Window)).not.toThrow();
    expect(dispatchEvent).not.toHaveBeenCalled();
  });
});
