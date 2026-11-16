import { describe, expect, it, vi } from "vitest";

vi.mock("next-auth/react", () => ({ getSession: vi.fn(async () => null), signOut: vi.fn() }));

import { SIGN_OUT_FAILED_MESSAGE, signOutChecked } from "./signOutChecked";

type Name = "csrf" | "signout" | "session";
type Answers = Partial<Record<Name, () => Promise<Response>>>;

const ok: Required<Answers> = {
  csrf: async () => Response.json({ csrfToken: "token-1" }),
  signout: async () => Response.json({ url: "http://localhost/" }),
  session: async () => Response.json({}),
};

/** /api/auth/<name> answered by `answers`, the rest as a working server. */
function server(answers: Answers = {}) {
  return vi.fn(async (input: string) => {
    const name = input.replace("/api/auth/", "") as Name;
    return ({ ...ok, ...answers })[name]();
  }) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
}

const offline = async (): Promise<Response> => {
  throw new TypeError("Failed to fetch");
};
const gateway = async () => new Response("<html>Bad gateway</html>", { status: 502, headers: { "content-type": "text/html" } });

// R32 new-customer L2: next-auth 4.24.15's signOut reads its csrf token with
// getCsrfToken (undefined on any unreadable answer), posts anyway, and the
// server answers 200 { url: ".../signout?csrf=true" } and keeps the cookie.
describe("signOutChecked", () => {
  it("success: reads the token, sends next-auth's sign-out request with it, and checks the session names nobody", async () => {
    const fetchImpl = server();
    const tellTabs = vi.fn();
    await expect(signOutChecked(fetchImpl, tellTabs)).resolves.toBe(true);
    expect(fetchImpl).toHaveBeenNthCalledWith(1, "/api/auth/csrf", { cache: "no-store" });
    const [path, init] = fetchImpl.mock.calls[1] as [string, RequestInit];
    expect(path).toBe("/api/auth/signout");
    expect(init.method).toBe("post");
    expect(init.headers).toEqual({ "Content-Type": "application/x-www-form-urlencoded" });
    expect(Object.fromEntries(init.body as URLSearchParams)).toEqual({ csrfToken: "token-1", callbackUrl: "/", json: "true" });
    expect(fetchImpl).toHaveBeenNthCalledWith(3, "/api/auth/session", { cache: "no-store" });
    expect(tellTabs).toHaveBeenCalledTimes(1);
  });

  it("csrf=true in the answer: not signed out, and the session is not trusted", async () => {
    const tellTabs = vi.fn();
    const fetchImpl = server({ signout: async () => Response.json({ url: "http://localhost/api/auth/signout?csrf=true" }) });
    await expect(signOutChecked(fetchImpl, tellTabs)).resolves.toBe(false);
    expect(tellTabs).not.toHaveBeenCalled();
  });

  it("no token: offline, a gateway's page, a 5xx of ours, an empty token: nothing is sent", async () => {
    for (const csrf of [offline, gateway, async () => Response.json({ error: "x" }, { status: 500 }), async () => Response.json({})]) {
      const fetchImpl = server({ csrf });
      await expect(signOutChecked(fetchImpl, vi.fn())).resolves.toBe(false);
      expect(fetchImpl.mock.calls.map(([path]) => path)).toEqual(["/api/auth/csrf"]);
    }
  });

  it("the sign-out's answer is lost or a 5xx: not counted as signed out", async () => {
    for (const signout of [offline, gateway, async () => Response.json({ error: "x" }, { status: 500 }), async () => new Response("not json")]) {
      const tellTabs = vi.fn();
      await expect(signOutChecked(server({ signout }), tellTabs)).resolves.toBe(false);
      expect(tellTabs).not.toHaveBeenCalled();
    }
  });

  it("a session read that still names someone, or that can't be read: not signed out", async () => {
    for (const session of [
      async () => Response.json({ user: { email: "a@example.test" }, expires: "2027-01-01T00:00:00.000Z" }),
      offline,
      gateway,
      async () => Response.json(null),
    ]) {
      const tellTabs = vi.fn();
      await expect(signOutChecked(server({ session }), tellTabs)).resolves.toBe(false);
      expect(tellTabs).not.toHaveBeenCalled();
    }
  });

  it("the failure sentence claims nothing either way", () => {
    expect(SIGN_OUT_FAILED_MESSAGE).toBe(
      "Vibe Socials' answer didn't reach you, so you may be signed out. If your connection dropped, reconnect first. Then reload the page to see.",
    );
  });
});

// One helper for every sign-out press: no page calls next-auth's signOut,
// which can leave for its own "Are you sure you want to sign out?" page.
describe("guard: sign-out presses go through signOutChecked", () => {
  it("no component or page imports next-auth's signOut (endStaleSession's background one is the named exception)", async () => {
    const { readFileSync, readdirSync, statSync } = await import("node:fs");
    const { join } = await import("node:path");
    const root = join(__dirname, "..");
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) {
          const text = readFileSync(path, "utf8");
          if (/import\s*\{[^}]*\bsignOut\b[^}]*\}\s*from\s*"next-auth\/react"/.test(text)) offenders.push(path.slice(root.length + 1).replace(/\\/g, "/"));
        }
      }
    };
    walk(root);
    expect(offenders).toEqual(["lib/staleSignOut.ts"]);
  });
});
