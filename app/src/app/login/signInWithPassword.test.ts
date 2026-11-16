import { describe, expect, it, vi } from "vitest";

const { getSessionMock } = vi.hoisted(() => ({ getSessionMock: vi.fn(async () => null) }));
vi.mock("next-auth/react", () => ({ getSession: getSessionMock, signOut: vi.fn() }));

import { signInReachable } from "@/lib/signInChecked";

import {
  GOOGLE_NOT_SENT_MESSAGE,
  LOGIN_FAILED_MESSAGE,
  LOGIN_NOT_SENT_MESSAGE,
  LOGIN_UNFINISHED_MESSAGE,
  LOGIN_UNREACHABLE_MESSAGE,
  REGISTER_SIGN_IN_LOST_MESSAGE,
  REGISTER_SIGN_IN_UNFINISHED_MESSAGE,
  signInAfterRegister,
  signInWithPassword as signInWithPasswordUnder,
} from "./signInWithPassword";

/** next-auth's providers list, csrf token and session, as a working server answers them. */
function serverAnswers(session: () => Response = () => Response.json({ user: { email: "a@example.test" } })) {
  return vi.fn(async (input: string) => {
    if (input === "/api/auth/providers") return Response.json({ credentials: { id: "credentials" } });
    if (input === "/api/auth/csrf") return Response.json({ csrfToken: "token-1" });
    return session();
  }) as unknown as typeof fetch;
}
const providersAnswer = serverAnswers();
const signInWithPassword = (signIn: Parameters<typeof signInWithPasswordUnder>[0], email: string, password: string) =>
  signInWithPasswordUnder(signIn, email, password, providersAnswer);

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
    const fetchImpl = serverAnswers();
    await expect(signInReachable(fetchImpl)).resolves.toBe(true);
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
      // Lead review: a 201 also comes for an email that already had an account.
      "Signing you in didn't finish. Log in with your email and password.",
    );
  });
});

// R31 new-customer L4: next-auth's own csrf read failed: a 200 whose url says csrf=true, nobody signed in.
describe("signInWithPassword counts a sign-in only when it happened", () => {
  it("an answer whose url says csrf=true, or a session naming nobody: the page's sentence, not success", async () => {
    const csrf = vi.fn(async () => ({ ok: true, error: null, status: 200, url: "http://localhost/login?csrf=true" }));
    await expect(signInWithPassword(csrf, "a@example.test", "x")).resolves.toEqual({ ok: false, error: LOGIN_UNFINISHED_MESSAGE });
    const nobody = serverAnswers(() => Response.json({}));
    await expect(signInWithPasswordUnder(vi.fn(async () => ({ ok: true })), "a@example.test", "x", nobody)).resolves.toEqual({
      ok: false,
      error: LOGIN_UNFINISHED_MESSAGE,
    });
    expect(LOGIN_UNFINISHED_MESSAGE).toBe("Signing you in didn't finish, so you aren't signed in. Press Sign in again.");
  });
});

// R31 new-customer L1, L4: Register's automatic sign-in.
describe("signInAfterRegister", () => {
  const run = (signIn: Parameters<typeof signInAfterRegister>[0], fetchImpl: typeof fetch = serverAnswers()) =>
    signInAfterRegister(signIn, "a@example.test", "secret12", fetchImpl);

  it("signed in: ok", async () => {
    await expect(run(vi.fn(async () => ({ ok: true })))).resolves.toEqual({ ok: true });
  });

  it("refused (the email had an account with another password): to Log in", async () => {
    await expect(run(vi.fn(async () => ({ ok: false, error: "CredentialsSignin" })))).resolves.toEqual({ ok: false, toLogin: true });
  });

  it("a throw: stays with the lost-answer sentence, never to Log in", async () => {
    const thrown = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    await expect(run(thrown)).resolves.toEqual({ ok: false, error: REGISTER_SIGN_IN_LOST_MESSAGE });
    expect(REGISTER_SIGN_IN_LOST_MESSAGE).toBe(
      "Vibe Socials' answer didn't reach you, so you may be signed in. If your connection dropped, reconnect first. Reload the page to see, or log in with your email and password.",
    );
  });

  it("not sent, or unfinished (csrf=true): stays and says to log in", async () => {
    const offline = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;
    await expect(run(vi.fn(async () => ({ ok: true })), offline)).resolves.toEqual({
      ok: false,
      error: REGISTER_SIGN_IN_UNFINISHED_MESSAGE,
    });
    const csrf = vi.fn(async () => ({ ok: true, error: null, url: "http://localhost/register?csrf=true" }));
    await expect(run(csrf)).resolves.toEqual({ ok: false, error: REGISTER_SIGN_IN_UNFINISHED_MESSAGE });
  });
});

describe("every sign-in entry point goes through signInChecked", () => {
  const read = async (path: string) => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    return readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");
  };

  it("Continue with Google: a failed press shows GOOGLE_NOT_SENT_MESSAGE, never only stops the spinner", async () => {
    const source = await read("../../components/google-sign-in-button.tsx");
    expect(source).toContain("googleSignInChecked(callbackUrl)");
    // R31 lead review: no next-auth signIn for Google (its second csrf read failed silently).
    expect(source).not.toMatch(/\bsignIn\b/);
    expect(source).toMatch(/if \(!result\.ok\) \{\s+setError\(GOOGLE_NOT_SENT_MESSAGE\);\s+setLoading\(false\);/);
    expect(source).not.toMatch(/signIn\("google"/);
    expect(source).toMatch(/<p role="alert"[^>]*>\s*\{error\}/);
  });

  it("Register: through signInAfterRegister; Log in only on a refusal; no bare signIn call", async () => {
    const source = await read("../register/register-form.tsx");
    expect(source).toContain("await signInAfterRegister(signIn, email, password)");
    expect(source).not.toMatch(/signIn\("credentials"/);
    expect(source).toMatch(/if \("toLogin" in outcome\) \{\s+router\.push\(`\/login\?registered=1/);
    expect(source.match(/router\.push\(/g)).toHaveLength(2);
    const register = source.indexOf('fetchOrNoAnswer("/api/auth/register"');
    expect(register).toBeGreaterThan(0);
    expect(source.indexOf("signInAfterRegister(signIn")).toBeGreaterThan(register);
  });

  it("Log in: through signInWithPassword, which uses credentialsSignInChecked", async () => {
    expect(await read("./page.tsx")).toContain("await signInWithPassword(signIn, email, password)");
    expect(await read("./signInWithPassword.ts")).toContain("credentialsSignInChecked(signIn, email, password, fetchImpl)");
  });
});
