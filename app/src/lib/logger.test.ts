import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `@sentry/nextjs` is mocked for this entire file — no test here may ever
// contact Sentry. Declared with `vi.hoisted` so the mock factory can
// reference the same spies the tests assert against (vi.mock is hoisted
// above imports by vitest).
const { captureExceptionMock, captureMessageMock } = vi.hoisted(() => ({
  captureExceptionMock: vi.fn(),
  captureMessageMock: vi.fn(),
}));

vi.mock("@sentry/nextjs", () => ({
  captureException: captureExceptionMock,
  captureMessage: captureMessageMock,
}));

import { logger, redactContext } from "@/lib/logger";

function resetEnv(): void {
  vi.unstubAllEnvs();
  // Tests default to a deterministic, non-production, no-Sentry environment
  // unless a test explicitly stubs otherwise.
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("SENTRY_DSN", "");
  vi.stubEnv("NEXT_PUBLIC_SENTRY_DSN", "");
  vi.stubEnv("LOG_LEVEL", "");
}

beforeEach(() => {
  resetEnv();
  captureExceptionMock.mockReset();
  captureMessageMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("redactContext (SEC-1)", () => {
  it("redacts every denylisted key, case-insensitively, and leaves other keys untouched", () => {
    const input = {
      accessToken: "real-access-token",
      refreshToken: "real-refresh-token",
      password: "hunter2",
      passwordHash: "$2b$10$abc",
      Authorization: "Bearer abc123",
      apiKey: "key-123",
      token: "raw-token",
      secret: "shh",
      clientSecret: "csecret",
      COOKIE: "session=abc",
      dsn: "https://public@o0.ingest.sentry.io/1",
      userId: "user-1",
      platform: "youtube",
    };

    const result = redactContext(input);

    expect(result).toEqual({
      accessToken: "[redacted]",
      refreshToken: "[redacted]",
      password: "[redacted]",
      passwordHash: "[redacted]",
      Authorization: "[redacted]",
      apiKey: "[redacted]",
      token: "[redacted]",
      secret: "[redacted]",
      clientSecret: "[redacted]",
      COOKIE: "[redacted]",
      dsn: "[redacted]",
      userId: "user-1",
      platform: "youtube",
    });
    // The most important assertion in this file: none of the real secret
    // VALUES appear anywhere in the redacted output.
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("real-access-token");
    expect(serialized).not.toContain("real-refresh-token");
    expect(serialized).not.toContain("hunter2");
    expect(serialized).not.toContain("Bearer abc123");
    expect(serialized).not.toContain("key-123");
    expect(serialized).not.toContain("raw-token");
    expect(serialized).not.toContain("csecret");
    expect(serialized).not.toContain("session=abc");
  });

  it("redacts secrets nested arbitrarily deep inside objects and arrays", () => {
    const input = {
      user: {
        id: "user-1",
        connection: {
          platform: "google_business_profile",
          credentials: {
            accessToken: "deep-secret-access-token",
            nested: [{ refreshToken: "deep-secret-refresh-token" }, { ok: "fine" }],
          },
        },
      },
    };

    const result = redactContext(input);
    const serialized = JSON.stringify(result);

    expect(serialized).not.toContain("deep-secret-access-token");
    expect(serialized).not.toContain("deep-secret-refresh-token");
    expect(serialized).toContain('"ok":"fine"');
    // Structural shape (non-secret keys) is preserved.
    expect(result).toMatchObject({
      user: { id: "user-1", connection: { platform: "google_business_profile" } },
    });
  });

  it("redacts a secret value wholesale without recursing into it, even if it is itself an object", () => {
    const input = { accessToken: { raw: "still-a-secret", exp: 123 } };
    const result = redactContext(input);
    expect(result).toEqual({ accessToken: "[redacted]" });
    expect(JSON.stringify(result)).not.toContain("still-a-secret");
  });

  it("pulls name/message/stack off an Error (non-enumerable on native Error) and redacts any extra attached property", () => {
    const error = new Error("invalid_grant: token expired") as Error & {
      code?: string;
      accessToken?: string;
    };
    error.code = "GOOGLE_TOKEN_REFRESH_FAILED";
    error.accessToken = "attached-secret-token";

    const result = redactContext({ error });
    const record = result?.error as Record<string, unknown>;

    expect(record.name).toBe("Error");
    expect(record.message).toBe("invalid_grant: token expired");
    expect(typeof record.stack).toBe("string");
    expect(record.code).toBe("GOOGLE_TOKEN_REFRESH_FAILED");
    expect(record.accessToken).toBe("[redacted]");
    expect(JSON.stringify(result)).not.toContain("attached-secret-token");
  });

  it("serializes Date values and leaves undefined context alone", () => {
    const date = new Date("2026-01-01T00:00:00.000Z");
    expect(redactContext({ at: date })).toEqual({ at: "2026-01-01T00:00:00.000Z" });
    expect(redactContext(undefined)).toBeUndefined();
  });

  it("does not scan string CONTENTS — redaction is key-based only", () => {
    // Documents the known scope boundary: a secret embedded in a string
    // value under a non-denylisted key is NOT redacted. Matches assertOk.ts's
    // existing contract of logging the raw upstream error body server-side.
    const result = redactContext({ body: "invalid_grant: token=SECRET123 revoked" });
    expect(result).toEqual({ body: "invalid_grant: token=SECRET123 revoked" });
  });

  it("terminates on a self-referencing (circular) object instead of recursing forever", () => {
    const circular: Record<string, unknown> = { name: "loop" };
    circular.self = circular;
    expect(() => redactContext(circular)).not.toThrow();
  });

  it("coerces a BigInt to a string (JSON.stringify can't serialize BigInt) — review H1 blocker A", () => {
    // BigInt(...) not a `10n` literal — the tsconfig target is below ES2020.
    expect(() => redactContext({ count: BigInt(10) })).not.toThrow();
    expect(redactContext({ count: BigInt(10) })).toEqual({ count: "10" });
  });

  it("renders an invalid Date safely instead of throwing on toISOString — review H1 blocker A", () => {
    expect(() => redactContext({ when: new Date(NaN) })).not.toThrow();
    expect(redactContext({ when: new Date(NaN) })).toEqual({ when: "[invalid date]" });
  });
});

describe("logger level filtering and record structure", () => {
  it("emits debug/info/warn/error via the matching console method by default (non-production)", () => {
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    logger.debug("d");
    logger.info("i");
    logger.warn("w");
    logger.error("e");

    expect(debugSpy).toHaveBeenCalledTimes(1);
    expect(infoSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  it("suppresses debug-level records in production (default floor is info)", () => {
    vi.stubEnv("NODE_ENV", "production");
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});

    logger.debug("should be suppressed");
    logger.info("should still emit");

    expect(debugSpy).not.toHaveBeenCalled();
    expect(infoSpy).toHaveBeenCalledTimes(1);
  });

  it("honors LOG_LEVEL to raise the floor above the environment default", () => {
    vi.stubEnv("LOG_LEVEL", "error");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    logger.warn("suppressed by LOG_LEVEL=error");
    logger.error("still emits");

    expect(warnSpy).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  it("emits a single-line, parseable JSON record with level/message/timestamp/context in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});

    logger.info("[Test] something happened", { userId: "user-1" });

    expect(infoSpy).toHaveBeenCalledTimes(1);
    const [line] = infoSpy.mock.calls[0] as [string];
    const parsed = JSON.parse(line) as Record<string, unknown>;
    expect(parsed.level).toBe("info");
    expect(parsed.message).toBe("[Test] something happened");
    expect(parsed.context).toEqual({ userId: "user-1" });
    expect(typeof parsed.timestamp).toBe("string");
    expect(new Date(parsed.timestamp as string).toISOString()).toBe(parsed.timestamp);
  });

  it("redacts context before it ever reaches the console sink", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    logger.error("[Test] failed", { accessToken: "must-not-appear" });

    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain("must-not-appear");
    expect(JSON.stringify(errorSpy.mock.calls)).toContain("[redacted]");
  });
});

describe("Sentry env-gate", () => {
  it("with no DSN configured, logs to console but never calls Sentry", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    logger.error("[Test] error with no DSN", { userId: "user-1" });
    logger.warn("[Test] warn with no DSN", { userId: "user-1" });

    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(captureExceptionMock).not.toHaveBeenCalled();
    expect(captureMessageMock).not.toHaveBeenCalled();
  });

  it("never forwards debug/info to Sentry even when a DSN is configured", () => {
    vi.stubEnv("SENTRY_DSN", "https://public@o0.ingest.sentry.io/1");
    vi.spyOn(console, "debug").mockImplementation(() => {});
    vi.spyOn(console, "info").mockImplementation(() => {});

    logger.debug("d");
    logger.info("i");

    expect(captureExceptionMock).not.toHaveBeenCalled();
    expect(captureMessageMock).not.toHaveBeenCalled();
  });

  it("forwards warn/error to Sentry as captureMessage when a DSN is configured and there is no Error in context", () => {
    vi.stubEnv("SENTRY_DSN", "https://public@o0.ingest.sentry.io/1");
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});

    logger.warn("[Test] warn with DSN", { userId: "user-1" });
    logger.error("[Test] error with DSN", { userId: "user-1" });

    expect(captureMessageMock).toHaveBeenCalledTimes(2);
    expect(captureMessageMock).toHaveBeenNthCalledWith(1, "[Test] warn with DSN", {
      level: "warning",
      extra: { userId: "user-1" },
    });
    expect(captureMessageMock).toHaveBeenNthCalledWith(2, "[Test] error with DSN", {
      level: "error",
      extra: { userId: "user-1" },
    });
    expect(captureExceptionMock).not.toHaveBeenCalled();
  });

  it("also honors NEXT_PUBLIC_SENTRY_DSN as an enable signal", () => {
    vi.stubEnv("NEXT_PUBLIC_SENTRY_DSN", "https://public@o0.ingest.sentry.io/1");
    vi.spyOn(console, "error").mockImplementation(() => {});

    logger.error("[Test] error", {});

    expect(captureMessageMock).toHaveBeenCalledTimes(1);
  });

  it("forwards an Error in context via captureException with a sanitized clone, plus the redacted context as extra", () => {
    vi.stubEnv("SENTRY_DSN", "https://public@o0.ingest.sentry.io/1");
    vi.spyOn(console, "error").mockImplementation(() => {});

    const original = new Error("boom") as Error & { code?: string; accessToken?: string };
    original.code = "GOOGLE_TOKEN_REFRESH_FAILED";
    original.accessToken = "must-never-reach-sentry";

    logger.error("[Test] refresh failed", { connectionId: "conn-1", error: original });

    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
    const [forwarded, hint] = captureExceptionMock.mock.calls[0] as [
      Error,
      { level: string; extra: Record<string, unknown> },
    ];

    // A real Error was forwarded (for Sentry's stack-based grouping)...
    expect(forwarded).toBeInstanceOf(Error);
    expect(forwarded.message).toBe("boom");
    // ...but it is a CLONE: the original object (and its attached secret)
    // must never be the value handed to Sentry.
    expect(forwarded).not.toBe(original);
    expect((forwarded as Error & { accessToken?: string }).accessToken).toBeUndefined();
    expect(JSON.stringify(hint)).not.toContain("must-never-reach-sentry");

    expect(hint.level).toBe("error");
    expect(hint.extra.connectionId).toBe("conn-1");
    const extraError = hint.extra.error as Record<string, unknown>;
    expect(extraError.name).toBe("Error");
    expect(extraError.message).toBe("boom");
    expect(extraError.code).toBe("GOOGLE_TOKEN_REFRESH_FAILED");
    // The redacted `extra` view keeps the field present but blanked, rather
    // than silently dropping it — same "[redacted]", not the real value.
    expect(extraError.accessToken).toBe("[redacted]");
  });

  it("never throws even if the mocked Sentry call itself throws", () => {
    vi.stubEnv("SENTRY_DSN", "https://public@o0.ingest.sentry.io/1");
    vi.spyOn(console, "error").mockImplementation(() => {});
    captureMessageMock.mockImplementation(() => {
      throw new Error("sentry transport down");
    });

    expect(() => logger.error("[Test] should not throw", {})).not.toThrow();
  });

  it("never throws when a context value's getter throws — degrades, doesn't escape the caller's catch (H1 blocker A)", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const hostile = {
      get boom(): string {
        throw new Error("getter exploded");
      },
    };
    // logger.error runs inside real catch blocks now; it must swallow this.
    expect(() => logger.error("[Test] hostile getter", { hostile })).not.toThrow();
  });

  it("never throws on a BigInt in context (prod JSON path stringifies the record) — H1 blocker A", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => logger.error("[Test] bigint context", { count: BigInt("9007199254740993") })).not.toThrow();
  });
});
