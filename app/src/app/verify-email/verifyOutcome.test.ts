import { describe, expect, it, vi } from "vitest";

import {
  attemptVerify,
  readAccountState,
  resendVerificationEmail,
  verifyView,
  type AccountState,
  type VerifyAttempt,
} from "./verifyOutcome";

function respond(status: number, body: unknown = {}) {
  return vi.fn(
    async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }),
  ) as unknown as typeof fetch;
}
const offline = vi.fn(async () => {
  throw new TypeError("Failed to fetch");
}) as unknown as typeof fetch;

describe("attemptVerify", () => {
  it("posts the token and reads the answer", async () => {
    const ok = respond(200, { ok: true });
    await expect(attemptVerify(ok, "tok")).resolves.toEqual({ attempt: "ok" });
    expect(ok).toHaveBeenCalledWith("/api/auth/verify-email", expect.objectContaining({ method: "POST", body: JSON.stringify({ token: "tok" }) }));
  });

  // R5 pages L7: a network failure is not an invalid link.
  it("tells apart an invalid link, too many tries, a server failure and no network", async () => {
    await expect(attemptVerify(respond(400), "tok")).resolves.toEqual({ attempt: "invalid" });
    await expect(attemptVerify(respond(429), "tok")).resolves.toEqual({ attempt: "rate_limited" });
    await expect(attemptVerify(respond(500), "tok")).resolves.toEqual({ attempt: "server" });
    await expect(attemptVerify(offline, "tok")).resolves.toEqual({ attempt: "network" });
    // R29 OO1: a gateway's page may come after the link was used: no answer, not the route's failure.
    const gateway = vi.fn(async () => new Response("<html>502</html>", { status: 502, headers: { "content-type": "text/html" } }));
    await expect(attemptVerify(gateway as unknown as typeof fetch, "tok")).resolves.toEqual({ attempt: "network" });
  });

  // R48 pages-a L2: a 429 carries its wait, from the body or else Retry-After.
  it("reads a 429's wait", async () => {
    await expect(attemptVerify(respond(429, { error: "Too many tries.", retryAfterSeconds: 60 }), "tok")).resolves.toEqual({
      attempt: "rate_limited",
      waitSeconds: 60,
    });
    const header = vi.fn(async () => new Response("{}", { status: 429, headers: { "Retry-After": "240" } }));
    await expect(attemptVerify(header as unknown as typeof fetch, "tok")).resolves.toEqual({
      attempt: "rate_limited",
      waitSeconds: 240,
    });
  });

  it("calls a missing token invalid without asking the server", async () => {
    const spy = respond(200);
    await expect(attemptVerify(spy, "")).resolves.toEqual({ attempt: "invalid" });
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("readAccountState", () => {
  it("reads whether the signed-in person is verified", async () => {
    await expect(readAccountState(respond(200, { emailVerified: true }))).resolves.toBe("verified");
    await expect(readAccountState(respond(200, { emailVerified: false }))).resolves.toBe("unverified");
    await expect(readAccountState(respond(401))).resolves.toBe("signed_out");
    await expect(readAccountState(offline)).resolves.toBe("unknown");
  });
});

describe("verifyView", () => {
  const all: AccountState[] = ["verified", "unverified", "signed_out", "unknown"];

  // Review: the link may belong to another account than the one signed in,
  // so a dead link is answered about the link, never about this account.
  const DEAD =
    "This link has expired or was already used. If it is for another account, sign in to that account first.";

  it("a dead link is answered about the link, whoever reads it", () => {
    for (const account of ["unverified", "signed_out", "unknown"] as const) {
      const view = verifyView("invalid", account);
      expect(view.title).toBe("This link isn't valid");
      expect(view.message).toBe(DEAD);
      expect(view.message).not.toContain("already verified");
    }
  });

  // R6-new-customer L6: a verified person who opens a used link again (most
  // likely their own) is told there is nothing left to do. The sentence about
  // the link stays, since it may be another account's.
  it("tells a signed-in, verified person that their email is already verified", () => {
    const view = verifyView("invalid", "verified");
    expect(view.title).toBe("Your email is already verified");
    expect(view.message).toBe(
      "This link has expired or was already used, but the account you're signed in to is already verified, so there's nothing more to do. If the link is for another account, sign in to that account first.",
    );
    expect(view).toMatchObject({ verified: false, offerResend: false, offerRetry: false });
    expect(view.next).toEqual({ href: "/", label: "Continue to Vibe Socials" });
  });

  it("offers a new link only when the signed-in account itself is unverified", () => {
    expect(verifyView("invalid", "unverified").offerResend).toBe(true);
    for (const account of ["verified", "signed_out", "unknown"] as const) {
      expect(verifyView("invalid", account).offerResend).toBe(false);
    }
    for (const attempt of ["ok", "rate_limited", "server", "network"] as const) {
      expect(verifyView(attempt, "unverified").offerResend).toBe(false);
    }
  });

  it("a signed-out visitor is pointed to log in", () => {
    expect(verifyView("invalid", "signed_out").next).toEqual({ href: "/login", label: "Log in" });
  });

  // R5 new-customer L3: a signed-in person is never sent to the login form.
  it("never sends a signed-in person to the login form", () => {
    const attempts: VerifyAttempt[] = ["ok", "invalid", "rate_limited", "server", "network"];
    for (const attempt of attempts) {
      for (const account of ["verified", "unverified"] as const) {
        expect(verifyView(attempt, account).next.href).not.toBe("/login");
      }
    }
  });

  // R28 NN2: the link may have verified the email before the answer was lost;
  // Try again then shows "already verified", so it is the safe next step.
  it("no answer: the email may already be verified, and Try again shows which when signed in", () => {
    for (const account of all.filter((a) => a !== "signed_out")) {
      const view = verifyView("network", account);
      expect(view.title).toBe("Vibe Socials didn't answer");
      expect(view.message).toBe(
        "Vibe Socials' answer didn't reach you, so your email may already be verified. If your connection dropped, reconnect first. Then press Try again to see.",
      );
      expect(view.offerRetry).toBe(true);
    }
  });

  // R29 OO1 (pages L3): Try again can't show a signed-out reader anything:
  // the used link gets the uniform 400, so logging in is the way to see.
  it("no answer, signed out: Try again, or log in to see whether the address is verified", () => {
    const view = verifyView("network", "signed_out");
    expect(view.message).toBe(
      "Vibe Socials' answer didn't reach you, so your email may already be verified. If your connection dropped, reconnect first. Then press Try again, or log in to see whether your address is verified.",
    );
    expect(view.offerRetry).toBe(true);
    expect(view.next).toEqual({ href: "/login", label: "Log in" });
  });

  it("a signed-out Try again that finds the link dead says it may already have verified the email", () => {
    const view = verifyView("invalid", "signed_out", { retried: true });
    expect(view.title).toBe("This link can't be used again");
    expect(view.message).toBe(
      "This link has expired or was already used. It may have verified your email when you first pressed it: log in to see whether your address is verified.",
    );
    expect(view.next).toEqual({ href: "/login", label: "Log in" });
    // The first open of a dead link, and a signed-in retry, read as before.
    expect(verifyView("invalid", "signed_out").title).toBe("This link isn't valid");
    expect(verifyView("invalid", "unverified", { retried: true }).title).toBe("This link isn't valid");
  });

  it("too many tries: says to wait", () => {
    const view = verifyView("rate_limited", "unknown");
    expect(view.message).toContain("Wait 15 minutes");
    expect(view.offerRetry).toBe(false);
  });

  // R48 pages-a L2: the wait the route names, in the shared words (waitText).
  it("too many tries: says the route's own wait", () => {
    expect(verifyView("rate_limited", "unknown", { waitSeconds: 60 }).message).toBe(
      "This network has tried too many links in the last few minutes, so this one wasn't checked. Wait a minute, then reload this page.",
    );
    expect(verifyView("rate_limited", "unknown", { waitSeconds: 600 }).message).toContain("Wait 10 minutes, then");
  });

  it("a server failure says to try again in a minute, and never that the link still works", () => {
    const view = verifyView("server", "unknown");
    expect(view.message).toBe("Your email may not be verified yet. Press Try again in a minute to see.");
    expect(view.offerRetry).toBe(true);
    expect(verifyView("server", "signed_out").message).toBe(
      "Your email may not be verified yet. Press Try again in a minute, or log in to see whether your address is verified.",
    );
  });

  it("success says the email is verified", () => {
    expect(verifyView("ok", "unknown")).toMatchObject({ verified: true, title: "Email verified" });
    expect(verifyView("invalid", "verified").verified).toBe(false);
  });
});

describe("resendVerificationEmail", () => {
  it("says where the link went when the email was sent", async () => {
    await expect(resendVerificationEmail(respond(200, { ok: true }))).resolves.toEqual({
      ok: true,
      message: "We sent a new link. Open the newest email from Vibe Socials and press its button.",
    });
  });

  it("passes on the server's sentence when the send failed", async () => {
    await expect(resendVerificationEmail(respond(502, { error: "We couldn't send it." }))).resolves.toEqual({
      ok: false,
      message: "We couldn't send it.",
    });
  });

  // R28 NN2: the email may have gone before the answer was lost.
  it("no answer: a new link may have been sent, so look in the inbox first", async () => {
    const result = await resendVerificationEmail(offline);
    expect(result).toEqual({
      ok: false,
      message:
        "Vibe Socials' answer didn't reach you, so a new link may have been sent. If your connection dropped, reconnect first. Look in your inbox before you ask for another.",
    });
  });
});
