import { describe, expect, it, vi } from "vitest";

vi.mock("next-auth/react", () => ({ getSession: vi.fn(async () => null), signOut: vi.fn() }));

import { credentialsSignInChecked, googleSignInChecked, signInReachable } from "./signInChecked";
import { SIGN_IN_LIMITED, SIGN_IN_UNCHECKED, signInLimitedCode } from "./signInErrorCodes";

type Answers = Partial<Record<"providers" | "csrf" | "session", () => Promise<Response>>>;

const ok: Required<Answers> = {
  providers: async () => Response.json({ credentials: { id: "credentials" }, google: { id: "google" } }),
  csrf: async () => Response.json({ csrfToken: "token-1" }),
  session: async () => Response.json({ user: { email: "a@example.test" }, expires: "2027-01-01T00:00:00.000Z" }),
};

/** /api/auth/<name> answered by `answers`, the rest as a working server. */
function server(answers: Answers = {}) {
  return vi.fn(async (input: string) => {
    const name = input.replace("/api/auth/", "") as keyof Answers;
    return ({ ...ok, ...answers })[name]();
  }) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
}

const offline = async (): Promise<Response> => {
  throw new TypeError("Failed to fetch");
};
const gateway = async () => new Response("<html>Bad gateway</html>", { status: 502, headers: { "content-type": "text/html" } });

const accepted = { ok: true, error: null, status: 200, url: "http://localhost/dashboard" };

describe("signInReachable: providers and csrf, through fetchOrNoAnswer", () => {
  it("is true when both come back", async () => {
    const fetchImpl = server();
    await expect(signInReachable(fetchImpl)).resolves.toBe(true);
    expect(fetchImpl).toHaveBeenCalledWith("/api/auth/providers", { cache: "no-store" });
    expect(fetchImpl).toHaveBeenCalledWith("/api/auth/csrf", { cache: "no-store" });
  });

  // R31 new-customer L4: next-auth turns an unreadable csrf answer into a
  // POST without a token, which the server refuses with ?csrf=true.
  it("is false when the csrf token doesn't come back: offline, a gateway's page, a 5xx of ours, no token", async () => {
    for (const csrf of [offline, gateway, async () => Response.json({ error: "x" }, { status: 500 }), async () => Response.json({})]) {
      await expect(signInReachable(server({ csrf }))).resolves.toBe(false);
    }
  });

  it("is false when the providers list doesn't come back", async () => {
    for (const providers of [offline, gateway, async () => Response.json(null)]) {
      await expect(signInReachable(server({ providers }))).resolves.toBe(false);
    }
  });
});

describe("credentialsSignInChecked", () => {
  it("done only when the answer is clean and the session read names someone", async () => {
    const signIn = vi.fn(async () => accepted);
    const fetchImpl = server();
    await expect(credentialsSignInChecked(signIn, "a@example.test", "secret12", fetchImpl)).resolves.toEqual({ ok: true });
    expect(signIn).toHaveBeenCalledWith("credentials", { redirect: false, email: "a@example.test", password: "secret12" });
    expect(fetchImpl).toHaveBeenCalledWith("/api/auth/session", { cache: "no-store" });
  });

  it("unreachable before the press: not sent, and signIn is never called", async () => {
    const signIn = vi.fn(async () => accepted);
    await expect(credentialsSignInChecked(signIn, "a@example.test", "x", server({ csrf: gateway }))).resolves.toEqual({
      ok: false,
      reason: "not_sent",
    });
    expect(signIn).not.toHaveBeenCalled();
  });

  it("a refused password, or no answer object: refused", async () => {
    for (const answer of [{ ok: false, error: "CredentialsSignin", status: 401, url: null }, undefined, null]) {
      await expect(credentialsSignInChecked(vi.fn(async () => answer), "a@example.test", "x", server())).resolves.toEqual({
        ok: false,
        reason: "refused",
      });
    }
  });

  // R32 new-customer L1: authorize's thrown code comes back as signIn's error
  // (next-auth puts the message into ?error=, react/index.js reads it back).
  it("authorize's codes: a used-up sign-in limit, and a password that couldn't be checked", async () => {
    const answer = (error: string) => vi.fn(async () => ({ ok: false, error, status: 401, url: null }));
    await expect(credentialsSignInChecked(answer(SIGN_IN_LIMITED), "a@example.test", "x", server())).resolves.toEqual({
      ok: false,
      reason: "limited",
      waitMinutes: null,
    });
    await expect(credentialsSignInChecked(answer(signInLimitedCode(720)), "a@example.test", "x", server())).resolves.toEqual({
      ok: false,
      reason: "limited",
      waitMinutes: 12,
    });
    await expect(credentialsSignInChecked(answer(SIGN_IN_UNCHECKED), "a@example.test", "x", server())).resolves.toEqual({
      ok: false,
      reason: "unchecked",
    });
    // Any other error (an old server's database message included) stays refused.
    await expect(credentialsSignInChecked(answer("Can't reach database"), "a@example.test", "x", server())).resolves.toEqual({
      ok: false,
      reason: "refused",
    });
  });

  // R31 new-customer L4: next-auth's own csrf read failed after ours: a 200 whose url says csrf=true.
  it("an answer whose url says csrf=true is unfinished, not success", async () => {
    const signIn = vi.fn(async () => ({ ok: true, error: null, status: 200, url: "http://localhost/login?csrf=true" }));
    await expect(credentialsSignInChecked(signIn, "a@example.test", "x", server())).resolves.toEqual({
      ok: false,
      reason: "unfinished",
    });
  });

  it("a clean answer whose session read names nobody is unfinished", async () => {
    for (const session of [async () => Response.json({}), async () => Response.json({ user: null })]) {
      await expect(
        credentialsSignInChecked(vi.fn(async () => accepted), "a@example.test", "x", server({ session })),
      ).resolves.toEqual({ ok: false, reason: "unfinished" });
    }
  });

  it("a session read that gets no answer is a lost answer (the cookie may be set)", async () => {
    for (const session of [offline, gateway]) {
      await expect(
        credentialsSignInChecked(vi.fn(async () => accepted), "a@example.test", "x", server({ session })),
      ).resolves.toEqual({ ok: false, reason: "lost" });
    }
  });

  it("a throw from signIn after the checks is a lost answer", async () => {
    const signIn = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    await expect(credentialsSignInChecked(signIn, "a@example.test", "x", server())).resolves.toEqual({ ok: false, reason: "lost" });
  });
});

// R31 lead review: with pages.signIn set, next-auth turns /signin?csrf=true
// into /login?callbackUrl=... with no sign of it, so the Google press can't
// leave it to next-auth's signIn (whose own second csrf read could fail).
// The helper makes the same POST itself with the token it just read.
describe("googleSignInChecked", () => {
  type Answer = () => Promise<Response>;
  function google(answer: Answer, answers: Answers = {}) {
    const fetchImpl = vi.fn(async (input: string, init?: RequestInit) => {
      if (input === "/api/auth/signin/google") return answer();
      const name = input.replace("/api/auth/", "") as keyof Answers;
      void init;
      return ({ ...ok, ...answers })[name]();
    }) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
    const navigate = vi.fn();
    return { fetchImpl, navigate, run: () => googleSignInChecked("/queue", fetchImpl, navigate) };
  }
  const toGoogle = "https://accounts.google.com/o/oauth2/v2/auth?client_id=x&state=y";

  it("success: posts next-auth's own request with the token it read, then leaves for the answer's url", async () => {
    const { fetchImpl, navigate, run } = google(async () => Response.json({ url: toGoogle }));
    await expect(run()).resolves.toEqual({ ok: true });
    const post = fetchImpl.mock.calls.find(([input]) => input === "/api/auth/signin/google");
    expect(post?.[1]).toMatchObject({
      method: "post",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    });
    const body = new URLSearchParams(String(post?.[1]?.body));
    expect(Object.fromEntries(body)).toEqual({ callbackUrl: "/queue", csrfToken: "token-1", json: "true" });
    expect(navigate).toHaveBeenCalledWith(toGoogle);
  });

  // R31 lead review 2: the server was reached, so "couldn't be reached" isn't true.
  it("an answer whose url says csrf=true or has an error, or has no url: not started, and the page stays", async () => {
    const answers: Answer[] = [
      async () => Response.json({ url: "http://localhost/api/auth/signin?csrf=true" }),
      async () => Response.json({ url: "http://localhost/login?callbackUrl=%2Fqueue&error=OAuthSignin" }),
      async () => Response.json({}),
      async () => Response.json({ error: "x" }, { status: 400 }),
    ];
    for (const answer of answers) {
      const { navigate, run } = google(answer);
      await expect(run()).resolves.toEqual({ ok: false, reason: "not_started" });
      expect(navigate).not.toHaveBeenCalled();
    }
  });

  it("a lost answer, a gateway's 5xx, or our own 5xx: not sent, and the page stays", async () => {
    const answers: Answer[] = [offline, gateway, async () => Response.json({ error: "x" }, { status: 500 })];
    for (const answer of answers) {
      const { navigate, run } = google(answer);
      await expect(run()).resolves.toEqual({ ok: false, reason: "not_sent" });
      expect(navigate).not.toHaveBeenCalled();
    }
  });

  it("unreachable before the press: nothing is posted", async () => {
    const { fetchImpl, navigate, run } = google(async () => Response.json({ url: toGoogle }), { csrf: offline });
    await expect(run()).resolves.toEqual({ ok: false, reason: "not_sent" });
    expect(fetchImpl.mock.calls.some(([input]) => input === "/api/auth/signin/google")).toBe(false);
    expect(navigate).not.toHaveBeenCalled();
  });
});
