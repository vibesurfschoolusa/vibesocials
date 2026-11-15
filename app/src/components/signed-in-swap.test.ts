import { describe, expect, it, vi } from "vitest";

const { signOutMock } = vi.hoisted(() => ({ signOutMock: vi.fn() }));

vi.mock("next-auth/react", async () => {
  const { createContext } = await import("react");
  return { signOut: signOutMock, SessionContext: createContext(undefined) };
});

import {
  accountKey,
  endStaleSession,
  readServerSession,
  showAndEndStale,
  shownAccount,
  startServerCheck,
  startSignedOutSync,
  type ServerSession,
} from "./signed-in-swap";

const OWNER = { name: "Owner", email: "owner@example.com" };
const SIGNED_IN: ServerSession = { kind: "signedIn", account: OWNER };
const SIGNED_OUT: ServerSession = { kind: "signedOut" };
const UNKNOWN: ServerSession = { kind: "unknown" };

const answer = (body: string, status = 200) => (async () => new Response(body, { status })) as unknown as typeof fetch;
const offline = (async () => {
  throw new TypeError("Failed to fetch");
}) as unknown as typeof fetch;

// R18 new-customer L1, R19 follow-up: the server's own session, read now, has
// three outcomes. Only a 200 naming nobody is "signed out"; a read that failed
// is "unknown" and must never sign anyone out.
describe("readServerSession: the server's answer", () => {
  it("asks /api/auth/session on this site, with the cookie, past any cache", async () => {
    const fetchImpl = vi.fn(answer(JSON.stringify({ user: OWNER, expires: "2099-01-01T00:00:00Z" })));
    await expect(readServerSession(fetchImpl as unknown as typeof fetch)).resolves.toEqual(SIGNED_IN);
    expect(fetchImpl).toHaveBeenCalledWith("/api/auth/session", { credentials: "same-origin", cache: "no-store" });
  });

  it("a 200 naming nobody is signed out: no cookie, an ended session, a user with no name or email", async () => {
    for (const body of ["{}", '{"expires":"1970-01-01T00:00:00.000Z"}', '{"user":{},"expires":"2099-01-01T00:00:00Z"}']) {
      await expect(readServerSession(answer(body))).resolves.toEqual(SIGNED_OUT);
    }
  });

  it("offline is unknown", async () => {
    await expect(readServerSession(offline)).resolves.toEqual(UNKNOWN);
  });

  it("a 500, a 404 or a body that is not a JSON object is unknown", async () => {
    await expect(readServerSession(answer("{}", 500))).resolves.toEqual(UNKNOWN);
    await expect(readServerSession(answer("{}", 404))).resolves.toEqual(UNKNOWN);
    await expect(readServerSession(answer("<html>oops</html>"))).resolves.toEqual(UNKNOWN);
    await expect(readServerSession(answer('"text"'))).resolves.toEqual(UNKNOWN);
    await expect(readServerSession(answer("null"))).resolves.toEqual(UNKNOWN);
  });
});

describe("the server's answer behind the signed-in notice", () => {
  it("does not ask the server when the cached session is already signed out", () => {
    const read = vi.fn(async () => SIGNED_IN);
    const onAnswer = vi.fn();
    expect(startServerCheck(null, read, onAnswer)).toBeUndefined();
    expect(read).not.toHaveBeenCalled();
    expect(onAnswer).not.toHaveBeenCalled();
  });

  it("passes on the server's answer for the cached account it asked about", async () => {
    const key = accountKey(OWNER)!;
    const onAnswer = vi.fn();
    startServerCheck(key, async () => SIGNED_OUT, onAnswer);
    await vi.waitFor(() => expect(onAnswer).toHaveBeenCalledWith({ key, session: SIGNED_OUT }));
  });

  it("drops an answer that arrives after the page moved on", async () => {
    const key = accountKey(OWNER)!;
    const onAnswer = vi.fn();
    let reply: (value: ServerSession) => void = () => undefined;
    const stop = startServerCheck(key, () => new Promise((resolve) => (reply = resolve)), onAnswer);
    stop?.();
    reply(SIGNED_IN);
    await Promise.resolve();
    await Promise.resolve();
    expect(onAnswer).not.toHaveBeenCalled();
  });

  it("shows the notice only once the server said someone is signed in", () => {
    const key = accountKey(OWNER);
    // Cached signed in, server not answered yet: the form.
    expect(shownAccount(key, null)).toBeNull();
    // Cached signed in, server empty (session ended by a reset): the form.
    expect(shownAccount(key, { key: key!, session: SIGNED_OUT })).toBeNull();
    // Cached signed in, the read failed: the form stays.
    expect(shownAccount(key, { key: key!, session: UNKNOWN })).toBeNull();
    // Cached signed in, server signed in: the notice, with the server's account.
    expect(shownAccount(key, { key: key!, session: SIGNED_IN })).toEqual(OWNER);
    // Cached signed out (Sign out pressed): the form, whatever was answered before.
    expect(shownAccount(null, { key: key!, session: SIGNED_IN })).toBeNull();
    // An answer about another cached account does not count.
    expect(
      shownAccount(accountKey({ name: null, email: "other@example.com" }), { key: key!, session: SIGNED_IN }),
    ).toBeNull();
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
// session still names someone, the session is read again: signed out -> sign
// out (clears the stale cookie and context here and in other tabs); signed in
// (the server page saw a blip) -> refresh the page once; unknown (the read
// failed) -> nothing.
describe("the signed-out page and a cached session that names someone", () => {
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  async function sync(read: () => Promise<ServerSession>, runs = 1) {
    const signOut = vi.fn();
    const refresh = vi.fn();
    const refreshed = new Set<string>();
    for (let run = 0; run < runs; run += 1) {
      startSignedOutSync(accountKey(OWNER), read, { signOut, refresh }, refreshed);
      await settle();
    }
    return { signOut, refresh };
  }

  it("signs out once, without leaving the page", () => {
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

  it("the Landing: a 200 naming nobody -> sign out once, no refresh", async () => {
    const { signOut, refresh } = await sync(() => readServerSession(answer('{"expires":"1970-01-01T00:00:00.000Z"}')));
    expect(signOut).toHaveBeenCalledTimes(1);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("the Landing: a 200 naming the person -> one refresh, no sign-out, even when the check runs again", async () => {
    const body = JSON.stringify({ user: OWNER, expires: "2099-01-01T00:00:00Z" });
    const { signOut, refresh } = await sync(() => readServerSession(answer(body)), 2);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(signOut).not.toHaveBeenCalled();
  });

  it("the Landing offline or on a 500: no sign-out, no refresh", async () => {
    for (const fetchImpl of [offline, answer("{}", 500)]) {
      const { signOut, refresh } = await sync(() => readServerSession(fetchImpl));
      expect(signOut).not.toHaveBeenCalled();
      expect(refresh).not.toHaveBeenCalled();
    }
  });

  it("the Landing for someone signed out: nothing is read and nothing happens", async () => {
    const read = vi.fn(async () => SIGNED_OUT);
    const signOut = vi.fn();
    const refresh = vi.fn();
    expect(startSignedOutSync(null, read, { signOut, refresh }, new Set())).toBeUndefined();
    await settle();
    expect(read).not.toHaveBeenCalled();
    expect(signOut).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("Log in and Register: the notice only on signed in; only signed out ends the stale session", () => {
    const show = vi.fn();
    const end = vi.fn();
    const key = accountKey(OWNER)!;
    const onAnswer = showAndEndStale(show, end);

    // A 200 naming the person: the notice, no sign-out.
    onAnswer({ key, session: SIGNED_IN });
    expect(shownAccount(key, show.mock.lastCall![0])).toEqual(OWNER);
    // Offline or a 500: the form stays, no sign-out.
    onAnswer({ key, session: UNKNOWN });
    expect(shownAccount(key, show.mock.lastCall![0])).toBeNull();
    expect(end).not.toHaveBeenCalled();
    // A 200 naming nobody: the form, and the stale session ends once.
    onAnswer({ key, session: SIGNED_OUT });
    expect(shownAccount(key, show.mock.lastCall![0])).toBeNull();
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
