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

  it("a used link for a verified person says it is already verified", () => {
    const view = verifyView("invalid", "verified");
    expect(view.title).toBe("Your email is already verified");
    expect(view.offerResend).toBe(false);
  });

  it("a dead link for a signed-in unverified person says it expired and offers a new one", () => {
    const view = verifyView("invalid", "unverified");
    expect(view.title).toBe("This link has expired");
    expect(view.message).toContain("newest email");
    expect(view.offerResend).toBe(true);
  });

  it("a dead link for a signed-out visitor says expired or used and sends them to log in", () => {
    const view = verifyView("invalid", "signed_out");
    expect(view.message).toContain("expired or was already used");
    expect(view.next).toEqual({ href: "/login", label: "Log in" });
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

  it("no network: says the email is not verified yet and offers to try again", () => {
    for (const account of all) {
      const view = verifyView("network", account);
      expect(view.message).toContain("Check your internet connection");
      expect(view.message).not.toContain("invalid");
      expect(view.offerRetry).toBe(true);
    }
  });

  it("too many tries: says to wait", () => {
    const view = verifyView("rate_limited", "unknown");
    expect(view.message).toContain("Wait 15 minutes");
    expect(view.offerRetry).toBe(false);
  });

  it("a server failure says to try again in a minute", () => {
    const view = verifyView("server", "unknown");
    expect(view.message).toContain("try again in a minute");
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

  it("names a network failure", async () => {
    const result = await resendVerificationEmail(offline);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("Check your internet connection");
  });
});
