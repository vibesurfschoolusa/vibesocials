import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the `resend` package itself (mirrors server/notifications/email.test.ts)
// so no real network call can ever happen from this file. `deliverAccountEmail`
// calls `new Resend(apiKey)`, and an arrow function cannot be a `new` target
// (vitest surfaces "is not a constructor"), so the mock implementation is a
// real `function` returning the constructed instance.
const { sendMock, ResendMock } = vi.hoisted(() => {
  const sendMock = vi.fn();
  const ResendMock = vi.fn().mockImplementation(function ResendCtor() {
    return { emails: { send: sendMock } };
  });
  return { sendMock, ResendMock };
});

vi.mock("resend", () => ({
  Resend: ResendMock,
}));

const { loggerErrorMock } = vi.hoisted(() => ({ loggerErrorMock: vi.fn() }));
vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: loggerErrorMock },
}));

import {
  buildAccountDeletedEmail,
  buildEmailChangeEmail,
  buildEmailChangedNoticeEmail,
  buildPasswordChangedEmail,
  buildPasswordResetEmail,
  buildVerifyEmail,
  deliverAccountEmail,
} from "./accountEmails";
import { SUPPORT_EMAIL } from "./siteInfo";

const BASE_URL = "https://app.vibesocials.com";
const RAW_TOKEN = "RAWTOKEN-abc123_sentinel-XYZ";

/** Count non-overlapping occurrences of `needle` in `haystack`. */
function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe("buildPasswordResetEmail", () => {
  it("uses a sentence-case subject", () => {
    const { subject } = buildPasswordResetEmail({
      to: "user@example.com",
      rawToken: RAW_TOKEN,
      baseUrl: BASE_URL,
    });
    expect(subject).toBe("Reset your Vibe Socials password");
  });

  it("embeds the raw token ONLY in a URL fragment link in both html and text", () => {
    const { html, text } = buildPasswordResetEmail({
      to: "user@example.com",
      rawToken: RAW_TOKEN,
      baseUrl: BASE_URL,
    });
    const link = `${BASE_URL}/reset-password#${RAW_TOKEN}`;

    expect(html).toContain(link);
    expect(text).toContain(link);
    // Fragment only — the token is never a query parameter (SEC-1).
    expect(html).not.toContain("?token=");
    expect(text).not.toContain("?token=");
    // The raw token appears exactly once in each body: inside the link.
    expect(countOccurrences(html, RAW_TOKEN)).toBe(1);
    expect(countOccurrences(text, RAW_TOKEN)).toBe(1);
  });
});

describe("buildVerifyEmail", () => {
  it("uses a sentence-case subject", () => {
    const { subject } = buildVerifyEmail({
      to: "user@example.com",
      rawToken: RAW_TOKEN,
      baseUrl: BASE_URL,
    });
    expect(subject).toBe("Verify your email address");
  });

  it("embeds the raw token ONLY in a URL fragment link in both html and text", () => {
    const { html, text } = buildVerifyEmail({
      to: "user@example.com",
      rawToken: RAW_TOKEN,
      baseUrl: BASE_URL,
    });
    const link = `${BASE_URL}/verify-email#${RAW_TOKEN}`;

    expect(html).toContain(link);
    expect(text).toContain(link);
    expect(html).not.toContain("?token=");
    expect(text).not.toContain("?token=");
    expect(countOccurrences(html, RAW_TOKEN)).toBe(1);
    expect(countOccurrences(text, RAW_TOKEN)).toBe(1);
  });
});

describe("buildPasswordChangedEmail", () => {
  it("says the password changed and what to do if it was not them", () => {
    const { subject, html, text } = buildPasswordChangedEmail({ baseUrl: `${BASE_URL}/` });

    expect(subject).toBe("Your Vibe Socials password was changed");
    // R18 new-customer L2 follow-up: someone still signed in sees the notice on
    // the sign-in page, so the email names the Forgot password page itself.
    for (const body of [html, text]) {
      expect(body).toContain(
        `If it was not you, set a new password on the Forgot password page (${BASE_URL}/forgot-password), and write to ${SUPPORT_EMAIL}.`,
      );
      expect(body).not.toContain("on the sign-in page");
      expect(body).not.toContain(`${BASE_URL}/login`);
    }
    expect(text).not.toContain(`${BASE_URL}//forgot-password`);
  });
});

// R5 new-customer L4.
describe("buildEmailChangeEmail", () => {
  it("asks the new address to confirm, with the token only in a link fragment", () => {
    const { subject, html, text } = buildEmailChangeEmail({
      to: "new@example.com",
      rawToken: RAW_TOKEN,
      baseUrl: `${BASE_URL}/`,
    });
    const link = `${BASE_URL}/verify-email/new-address#${RAW_TOKEN}`;

    expect(subject).toBe("Confirm your new Vibe Socials email");
    expect(html).toContain(link);
    expect(text).toContain(link);
    expect(countOccurrences(html, RAW_TOKEN)).toBe(1);
    expect(countOccurrences(text, RAW_TOKEN)).toBe(1);
    expect(text).toContain("expires in 24 hours");
    expect(text).toContain("ignore this email");
  });
});

describe("buildEmailChangedNoticeEmail", () => {
  const notice = (newEmail = "new@example.com") =>
    buildEmailChangedNoticeEmail({ newEmail, rawUndoToken: RAW_TOKEN, baseUrl: `${BASE_URL}/` });

  it("tells the old address where the account went and what to do if it was not them", () => {
    const { subject, html, text } = notice();

    expect(subject).toBe("Your Vibe Socials sign-in email was changed");
    for (const body of [html, text]) {
      expect(body).toContain("new@example.com");
      expect(body).toContain("signed out");
      expect(body).toContain(SUPPORT_EMAIL);
    }
  });

  // Review: the old mailbox can take the account back with one press.
  it("carries a one-use undo link, its token only in a fragment, valid 72 hours", () => {
    const { html, text } = notice();
    const link = `${BASE_URL}/verify-email/undo#${RAW_TOKEN}`;
    expect(html).toContain(`<a href="${link}">This wasn&#39;t me: undo the change</a>`);
    expect(text).toContain(link);
    expect(countOccurrences(html, RAW_TOKEN)).toBe(1);
    expect(countOccurrences(text, RAW_TOKEN)).toBe(1);
    expect(text).toContain("works once, for 72 hours");
  });

  it("escapes the address it names", () => {
    const { html } = notice("a<b>@example.com");
    expect(html).not.toContain("<b>");
  });
});

describe("buildAccountDeletedEmail", () => {
  it("confirms the deletion and names the support address", () => {
    const { subject, html, text } = buildAccountDeletedEmail();

    expect(subject).toBe("Your Vibe Socials account was deleted");
    for (const body of [html, text]) {
      expect(body).toContain("deleted");
      expect(body).toContain(SUPPORT_EMAIL);
    }
  });
});

describe("deliverAccountEmail", () => {
  const email = { subject: "Hi", html: "<p>hi</p>", text: "hi" };

  beforeEach(() => {
    sendMock.mockReset();
    ResendMock.mockClear();
    loggerErrorMock.mockReset();
    sendMock.mockResolvedValue({ data: { id: "email_123" }, error: null });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("returns false immediately without constructing Resend when RESEND_API_KEY is unset", async () => {
    vi.stubEnv("RESEND_API_KEY", "");
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await expect(deliverAccountEmail("user@example.com", email)).resolves.toBe(false);

    expect(ResendMock).not.toHaveBeenCalled();
    expect(sendMock).not.toHaveBeenCalled();
    expect(consoleSpy).toHaveBeenCalledTimes(1);
  });

  it("sends subject/html/text via Resend and returns true when RESEND_API_KEY is set", async () => {
    vi.stubEnv("RESEND_API_KEY", "re_test_key");
    vi.stubEnv("NOTIFICATIONS_FROM", "");

    await expect(deliverAccountEmail("user@example.com", email)).resolves.toBe(true);

    expect(ResendMock).toHaveBeenCalledWith("re_test_key");
    expect(sendMock).toHaveBeenCalledWith({
      from: "Vibe Socials <onboarding@resend.dev>",
      to: "user@example.com",
      subject: "Hi",
      html: "<p>hi</p>",
      text: "hi",
    });
  });

  it("uses NOTIFICATIONS_FROM as the sender when set", async () => {
    vi.stubEnv("RESEND_API_KEY", "re_test_key");
    vi.stubEnv("NOTIFICATIONS_FROM", "Custom <custom@example.com>");

    await deliverAccountEmail("user@example.com", email);

    expect(sendMock).toHaveBeenCalledWith(
      expect.objectContaining({ from: "Custom <custom@example.com>" }),
    );
  });

  it("never throws and returns false when the Resend client rejects", async () => {
    vi.stubEnv("RESEND_API_KEY", "re_test_key");
    sendMock.mockRejectedValueOnce(new Error("network down"));
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(deliverAccountEmail("user@example.com", email)).resolves.toBe(false);

    // R5 pages L1: the failure is logged without the recipient's address.
    const logged = JSON.stringify([consoleSpy.mock.calls, loggerErrorMock.mock.calls]);
    expect(logged).toContain("Failed to send account email");
    expect(logged).not.toContain("user@example.com");
  });

  // Resend 6.x does NOT throw on an API rejection (bad key, invalid sender,
  // quota...): it resolves { data: null, error }. That used to count as sent.
  it("returns false and logs via the logger (no recipient address) when Resend resolves an error result", async () => {
    vi.stubEnv("RESEND_API_KEY", "re_test_key");
    sendMock.mockResolvedValueOnce({
      data: null,
      error: { name: "invalid_from_address", message: "Invalid `from` field.", statusCode: 422 },
      headers: null,
    });

    await expect(deliverAccountEmail("user@example.com", email)).resolves.toBe(false);

    expect(loggerErrorMock).toHaveBeenCalledTimes(1);
    expect(loggerErrorMock).toHaveBeenCalledWith("[Account] Resend rejected account email", {
      subject: "Hi",
      error: { name: "invalid_from_address", message: "Invalid `from` field.", statusCode: 422 },
    });
    expect(JSON.stringify(loggerErrorMock.mock.calls)).not.toContain("user@example.com");
  });

  it("does not log an error for a successful send", async () => {
    vi.stubEnv("RESEND_API_KEY", "re_test_key");

    await expect(deliverAccountEmail("user@example.com", email)).resolves.toBe(true);

    expect(loggerErrorMock).not.toHaveBeenCalled();
  });
});
