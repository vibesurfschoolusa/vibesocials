import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

const { loggerErrorMock } = vi.hoisted(() => ({ loggerErrorMock: vi.fn() }));
vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: loggerErrorMock },
}));

import { sendEmail } from "@/server/notifications/email";

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
