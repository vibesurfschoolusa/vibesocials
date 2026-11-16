import { describe, expect, it, vi } from "vitest";

import { confirmNewAddress } from "./confirmNewAddress";

function respond(status: number, body: unknown) {
  return vi.fn(
    async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }),
  ) as unknown as typeof fetch;
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

  // The server writes its dates in its own zone; the page writes these two
  // refusals again from `until`, in the viewer's.
  it("writes the undo-window refusals from the date the server sends", async () => {
    const until = "2026-11-17T12:00:00.000Z";
    const locked = await confirmNewAddress(respond(409, { error: "server", reason: "locked", until }), "tok");
    expect(locked).toMatchObject({
      changed: false,
      offerRetry: false,
      title: "Your email wasn't changed",
      message: "You changed your email recently; you can change it again after November 17, 2026.",
    });
    const held = await confirmNewAddress(respond(409, { error: "server", reason: "held", until }), "tok");
    expect(held.message).toBe(
      "This address was another Vibe Socials account's sign-in email until recently, and that account can take it back until November 17, 2026, so your email is unchanged. After that, ask for the change again in Settings, Account.",
    );
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
    // R28 NN2: the change may have been made before the answer was lost; Try
    // again then says the link was already used.
    expect(view.title).toBe("Vibe Socials didn't answer");
    expect(view.message).toBe(
      "Vibe Socials' answer didn't reach you, so your sign-in email may have changed. If your connection dropped, reconnect first. Then press Try again to see.",
    );
    expect(view.offerRetry).toBe(true);
  });

  it("a server failure without a sentence never says the email is unchanged", async () => {
    const view = await confirmNewAddress(respond(502, null), "tok");
    expect(view.message).toBe("Your sign-in email may not have changed. Press Try again in a minute to see.");
    expect(view.offerRetry).toBe(true);
  });

  // R29 OO1: a gateway's page can come after the change was made.
  it("an unreadable 5xx (a gateway's page) is a lost answer: the email may have changed", async () => {
    const gateway = vi.fn(async () => new Response("<html>504</html>", { status: 504, headers: { "content-type": "text/html" } }));
    const view = await confirmNewAddress(gateway as unknown as typeof fetch, "tok");
    expect(view.title).toBe("Vibe Socials didn't answer");
    expect(view.message).toContain("your sign-in email may have changed");
    expect(view.offerRetry).toBe(true);
  });

  // R29 OO1 (security L2): once a change's row is cleared, the route can't
  // tell an expired link from one already used, so the page claims neither.
  it("a dead link (no row, or expired) gets a neutral title and the route's sentence", async () => {
    const sentence =
      "This link has expired or was already used. If you already confirmed the change, sign in with the new address. If not, ask for the change again in Settings, Account.";
    const view = await confirmNewAddress(respond(400, { error: sentence, reason: "not_valid" }), "tok");
    expect(view).toMatchObject({ changed: false, offerRetry: false, title: "This link can't be used", message: sentence });
    expect(view.title).not.toMatch(/wasn't changed|unchanged/);
  });

  it("calls a link without a token not valid, without asking the server", async () => {
    const spy = respond(200, {});
    const view = await confirmNewAddress(spy, "");
    expect(spy).not.toHaveBeenCalled();
    expect(view).toMatchObject({ changed: false, title: "This link isn't valid", offerRetry: false });
  });
});
