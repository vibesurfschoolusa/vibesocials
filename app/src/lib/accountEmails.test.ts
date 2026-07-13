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

import {
  buildPasswordResetEmail,
  buildVerifyEmail,
  deliverAccountEmail,
} from "./accountEmails";

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

describe("deliverAccountEmail", () => {
  const email = { subject: "Hi", html: "<p>hi</p>", text: "hi" };

  beforeEach(() => {
    sendMock.mockReset();
    ResendMock.mockClear();
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

    expect(consoleSpy).toHaveBeenCalled();
  });
});
