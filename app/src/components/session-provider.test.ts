import { describe, expect, it, vi } from "vitest";

vi.mock("next-auth/react", async () => {
  const { createContext } = await import("react");
  return { SessionProvider: () => null, SessionContext: createContext(undefined), signOut: vi.fn(), getSession: vi.fn() };
});

import { signedOutResponse } from "@/lib/signedOutResponse";
import type { ServerSession } from "@/components/signed-in-swap";

import { SIGNED_OUT_HEADER, watchSignedOutAnswers } from "./session-provider";

const ORIGIN = "https://app.example.test";
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function reply(status: number, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ error: "x" }), { status, headers });
}

/** A window whose fetch answers `answer`, with the listener installed. */
function setup(
  answer: (input: unknown) => Response,
  server: ServerSession = { kind: "signedOut" },
  namesSomeone: () => boolean = () => true,
) {
  const calls: Array<{ input: unknown; self: unknown }> = [];
  const win: { location: { origin: string }; fetch: typeof fetch } = {
    location: { origin: ORIGIN },
    fetch: async function (this: unknown, input: unknown) {
      calls.push({ input, self: this });
      return answer(input);
    } as unknown as typeof fetch,
  };
  const original = win.fetch;
  const read = vi.fn(async (fetchImpl: typeof fetch) => {
    void fetchImpl;
    return server;
  });
  const end = vi.fn();
  const generation = vi.fn(() => 7);
  const stop = watchSignedOutAnswers(win as unknown as Window, { read, end, generation, namesSomeone });
  return { win, original, read, end, stop, calls, generation };
}

const SIGNED_OUT_401 = () => reply(401, { [SIGNED_OUT_HEADER]: "1" });

// R21 pages L3: a 401 in the focused tab gave no sign-in link and the menu still
// said "Signed in as", because nothing re-read the session until the next focus.
describe("signedOutResponse marks its answer for the browser", () => {
  it("carries the signed-out header the listener looks for", () => {
    expect(SIGNED_OUT_HEADER).toBe("x-signed-out");
    expect(signedOutResponse().headers.get(SIGNED_OUT_HEADER)).toBe("1");
  });
});

describe("watchSignedOutAnswers", () => {
  it("a marked 401 from this site's /api/: reads the server, and on signed out ends the session", async () => {
    const { win, read, end, original } = setup(SIGNED_OUT_401);
    const response = await win.fetch("/api/posts", { method: "POST" });
    expect(response.status).toBe(401);
    await settle();
    expect(read).toHaveBeenCalledTimes(1);
    // The read goes out through the unwrapped fetch, so it can never loop.
    const used = read.mock.calls[0][0];
    expect(used).not.toBe(win.fetch);
    expect(original).not.toBe(win.fetch);
    expect(end).toHaveBeenCalledTimes(1);
    expect(end).toHaveBeenCalledWith(7);
  });

  it("hands the page the same response it got", async () => {
    const sent = SIGNED_OUT_401();
    const { win } = setup(() => sent);
    await expect(win.fetch("/api/posts")).resolves.toBe(sent);
  });

  it("calls the browser's fetch on the window, as the browser requires", async () => {
    const { win, calls } = setup(() => reply(200));
    await win.fetch("/api/posts");
    expect(calls[0].self).toBe(win);
  });

  for (const [label, server] of [
    ["unknown (offline)", { kind: "unknown" }],
    ["signed in", { kind: "signedIn", account: { name: "Owner", email: "owner@example.com" } }],
  ] as const) {
    it(`a marked 401 but the server answers ${label}: nothing changes`, async () => {
      const { win, read, end } = setup(SIGNED_OUT_401, server as ServerSession);
      await win.fetch("/api/posts");
      await settle();
      expect(read).toHaveBeenCalledTimes(1);
      expect(end).not.toHaveBeenCalled();
    });
  }

  for (const [label, answer, input] of [
    ["a 401 without the header (TikTok's reconnect answer)", () => reply(401), "/api/tiktok/creator-info"],
    ["a 200", () => reply(200), "/api/posts"],
    ["a marked answer from another site", SIGNED_OUT_401, "https://elsewhere.example.test/api/posts"],
    ["a marked answer outside /api/", SIGNED_OUT_401, "/queue"],
  ] as const) {
    it(`${label}: no read, nothing changes`, async () => {
      const { win, read, end } = setup(answer, { kind: "signedOut" });
      await win.fetch(input);
      await settle();
      expect(read).not.toHaveBeenCalled();
      expect(end).not.toHaveBeenCalled();
    });
  }

  it("understands a full same-site address, a URL and a Request", async () => {
    for (const input of [`${ORIGIN}/api/posts`, new URL(`${ORIGIN}/api/posts`), new Request(`${ORIGIN}/api/posts`)]) {
      const { win, read } = setup(SIGNED_OUT_401);
      await win.fetch(input as never);
      await settle();
      expect(read).toHaveBeenCalledTimes(1);
    }
  });

  it("several marked 401s at once: one read", async () => {
    const { win, read, end } = setup(SIGNED_OUT_401);
    await Promise.all([win.fetch("/api/posts"), win.fetch("/api/connections"), win.fetch("/api/workspaces")]);
    await settle();
    expect(read).toHaveBeenCalledTimes(1);
    expect(end).toHaveBeenCalledTimes(1);
  });

  it("a later marked 401, after the first read finished, reads again", async () => {
    const { win, read } = setup(SIGNED_OUT_401, { kind: "unknown" });
    await win.fetch("/api/posts");
    await settle();
    await win.fetch("/api/posts");
    await settle();
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("the sign-in generation is taken before the read, so a sign-in meanwhile wins", async () => {
    const { win, read, generation } = setup(SIGNED_OUT_401);
    await win.fetch("/api/posts");
    await settle();
    expect(generation.mock.invocationCallOrder[0]).toBeLessThan(read.mock.invocationCallOrder[0]);
  });

  it("installs once and puts the browser's fetch back when stopped", () => {
    const { win, original, stop } = setup(() => reply(200));
    const wrapped = win.fetch;
    const second = watchSignedOutAnswers(win as unknown as Window, { read: vi.fn(), end: vi.fn(), generation: () => 0 });
    expect(win.fetch).toBe(wrapped);
    second();
    expect(win.fetch).toBe(wrapped);
    stop();
    expect(win.fetch).toBe(original);
  });
});

// GG1 review: a visible Activity tab keeps polling after the first 401, and
// each marked 401 used to send another read and another sign-out (each one
// telling every other tab to re-read). Once this tab's session names nobody,
// there is nothing left to end.
describe("watchSignedOutAnswers once this tab's session names nobody", () => {
  it("a marked 401 reads nothing and signs nobody out", async () => {
    const { win, read, end } = setup(SIGNED_OUT_401, { kind: "signedOut" }, () => false);
    await win.fetch("/api/posts");
    await settle();
    expect(read).not.toHaveBeenCalled();
    expect(end).not.toHaveBeenCalled();
  });

  it("polling after the sign-out: the first 401 ends the session, the next ones nothing", async () => {
    let named = true;
    const { win, read, end } = setup(SIGNED_OUT_401, { kind: "signedOut" }, () => named);
    end.mockImplementation(() => {
      named = false;
    });
    for (let poll = 0; poll < 4; poll += 1) {
      await win.fetch("/api/posts");
      await settle();
    }
    expect(read).toHaveBeenCalledTimes(1);
    expect(end).toHaveBeenCalledTimes(1);
  });
});
