import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";

// vi.mock + vi.hoisted are hoisted above imports by vitest (mirrors
// googleTokens.test.ts). Mocking the `resend` package itself means no real
// network call can ever happen from this test file, regardless of what
// email.ts does internally. `sendEmail` calls `new Resend(apiKey)`, and an
// arrow function cannot be used as a `new` target (vitest surfaces this as
// "is not a constructor"), so the mock implementation must be a real
// `function` — which, by returning an object, supplies that object as the
// constructed instance.
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

const { loggerErrorMock, loggerWarnMock, loggerInfoMock, loggerDebugMock } = vi.hoisted(() => ({
  loggerErrorMock: vi.fn(),
  loggerWarnMock: vi.fn(),
  loggerInfoMock: vi.fn(),
  loggerDebugMock: vi.fn(),
}));
vi.mock("@/lib/logger", () => ({
  logger: { debug: loggerDebugMock, info: loggerInfoMock, warn: loggerWarnMock, error: loggerErrorMock },
}));

import { RetryAfterError } from "inngest";

import {
  EmailRetryableError,
  isRetryableEmailError,
  sendEmail,
} from "@/server/notifications/email";

beforeEach(() => {
  sendMock.mockReset();
  ResendMock.mockClear();
  loggerErrorMock.mockReset();
  loggerWarnMock.mockReset();
  loggerInfoMock.mockReset();
  loggerDebugMock.mockReset();
  sendMock.mockResolvedValue({ data: { id: "email_123" }, error: null });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("sendEmail", () => {
  it("is a no-op — never constructs Resend, never sends, never throws — when RESEND_API_KEY is unset", async () => {
    vi.stubEnv("RESEND_API_KEY", "");
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await expect(
      sendEmail({ to: "user@example.com", subject: "Hi", html: "<p>hi</p>" }),
    ).resolves.toBeUndefined();

    expect(ResendMock).not.toHaveBeenCalled();
    expect(sendMock).not.toHaveBeenCalled();
    // Logs once at info level so the disabled state is still visible.
    expect(consoleSpy).toHaveBeenCalledTimes(1);
  });

  it("sends via Resend with the default from address when RESEND_API_KEY is set", async () => {
    vi.stubEnv("RESEND_API_KEY", "re_test_key");
    vi.stubEnv("NOTIFICATIONS_FROM", "");

    await sendEmail({ to: "user@example.com", subject: "Hi", html: "<p>hi</p>" });

    expect(ResendMock).toHaveBeenCalledTimes(1);
    expect(ResendMock).toHaveBeenCalledWith("re_test_key");
    expect(sendMock).toHaveBeenCalledWith({
      from: "Vibe Socials <onboarding@resend.dev>",
      to: "user@example.com",
      subject: "Hi",
      html: "<p>hi</p>",
    });
  });

  it("uses NOTIFICATIONS_FROM as the sender when set", async () => {
    vi.stubEnv("RESEND_API_KEY", "re_test_key");
    vi.stubEnv("NOTIFICATIONS_FROM", "Custom <custom@example.com>");

    await sendEmail({ to: "user@example.com", subject: "Hi", html: "<p>hi</p>" });

    expect(sendMock).toHaveBeenCalledWith(
      expect.objectContaining({ from: "Custom <custom@example.com>" }),
    );
  });

  it("swallows a Resend send error — logs, does not throw", async () => {
    vi.stubEnv("RESEND_API_KEY", "re_test_key");
    sendMock.mockRejectedValueOnce(new Error("network down"));
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      sendEmail({ to: "user@example.com", subject: "Hi", html: "<p>hi</p>" }),
    ).resolves.toBeUndefined();

    expect(consoleSpy).toHaveBeenCalled();
  });

  it("swallows a Resend constructor error — logs, does not throw", async () => {
    vi.stubEnv("RESEND_API_KEY", "re_test_key");
    // A real `function` (not an arrow) so `new Resend(...)` genuinely throws
    // "bad key" from inside the constructor, rather than JS's own
    // "not a constructor" TypeError for a non-constructible arrow function.
    ResendMock.mockImplementationOnce(function () {
      throw new Error("bad key");
    });
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      sendEmail({ to: "user@example.com", subject: "Hi", html: "<p>hi</p>" }),
    ).resolves.toBeUndefined();

    expect(consoleSpy).toHaveBeenCalledWith(
      "[Notifications] Failed to send email",
      expect.objectContaining({ error: expect.objectContaining({ message: "bad key" }) }),
    );
  });

  // Resend 6.x resolves { data: null, error } on an API rejection instead of
  // throwing — that used to be silently treated as sent.
  it("logs via the logger (no recipient address) — and does not throw — when Resend resolves an error result", async () => {
    vi.stubEnv("RESEND_API_KEY", "re_test_key");
    sendMock.mockResolvedValueOnce({
      data: null,
      error: { name: "daily_quota_exceeded", message: "Daily quota exceeded.", statusCode: 429 },
      headers: null,
    });

    await expect(
      sendEmail({ to: "user@example.com", subject: "Hi", html: "<p>hi</p>" }),
    ).resolves.toBeUndefined();

    expect(loggerErrorMock).toHaveBeenCalledTimes(1);
    expect(loggerErrorMock).toHaveBeenCalledWith("[Notifications] Resend rejected email", {
      subject: "Hi",
      error: { name: "daily_quota_exceeded", message: "Daily quota exceeded.", statusCode: 429 },
    });
    expect(JSON.stringify(loggerErrorMock.mock.calls)).not.toContain("user@example.com");
  });

  it("does not log an error for a successful send", async () => {
    vi.stubEnv("RESEND_API_KEY", "re_test_key");

    await sendEmail({ to: "user@example.com", subject: "Hi", html: "<p>hi</p>" });

    expect(loggerErrorMock).not.toHaveBeenCalled();
  });
});

// 2026-11-01 scale audit (jobs, notifications): a burst of outcome emails past
// Resend's 10 req/s team limit used to be dropped silently (every error was
// logged and swallowed). With `throwOnRetryable` the retryable failures throw so
// the Inngest step retries; everything else keeps the never-throws contract.
describe("sendEmail - retryable delivery (throwOnRetryable)", () => {
  const params = { to: "user@example.com", subject: "Hi", html: "<p>hi</p>" };
  const opts = { throwOnRetryable: true };

  beforeEach(() => {
    vi.stubEnv("RESEND_API_KEY", "re_test_key");
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  const rejection = (statusCode: number | null, name: string) => ({
    data: null,
    error: { name, message: `Resend said ${name}`, statusCode },
    headers: null,
  });

  it("429 rate_limit_exceeded rejects with a RetryAfterError (2s)", async () => {
    sendMock.mockResolvedValueOnce(rejection(429, "rate_limit_exceeded"));

    const error = await sendEmail(params, opts).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(RetryAfterError);
    expect((error as RetryAfterError).retryAfter).toBe("2");
    expect(isRetryableEmailError(error)).toBe(true);
  });

  it("5xx rejects with an EmailRetryableError", async () => {
    sendMock.mockResolvedValueOnce(rejection(503, "application_error"));

    const error = await sendEmail(params, opts).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(EmailRetryableError);
    expect((error as EmailRetryableError).code).toBe("EMAIL_RETRYABLE");
    expect(isRetryableEmailError(error)).toBe(true);
  });

  it("a thrown network error rejects with an EmailRetryableError", async () => {
    sendMock.mockRejectedValueOnce(new Error("network down"));

    await expect(sendEmail(params, opts)).rejects.toBeInstanceOf(EmailRetryableError);
  });

  it("an unresolved request (the SDK reports statusCode null) rejects with an EmailRetryableError", async () => {
    sendMock.mockResolvedValueOnce(rejection(null, "application_error"));

    await expect(sendEmail(params, opts)).rejects.toBeInstanceOf(EmailRetryableError);
  });

  it("422 resolves (logged, dropped)", async () => {
    sendMock.mockResolvedValueOnce(rejection(422, "validation_error"));

    await expect(sendEmail(params, opts)).resolves.toBeUndefined();

    expect(loggerErrorMock).toHaveBeenCalledTimes(1);
  });

  it("409 invalid_idempotent_request resolves: a send with that key already went out", async () => {
    sendMock.mockResolvedValueOnce(rejection(409, "invalid_idempotent_request"));

    await expect(sendEmail(params, opts)).resolves.toBeUndefined();

    expect(loggerErrorMock).not.toHaveBeenCalled();
  });

  it("409 concurrent_idempotent_requests rejects with a RetryAfterError", async () => {
    sendMock.mockResolvedValueOnce(rejection(409, "concurrent_idempotent_requests"));

    await expect(sendEmail(params, opts)).rejects.toBeInstanceOf(RetryAfterError);
  });

  it("a Resend constructor error is not a transient delivery failure: it resolves", async () => {
    ResendMock.mockImplementationOnce(function () {
      throw new Error("bad key");
    });

    await expect(sendEmail(params, opts)).resolves.toBeUndefined();
  });

  it("never puts the recipient address in a thrown error", async () => {
    sendMock.mockResolvedValueOnce(rejection(503, "application_error"));
    const retryable = await sendEmail(params, opts).catch((e: unknown) => e);
    sendMock.mockResolvedValueOnce(rejection(429, "rate_limit_exceeded"));
    const rateLimited = await sendEmail(params, opts).catch((e: unknown) => e);

    for (const error of [retryable, rateLimited]) {
      expect(JSON.stringify(error, Object.getOwnPropertyNames(error as object))).not.toContain(
        "user@example.com",
      );
    }
  });

  it("a successful send resolves", async () => {
    await expect(sendEmail(params, opts)).resolves.toBeUndefined();
  });
});

describe("sendEmail - without throwOnRetryable it never throws", () => {
  const params = { to: "user@example.com", subject: "Hi", html: "<p>hi</p>" };

  beforeEach(() => {
    vi.stubEnv("RESEND_API_KEY", "re_test_key");
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it.each([
    [429, "rate_limit_exceeded"],
    [503, "application_error"],
    [409, "concurrent_idempotent_requests"],
    [409, "invalid_idempotent_request"],
    [422, "validation_error"],
    [null, "application_error"],
  ])("a resolved %s %s error resolves", async (statusCode, name) => {
    sendMock.mockResolvedValueOnce({
      data: null,
      error: { name, message: "x", statusCode },
      headers: null,
    });

    await expect(sendEmail(params)).resolves.toBeUndefined();
    await expect(sendEmail(params, { idempotencyKey: "k" })).resolves.toBeUndefined();
  });

  it("a thrown network error resolves", async () => {
    sendMock.mockRejectedValueOnce(new Error("network down"));

    await expect(sendEmail(params)).resolves.toBeUndefined();
  });
});

describe("sendEmail - idempotency key", () => {
  it("passes idempotencyKey to Resend as the second argument of emails.send", async () => {
    vi.stubEnv("RESEND_API_KEY", "re_test_key");
    vi.stubEnv("NOTIFICATIONS_FROM", "");

    await sendEmail(
      { to: "user@example.com", subject: "Hi", html: "<p>hi</p>" },
      { idempotencyKey: "k" },
    );

    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock).toHaveBeenCalledWith(
      {
        from: "Vibe Socials <onboarding@resend.dev>",
        to: "user@example.com",
        subject: "Hi",
        html: "<p>hi</p>",
      },
      { idempotencyKey: "k" },
    );
  });

  it("sends with no second argument when no key is given", async () => {
    vi.stubEnv("RESEND_API_KEY", "re_test_key");

    await sendEmail({ to: "user@example.com", subject: "Hi", html: "<p>hi</p>" });

    expect(sendMock.mock.calls[0]).toHaveLength(1);
  });
});

describe("isRetryableEmailError", () => {
  it("is true for EmailRetryableError and RetryAfterError only", () => {
    expect(isRetryableEmailError(new EmailRetryableError("x"))).toBe(true);
    expect(isRetryableEmailError(new RetryAfterError("x", 1000))).toBe(true);
    expect(isRetryableEmailError(new Error("x"))).toBe(false);
    expect(isRetryableEmailError("x")).toBe(false);
    expect(isRetryableEmailError(undefined)).toBe(false);
  });
});

// Final review F9 (M5): an email address is personal data and must not end up in
// log aggregation (Sentry, Vercel logs). No log line of email.ts may carry the
// recipient, not as a field and not echoed inside an error message; the subject
// (and an error's name or status) is what identifies the send.
describe("sendEmail - no recipient address in any log line", () => {
  const RECIPIENT = "Jane.Doe+news@example.com";
  const params = { to: RECIPIENT, subject: "Your post went live", html: "<p>hi</p>" };
  const echoing = `Invalid recipient ${RECIPIENT} for this account`;

  let consoleError: MockInstance;
  let consoleWarn: MockInstance;
  let consoleLog: MockInstance;

  beforeEach(() => {
    vi.stubEnv("RESEND_API_KEY", "re_test_key");
    consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  /** Everything any logger or console call received, Errors expanded (their fields are not enumerable). */
  function everythingLogged(): string {
    const calls = [
      ...consoleError.mock.calls,
      ...consoleWarn.mock.calls,
      ...consoleLog.mock.calls,
      ...loggerErrorMock.mock.calls,
      ...loggerWarnMock.mock.calls,
      ...loggerInfoMock.mock.calls,
      ...loggerDebugMock.mock.calls,
    ];
    return JSON.stringify(calls, (_key, value: unknown) =>
      value instanceof Error
        ? { name: value.name, message: value.message, stack: value.stack, cause: value.cause }
        : value,
    );
  }

  const expectNoRecipient = () => {
    const logged = everythingLogged().toLowerCase();
    expect(logged).not.toContain(RECIPIENT.toLowerCase());
    expect(logged).not.toContain("example.com");
  };

  const resolvedRejection = (statusCode: number | null, name: string) => ({
    data: null,
    error: { name, message: echoing, statusCode },
    headers: null,
  });

  it("a Resend constructor error logs the subject, not the recipient", async () => {
    ResendMock.mockImplementationOnce(function () {
      throw new Error(echoing);
    });

    await sendEmail(params);

    expect(consoleError).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(consoleError.mock.calls)).toContain("Your post went live");
    expectNoRecipient();
  });

  it("a thrown send error (swallowed) logs the subject, not the recipient", async () => {
    sendMock.mockRejectedValueOnce(new Error(echoing));

    await sendEmail(params);

    expect(consoleError).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(consoleError.mock.calls)).toContain("Your post went live");
    expectNoRecipient();
  });

  it("a thrown send error that the step will retry logs the subject, not the recipient", async () => {
    sendMock.mockRejectedValueOnce(new Error(echoing));

    await expect(sendEmail(params, { throwOnRetryable: true })).rejects.toBeInstanceOf(EmailRetryableError);

    expect(loggerWarnMock).toHaveBeenCalledTimes(1);
    expectNoRecipient();
  });

  it.each([
    [429, "rate_limit_exceeded"],
    [503, "application_error"],
    [null, "application_error"],
    [409, "concurrent_idempotent_requests"],
  ])("a resolved %s %s error that the step will retry logs no recipient", async (statusCode, name) => {
    sendMock.mockResolvedValueOnce(resolvedRejection(statusCode, name));

    await expect(sendEmail(params, { throwOnRetryable: true })).rejects.toBeDefined();

    expect(loggerWarnMock).toHaveBeenCalledTimes(1);
    expectNoRecipient();
  });

  it("an already-sent idempotency key (409) logs the subject, not the recipient", async () => {
    sendMock.mockResolvedValueOnce(resolvedRejection(409, "invalid_idempotent_request"));

    await sendEmail(params, { throwOnRetryable: true, idempotencyKey: "k" });

    expect(loggerWarnMock).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(loggerWarnMock.mock.calls)).toContain("Your post went live");
    expectNoRecipient();
  });

  it("a rejected email (422) logs the subject and the error name and status, not the recipient", async () => {
    sendMock.mockResolvedValueOnce(resolvedRejection(422, "validation_error"));

    await sendEmail(params);

    expect(loggerErrorMock).toHaveBeenCalledTimes(1);
    const [, context] = loggerErrorMock.mock.calls[0] as [string, { subject: string; error: { name: string; statusCode: number } }];
    expect(context.subject).toBe("Your post went live");
    expect(context.error).toMatchObject({ name: "validation_error", statusCode: 422 });
    expectNoRecipient();
  });

  it("strips every occurrence of the recipient from an echoing message, whatever its case", async () => {
    sendMock.mockResolvedValueOnce({
      data: null,
      error: {
        name: "validation_error",
        message: `${RECIPIENT.toUpperCase()} bounced; retry ${RECIPIENT} later`,
        statusCode: 422,
      },
      headers: null,
    });

    await sendEmail(params);

    const [, context] = loggerErrorMock.mock.calls[0] as [string, { error: { message: string } }];
    expect(context.error.message).toBe("[recipient] bounced; retry [recipient] later");
    expectNoRecipient();
  });

  // 2026-11-02 phase 2 final review: Resend can answer with a JSON error body that
  // has no string `message`. That must not throw a TypeError out of `sendEmail`.
  it.each([
    ["missing", undefined, ""],
    ["a number", 42, "42"],
  ])("a Resend error whose message is %s does not throw", async (_label, message, logged) => {
    sendMock.mockResolvedValueOnce({
      data: null,
      error: { statusCode: 422, name: "validation_error", message },
      headers: null,
    });

    await expect(sendEmail(params)).resolves.toBeUndefined();

    expect(loggerErrorMock).toHaveBeenCalledTimes(1);
    const [, context] = loggerErrorMock.mock.calls[0] as [string, { error: { message: string } }];
    expect(context.error.message).toBe(logged);
    expectNoRecipient();
  });

  it("the disabled-sender line (no RESEND_API_KEY) carries no recipient either", async () => {
    vi.stubEnv("RESEND_API_KEY", "");

    await sendEmail(params);

    expect(consoleLog).toHaveBeenCalledTimes(1);
    expectNoRecipient();
  });
});
