import { describe, expect, it, vi } from "vitest";

import { undoEmailChange } from "./undoChange";

function respond(status: number, body: unknown) {
  return vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
}

// Review item 1: the page the "This wasn't me: undo" link opens.
describe("undoEmailChange", () => {
  it("posts the token and, on success, names the restored address and says to reset the password", async () => {
    const ok = respond(200, { ok: true, email: "old@example.com" });
    const view = await undoEmailChange(ok, "tok");
    expect(ok).toHaveBeenCalledWith(
      "/api/auth/change-email/undo",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ token: "tok" }) }),
    );
    expect(view).toMatchObject({ undone: true, title: "The change was undone", offerRetry: false });
    expect(view.message).toBe(
      "Your account signs in with old@example.com again, and every device was signed out. Reset your password now: whoever changed the email may know it.",
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
    expect(view.message).toContain("Check your internet connection");
  });

  it("calls a link without a token not valid, without asking the server", async () => {
    const spy = respond(200, {});
    const view = await undoEmailChange(spy, "");
    expect(spy).not.toHaveBeenCalled();
    expect(view).toMatchObject({ undone: false, title: "This link isn't valid", offerRetry: false });
  });
});
