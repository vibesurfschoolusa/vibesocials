import { describe, expect, it, vi } from "vitest";

import { confirmNewAddress } from "./confirmNewAddress";

function respond(status: number, body: unknown) {
  return vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
}

// R5 new-customer L4: the page the link sent to the new address opens.
describe("confirmNewAddress", () => {
  it("posts the token and, on success, names the new address and says to log in again", async () => {
    const ok = respond(200, { ok: true, email: "new@example.com" });
    const view = await confirmNewAddress(ok, "tok");
    expect(ok).toHaveBeenCalledWith(
      "/api/auth/change-email/confirm",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ token: "tok" }) }),
    );
    expect(view).toMatchObject({ changed: true, title: "Your sign-in email was changed", offerRetry: false });
    expect(view.message).toContain("new@example.com");
    expect(view.message).toContain("log in again");
    expect(view.next).toEqual({ href: "/login", label: "Log in" });
  });

  it("shows the route's own sentence for a dead link or a taken address, without a retry", async () => {
    for (const status of [400, 409, 429]) {
      const view = await confirmNewAddress(respond(status, { error: `Sentence ${status}.` }), "tok");
      expect(view).toMatchObject({ changed: false, message: `Sentence ${status}.`, offerRetry: false });
    }
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
