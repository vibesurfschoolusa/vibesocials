import { describe, expect, it, vi } from "vitest";

import { RESET_FAILED_MESSAGE, RESET_MAYBE_CHANGED_MESSAGE, signOutAfterReset, submitReset } from "./resetOutcome";

function respond(status: number, body: unknown = {}, headers: Record<string, string> = {}) {
  return vi.fn(async () => new Response(JSON.stringify(body), { status, headers })) as unknown as typeof fetch;
}
const offline = vi.fn(async () => {
  throw new TypeError("Failed to fetch");
}) as unknown as typeof fetch;

// R15-new-customer L2: the form chooses its message by status, as
// verifyOutcome.ts does, instead of showing the route's own text.
describe("submitReset", () => {
  it("posts the token and the new password", async () => {
    const ok = respond(200, { ok: true });
    await expect(submitReset(ok, "tok", "new-password")).resolves.toEqual({ kind: "done" });
    expect(ok).toHaveBeenCalledWith(
      "/api/auth/reset-password",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ token: "tok", password: "new-password" }) }),
    );
  });

  it("an invalid or expired link (400) is the invalid-link state, not the route's text", async () => {
    const outcome = await submitReset(respond(400, { error: "This link is invalid or has expired." }), "tok", "new-password");
    expect(outcome).toEqual({ kind: "invalid_link" });
  });

  it("too many tries (429) says how long to wait, from the answer", async () => {
    const outcome = await submitReset(
      respond(429, { error: "Too many requests. Please slow down.", retryAfterSeconds: 600 }),
      "tok",
      "new-password",
    );
    expect(outcome).toEqual({
      kind: "error",
      message: "Too many tries from this network, so your password wasn't changed. Wait 10 minutes, then try again.",
    });
  });

  it("too many tries reads Retry-After when the body has no number, and says 1 minute for under a minute", async () => {
    const outcome = await submitReset(respond(429, {}, { "Retry-After": "20" }), "tok", "new-password");
    expect(outcome).toEqual({
      kind: "error",
      message: "Too many tries from this network, so your password wasn't changed. Wait 1 minute, then try again.",
    });
  });

  it("too many tries with no time at all waits the whole 15-minute window", async () => {
    const outcome = await submitReset(respond(429, "not json"), "tok", "new-password");
    expect(outcome).toEqual({
      kind: "error",
      message: "Too many tries from this network, so your password wasn't changed. Wait 15 minutes, then try again.",
    });
  });

  it("a server failure (5xx) is RESET_FAILED_MESSAGE, not the route's text", async () => {
    await expect(submitReset(respond(500, { error: "Failed to reset password." }), "tok", "new-password")).resolves.toEqual({
      kind: "error",
      message: RESET_FAILED_MESSAGE,
    });
    await expect(submitReset(respond(503), "tok", "new-password")).resolves.toEqual({
      kind: "error",
      message: RESET_FAILED_MESSAGE,
    });
  });

  // R28 NN2 (new-customer L2): the reset may have gone through, and a retry
  // would then show the dead-link card.
  it("no answer: the password may have changed", async () => {
    await expect(submitReset(offline, "tok", "new-password")).resolves.toEqual({ kind: "error", message: RESET_MAYBE_CHANGED_MESSAGE });
  });
});

describe("reset password failure sentences", () => {
  it("say what happened and what to do", () => {
    expect(RESET_FAILED_MESSAGE).toBe("Your password wasn't changed. Try again in a minute.");
    expect(RESET_MAYBE_CHANGED_MESSAGE).toBe(
      "Vibe Socials' answer didn't reach you, so your password may have changed. If your connection dropped, reconnect first. Then log in with your new password. If that doesn't work, request a new link: this one may be used up.",
    );
  });
});

// R18 new-customer L1 (= security L1, pages L1): the reset ended the session on
// the server, so this browser signs out too and "Log in" opens the form.
describe("signOutAfterReset", () => {
  it("signs this browser out once after a successful reset, staying on the page", async () => {
    const signOut = vi.fn(async () => undefined);
    await signOutAfterReset({ kind: "done" }, signOut);
    expect(signOut).toHaveBeenCalledTimes(1);
    expect(signOut).toHaveBeenCalledWith({ redirect: false });
  });

  it("leaves the session alone when the password was not changed", async () => {
    const signOut = vi.fn(async () => undefined);
    await signOutAfterReset({ kind: "invalid_link" }, signOut);
    await signOutAfterReset({ kind: "error", message: RESET_FAILED_MESSAGE }, signOut);
    expect(signOut).not.toHaveBeenCalled();
  });

  it("does not fail when signing out fails, so the success message still shows", async () => {
    const signOut = vi.fn(async () => {
      throw new Error("offline");
    });
    await expect(signOutAfterReset({ kind: "done" }, signOut)).resolves.toBeUndefined();
  });
});
