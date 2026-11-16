import { describe, expect, it, vi } from "vitest";

import { undoEmailChange } from "./undoChange";

function respond(status: number, body: unknown) {
  return vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
}

// Review item 1: the page the "This wasn't me: undo" link opens.
describe("undoEmailChange", () => {
  it("posts the token and, on success, says the email is back and a reset link went there", async () => {
    const ok = respond(200, { ok: true, email: "old@example.com", resetSent: true });
    const view = await undoEmailChange(ok, "tok");
    expect(ok).toHaveBeenCalledWith(
      "/api/auth/change-email/undo",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ token: "tok" }) }),
    );
    expect(view).toMatchObject({ undone: true, title: "The change was undone", offerRetry: false });
    expect(view.message).toBe(
      "Your email is back to old@example.com. We sent a password reset link there; set a new password to sign in.",
    );
    expect(view.next).toEqual({ href: "/forgot-password", label: "Send another reset link" });
  });

  it("says to use Forgot password when the reset link could not be sent", async () => {
    const view = await undoEmailChange(respond(200, { ok: true, email: "old@example.com", resetSent: false }), "tok");
    expect(view.message).toBe(
      "Your email is back to old@example.com. We couldn't send a password reset link just now: press Reset your password below to get one, then set a new password to sign in.",
    );
    expect(view.next).toEqual({ href: "/forgot-password", label: "Reset your password" });
  });

  it("shows the route's sentence for a used, expired or overtaken link, without a retry", async () => {
    for (const status of [400, 409, 429]) {
      const view = await undoEmailChange(respond(status, { error: `Sentence ${status}.` }), "tok");
      expect(view).toMatchObject({ undone: false, title: "The change wasn't undone", message: `Sentence ${status}.`, offerRetry: false });
    }
  });

  it("offers a retry after a server failure or no network", async () => {
    expect((await undoEmailChange(respond(500, { error: "Server." }), "tok")).offerRetry).toBe(true);
    const offline = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;
    const view = await undoEmailChange(offline, "tok");
    expect(view.offerRetry).toBe(true);
    // R28 NN2: the undo may have gone through before the answer was lost.
    expect(view.title).toBe("Vibe Socials didn't answer");
    expect(view.message).toBe(
      "Vibe Socials' answer didn't reach you, so the change may have been undone. If your connection dropped, reconnect first. Then press Try again to see.",
    );
    const failed = await undoEmailChange(respond(502, null), "tok");
    expect(failed.message).toBe("The change may not have been undone. Press Try again in a minute to see.");
  });

  it("calls a link without a token not valid, without asking the server", async () => {
    const spy = respond(200, {});
    const view = await undoEmailChange(spy, "");
    expect(spy).not.toHaveBeenCalled();
    expect(view).toMatchObject({ undone: false, title: "This link isn't valid", offerRetry: false });
  });
});
