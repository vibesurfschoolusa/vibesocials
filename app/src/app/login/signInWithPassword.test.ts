import { describe, expect, it, vi } from "vitest";

const { getSessionMock } = vi.hoisted(() => ({ getSessionMock: vi.fn(async () => null) }));
vi.mock("next-auth/react", () => ({ getSession: getSessionMock, signOut: vi.fn() }));

import {
  GOOGLE_NOT_SENT_MESSAGE,
  LOGIN_FAILED_MESSAGE,
  LOGIN_NOT_SENT_MESSAGE,
  LOGIN_UNREACHABLE_MESSAGE,
  REGISTER_SIGN_IN_UNFINISHED_MESSAGE,
  signInReachable,
  signInWithPassword as signInWithPasswordUnder,
} from "./signInWithPassword";

/** next-auth's providers list, as /api/auth/providers answers it. */
const providersAnswer = vi.fn(async () => Response.json({ credentials: { id: "credentials" } }));
const signInWithPassword = (signIn: Parameters<typeof signInWithPasswordUnder>[0], email: string, password: string) =>
  signInWithPasswordUnder(signIn, email, password, providersAnswer as unknown as typeof fetch);

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
    // Lead review 3 (R28 NN2): the sign-in may have set the session before the answer was lost.
    expect(LOGIN_UNREACHABLE_MESSAGE).toBe(
      "Vibe Socials' answer didn't reach you, so you may be signed in. If your connection dropped, reconnect first. Then reload the page to see.",
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

// R30 new-customer L2: next-auth's signIn reads /api/auth/providers first and,
// when that fails, sends the browser to /api/auth/error instead of throwing:
// offline, the browser's own error page; a gateway 5xx, /login?error=undefined
// with the typed email and password gone. The page reads it first itself.
describe("signInReachable", () => {
  it("is true when the providers list comes back", async () => {
    const fetchImpl = vi.fn(async () => Response.json({ credentials: { id: "credentials" } }));
    await expect(signInReachable(fetchImpl as unknown as typeof fetch)).resolves.toBe(true);
    expect(fetchImpl).toHaveBeenCalledWith("/api/auth/providers", { cache: "no-store" });
  });

  it("is false offline, on a gateway's page, on a refusal, and on an unreadable list", async () => {
    const answers = [
      async () => {
        throw new TypeError("Failed to fetch");
      },
      async () => new Response("<html>Bad gateway</html>", { status: 502, headers: { "content-type": "text/html" } }),
      async () => Response.json({ error: "x" }, { status: 500 }),
      async () => new Response("nope", { status: 200 }),
      async () => Response.json(null),
    ];
    for (const answer of answers) {
      await expect(signInReachable(vi.fn(answer) as unknown as typeof fetch)).resolves.toBe(false);
    }
  });
});

describe("signInWithPassword when sign-in can't be reached", () => {
  it("says nothing was sent and never calls signIn", async () => {
    const signIn = vi.fn(async () => ({ ok: true }));
    const offline = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    await expect(signInWithPasswordUnder(signIn, "a@example.test", "x", offline as unknown as typeof fetch)).resolves.toEqual({
      ok: false,
      error: LOGIN_NOT_SENT_MESSAGE,
    });
    expect(signIn).not.toHaveBeenCalled();
    expect(LOGIN_NOT_SENT_MESSAGE).toBe(
      "Vibe Socials couldn't be reached, so your email and password weren't sent. If your connection dropped, reconnect first, then press Sign in again.",
    );
  });

  it("the other sentences: Google's press, and Register's automatic sign-in", () => {
    expect(GOOGLE_NOT_SENT_MESSAGE).toBe(
      "Vibe Socials couldn't be reached, so nothing was sent. If your connection dropped, reconnect first, then press Continue with Google again.",
    );
    expect(REGISTER_SIGN_IN_UNFINISHED_MESSAGE).toBe(
      "Your account was created, but signing you in didn't finish. Log in with your email and password.",
    );
  });
});

describe("the Google button and Register read it before signIn", () => {
  const read = async (path: string) => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    return readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");
  };

  it("Continue with Google: unreachable shows the page's sentence and doesn't call signIn", async () => {
    const source = await read("../../components/google-sign-in-button.tsx");
    expect(source).toMatch(
      /if \(!\(await signInReachable\(\)\)\) \{\s+setError\(GOOGLE_NOT_SENT_MESSAGE\);\s+setLoading\(false\);\s+return;\s+\}\s+(?:\/\/[^\n]*\s+)*signIn\("google"/,
    );
    expect(source).toMatch(/<p role="alert"[^>]*>\s*\{error\}/);
  });

  it("Register's automatic sign-in: unreachable keeps the form and says to log in", async () => {
    const source = await read("../register/register-form.tsx");
    expect(source).toMatch(
      /if \(!\(await signInReachable\(\)\)\) \{\s+setError\(REGISTER_SIGN_IN_UNFINISHED_MESSAGE\);\s+setLoading\(false\);\s+return;\s+\}/,
    );
    const reachable = source.indexOf("await signInReachable()");
    expect(reachable).toBeGreaterThan(source.indexOf('fetchOrNoAnswer("/api/auth/register"'));
    expect(reachable).toBeLessThan(source.indexOf('signIn("credentials"'));
  });
});
