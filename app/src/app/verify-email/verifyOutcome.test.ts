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
  return vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
}
const offline = vi.fn(async () => {
  throw new TypeError("Failed to fetch");
}) as unknown as typeof fetch;

describe("attemptVerify", () => {
  it("posts the token and reads the answer", async () => {
    const ok = respond(200, { ok: true });
    await expect(attemptVerify(ok, "tok")).resolves.toBe("ok");
    expect(ok).toHaveBeenCalledWith("/api/auth/verify-email", expect.objectContaining({ method: "POST", body: JSON.stringify({ token: "tok" }) }));
  });

  // R5 pages L7: a network failure is not an invalid link.
  it("tells apart an invalid link, too many tries, a server failure and no network", async () => {
    await expect(attemptVerify(respond(400), "tok")).resolves.toBe("invalid");
    await expect(attemptVerify(respond(429), "tok")).resolves.toBe("rate_limited");
    await expect(attemptVerify(respond(500), "tok")).resolves.toBe("server");
    await expect(attemptVerify(offline, "tok")).resolves.toBe("network");
  });

  it("calls a missing token invalid without asking the server", async () => {
    const spy = respond(200);
    await expect(attemptVerify(spy, "")).resolves.toBe("invalid");
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
  it("no answer: the email may already be verified, and Try again shows which", () => {
    for (const account of all) {
      const view = verifyView("network", account);
      expect(view.title).toBe("Vibe Socials didn't answer");
      expect(view.message).toBe(
        "Vibe Socials' answer didn't reach you, so your email may already be verified. If your connection dropped, reconnect first. Then press Try again to see.",
      );
      expect(view.offerRetry).toBe(true);
    }
  });

  it("too many tries: says to wait", () => {
    const view = verifyView("rate_limited", "unknown");
    expect(view.message).toContain("Wait 15 minutes");
    expect(view.offerRetry).toBe(false);
  });

  it("a server failure says to try again in a minute, and never that the link still works", () => {
    const view = verifyView("server", "unknown");
    expect(view.message).toBe("Your email may not be verified yet. Press Try again in a minute to see.");
    expect(view.offerRetry).toBe(true);
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
