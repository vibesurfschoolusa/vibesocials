import { describe, expect, it, vi } from "vitest";

import { confirmNewAddress } from "./confirmNewAddress";

function respond(status: number, body: unknown) {
  return vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
}

// R5 new-customer L4: the page the link sent to the new address opens.
describe("confirmNewAddress", () => {
  it("posts the token", async () => {
    const ok = respond(200, { ok: true, viewer: "signed_out", email: "new@example.com" });
    await confirmNewAddress(ok, "tok");
    expect(ok).toHaveBeenCalledWith(
      "/api/auth/change-email/confirm",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ token: "tok" }) }),
    );
  });

  // Review item 2: only the account that changed is signed out here.
  it("signed in to the account that changed: names the new address, signs this browser out, says to log in", async () => {
    const view = await confirmNewAddress(respond(200, { ok: true, viewer: "this_account", email: "new@example.com" }), "tok");
    expect(view).toMatchObject({ changed: true, signOutHere: true, title: "Your sign-in email was changed", offerRetry: false });
    expect(view.message).toContain("new@example.com");
    expect(view.message).toContain("log in again");
    expect(view.next).toEqual({ href: "/login", label: "Log in" });
  });

  it("signed out: names the new address and points to log in, with nothing to sign out", async () => {
    const view = await confirmNewAddress(respond(200, { ok: true, viewer: "signed_out", email: "new@example.com" }), "tok");
    expect(view).toMatchObject({ changed: true, signOutHere: false });
    expect(view.message).toContain("new@example.com");
    expect(view.next).toEqual({ href: "/login", label: "Log in" });
  });

  it("signed in to another account: stays signed in and reads a neutral sentence", async () => {
    const view = await confirmNewAddress(respond(200, { ok: true, viewer: "other_account" }), "tok");
    expect(view).toMatchObject({ changed: true, signOutHere: false });
    expect(view.message).toBe(
      "The sign-in email of that account was changed. Whoever uses it logs in again with the new address. You are still signed in here.",
    );
    expect(view.next).toEqual({ href: "/", label: "Continue to Vibe Socials" });
  });

  it("shows the route's own sentence for a dead link or a taken address, without a retry", async () => {
    for (const status of [400, 409, 429]) {
      const view = await confirmNewAddress(respond(status, { error: `Sentence ${status}.` }), "tok");
      expect(view).toMatchObject({ changed: false, signOutHere: false, message: `Sentence ${status}.`, offerRetry: false });
    }
  });

  // R6-pages L1: a used link opened again (most likely by whoever just used
  // it) is answered about the link, not with "Your email wasn't changed".
  it("titles a used link as used, with the route's sentence and no retry", async () => {
    const sentence = "This link was already used. If you just confirmed it, your email has changed.";
    const view = await confirmNewAddress(respond(400, { error: sentence, used: true }), "tok");
    expect(view).toMatchObject({
      changed: false,
      signOutHere: false,
      offerRetry: false,
      title: "This link was already used",
      message: sentence,
    });
  });

  it("offers a retry after a server failure", async () => {
    const view = await confirmNewAddress(respond(500, { error: "Server sentence." }), "tok");
    expect(view).toMatchObject({ changed: false, message: "Server sentence.", offerRetry: true });
  });

  // R5 pages L7: no network is not an invalid link.
  it("tells a network failure from a bad link and offers a retry", async () => {
    const offline = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;
    const view = await confirmNewAddress(offline, "tok");
    expect(view.title).toBe("We couldn't reach Vibe Socials");
    expect(view.message).toContain("this link still works");
    expect(view.offerRetry).toBe(true);
  });

  it("calls a link without a token not valid, without asking the server", async () => {
    const spy = respond(200, {});
    const view = await confirmNewAddress(spy, "");
    expect(spy).not.toHaveBeenCalled();
    expect(view).toMatchObject({ changed: false, title: "This link isn't valid", offerRetry: false });
  });
});
