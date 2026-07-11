import * as Sentry from "@sentry/nextjs";

// Health track H1 — structured logger for server code.
//
// Four levels (debug/info/warn/error), each taking a message plus an
// optional structured context object. Two properties matter more than the
// rest:
//
// 1. SEC-1 redaction (see `redactContext` below): before a context is
//    emitted OR forwarded anywhere, it is walked recursively and any object
//    key that CONTAINS (case-insensitive) one of the denylisted substrings
//    has its value replaced with "[redacted]" — however deeply nested. A
//    logged object that happens to carry a token must never leak it. This is
//    key-based (structural) redaction, not a scan of string *contents* — see
//    logger.test.ts for the exact contract.
//
// 2. Sentry is entirely additive. `@sentry/nextjs` is a normal dependency of
//    this module, but `warn`/`error` only ever forward to it when
//    `isSentryEnabled()` is true (SENTRY_DSN or NEXT_PUBLIC_SENTRY_DSN set).
//    With neither set, this module behaves as a plain (redacting, leveled)
//    console wrapper — nothing reaches Sentry, and nothing here throws if
//    Sentry was never configured or `Sentry.init` was never called.

export type LogLevel = "debug" | "info" | "warn" | "error";

/** Arbitrary structured data attached to a log event. */
export type LogContext = Record<string, unknown>;

// ---------------------------------------------------------------------------
// SEC-1 redaction
// ---------------------------------------------------------------------------

/**
 * Case-insensitive substring denylist. Any object key CONTAINING one of these
 * fragments is redacted — e.g. "userAccessToken", "GOOGLE_CLIENT_SECRET", and
 * "Cookie" all match. Several entries are already covered by a broader one
 * (e.g. "accesstoken" by "token"); kept explicit anyway so the list reads as
 * a direct checklist against the spec rather than relying on substring
 * overlap to be obvious. Deliberately broad: over-redacting a harmless field
 * (e.g. "tokenType") is an acceptable false positive — leaking a real secret
 * is not.
 */
const SECRET_KEY_DENYLIST = [
  "accesstoken",
  "refreshtoken",
  "password",
  "passwordhash",
  "authorization",
  "apikey",
  "token",
  "secret",
  "clientsecret",
  "cookie",
  "dsn",
] as const;

const REDACTED = "[redacted]";

function isSecretKey(key: string): boolean {
  const lower = key.toLowerCase();
  return SECRET_KEY_DENYLIST.some((needle) => lower.includes(needle));
}

// Bounds recursion for pathological input (very deep nesting, or a cycle — a
// cycle's depth grows by 1 every time the same object is revisited, so it
// always hits this cap rather than recursing forever).
const MAX_REDACT_DEPTH = 8;

function redactAny(value: unknown, depth: number): unknown {
  if (depth > MAX_REDACT_DEPTH) {
    return "[max-depth]";
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactAny(item, depth + 1));
  }

  if (value instanceof Error) {
    // `name`/`message`/`stack` are non-enumerable on a native Error, so the
    // generic Object.keys() walk below would silently produce `{}` for them —
    // destructuring pulls them out explicitly (property access, not
    // enumeration, so it works regardless). Any OTHER own-enumerable
    // property a call site attached (e.g. the `error.code = "..."` tags used
    // throughout this codebase) still goes through the normal redaction pass
    // via `rest`, so an accidentally-secret field on an Error is still safe.
    const { message, stack, name, ...rest } = value as Error & Record<string, unknown>;
    const redactedRest = redactAny(rest, depth + 1) as Record<string, unknown>;
    return { name, message, stack, ...redactedRest };
  }

  if (value instanceof Date) {
    // An invalid Date (`new Date(NaN)`) throws on `.toISOString()` — guard it so
    // the logger never throws on a bad Date in context (review H1 blocker A).
    return Number.isNaN(value.getTime()) ? "[invalid date]" : value.toISOString();
  }

  // BigInt is not JSON-serializable (`JSON.stringify(1n)` throws), and the prod
  // console path stringifies the whole record — coerce to string here (H1 A).
  if (typeof value === "bigint") {
    return value.toString();
  }

  if (value !== null && typeof value === "object") {
    const input = value as Record<string, unknown>;
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(input)) {
      output[key] = isSecretKey(key) ? REDACTED : redactAny(input[key], depth + 1);
    }
    return output;
  }

  return value;
}

/**
 * Deep-redact a log context. Exported (and kept a pure function of its
 * input) so the SEC-1 contract can be unit tested directly, without
 * exercising the logger's console/Sentry side effects at all.
 */
export function redactContext(context: LogContext | undefined): LogContext | undefined {
  if (!context) {
    return context;
  }
  return redactAny(context, 0) as LogContext;
}

// ---------------------------------------------------------------------------
// Level filtering
// ---------------------------------------------------------------------------

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

function isKnownLevel(value: string): value is LogLevel {
  return value === "debug" || value === "info" || value === "warn" || value === "error";
}

/**
 * Lowest level actually emitted. Defaults to "debug" outside production (so
 * `npm run dev` / tests show everything) and "info" in production (skip
 * debug noise). Overridable via `LOG_LEVEL` for local troubleshooting. This
 * is a volume knob only — redaction runs unconditionally regardless of
 * level, and is computed before this filter is even applied.
 */
function minLevel(): LogLevel {
  const fromEnv = process.env.LOG_LEVEL;
  if (fromEnv && isKnownLevel(fromEnv)) {
    return fromEnv;
  }
  return process.env.NODE_ENV === "production" ? "info" : "debug";
}

// ---------------------------------------------------------------------------
// Console sink
// ---------------------------------------------------------------------------

function buildConsoleArgs(level: LogLevel, message: string, context: LogContext | undefined): unknown[] {
  if (process.env.NODE_ENV === "production") {
    // Structured JSON, one line per event, so production logs are queryable.
    const record: Record<string, unknown> = {
      level,
      message,
      timestamp: new Date().toISOString(),
      ...(context ? { context } : {}),
    };
    return [JSON.stringify(record)];
  }
  // Readable dev format.
  return context ? [`[${level.toUpperCase()}] ${message}`, context] : [`[${level.toUpperCase()}] ${message}`];
}

function writeToConsole(level: LogLevel, message: string, context: LogContext | undefined): void {
  const args = buildConsoleArgs(level, message, context);
  // Calling `console.<level>(...)` directly (not via a cached method
  // reference) so `vi.spyOn(console, "error")`-style test spies — used
  // throughout this codebase's existing tests — intercept it correctly.
  switch (level) {
    case "debug":
      console.debug(...args);
      break;
    case "info":
      console.info(...args);
      break;
    case "warn":
      console.warn(...args);
      break;
    case "error":
      console.error(...args);
      break;
  }
}

// ---------------------------------------------------------------------------
// Sentry (additive, env-gated — see next.config.ts / instrumentation.ts /
// instrumentation-client.ts for the matching build+init gates)
// ---------------------------------------------------------------------------

function isSentryEnabled(): boolean {
  return Boolean(process.env.SENTRY_DSN || process.env.NEXT_PUBLIC_SENTRY_DSN);
}

function toSentryLevel(level: "warn" | "error"): "warning" | "error" {
  return level === "warn" ? "warning" : "error";
}

/** Find an Error to hand to Sentry BEFORE the context is redacted — a plain
 *  Error clone (name/message/stack only) still gives Sentry a real
 *  stack trace to group on, without ever passing through the original
 *  object's arbitrary own properties (see `cloneErrorForSentry`). */
function extractError(context: LogContext | undefined): Error | undefined {
  const candidate = context?.error ?? context?.err;
  return candidate instanceof Error ? candidate : undefined;
}

/** name/message/stack-only clone — deliberately drops any other own
 *  property (e.g. this codebase's `error.code = "..."` tags, or anything
 *  else a call site might have attached) so nothing beyond the redacted
 *  `extra` context ever reaches Sentry from an error object. */
function cloneErrorForSentry(error: Error): Error {
  const clone = new Error(error.message);
  clone.name = error.name;
  clone.stack = error.stack;
  return clone;
}

/**
 * Best-effort forward to Sentry. Must never throw — a Sentry hiccup can
 * never be allowed to break the caller or mask the original log line, which
 * has already been written to the console sink by the time this runs.
 */
function forwardToSentry(
  level: "warn" | "error",
  message: string,
  redactedContext: LogContext | undefined,
  originalError: Error | undefined,
): void {
  try {
    const sentryLevel = toSentryLevel(level);
    if (originalError) {
      Sentry.captureException(cloneErrorForSentry(originalError), {
        level: sentryLevel,
        extra: redactedContext,
      });
    } else {
      Sentry.captureMessage(message, { level: sentryLevel, extra: redactedContext });
    }
  } catch {
    // Swallowed intentionally — see doc comment above.
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

function log(level: LogLevel, message: string, context?: LogContext): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[minLevel()]) {
    return;
  }

  // The logger is called from ~15 catch blocks; it MUST NEVER throw — a throw
  // here would mask the original error and can strand job state (review H1
  // blocker A). Redaction is hardened against BigInt/invalid-Date above, but a
  // hostile getter on a context value could still throw during the walk (or a
  // future exotic value), so wrap the whole path and degrade to a bare message.
  try {
    const originalError = extractError(context);
    const redacted = redactContext(context);

    writeToConsole(level, message, redacted);

    if ((level === "warn" || level === "error") && isSentryEnabled()) {
      forwardToSentry(level, message, redacted, originalError);
    }
  } catch {
    // Last resort — never propagate a logging failure to the caller's catch.
    try {
      console.error(message);
    } catch {
      /* nothing more we can safely do */
    }
  }
}

/**
 * The app-wide structured logger. Server-side usage:
 * `logger.error("[Posts] Unexpected error", { error, userId })`.
 *
 * Redaction (SEC-1) and Sentry forwarding are both handled internally — call
 * sites never need to sanitize context themselves before logging, though
 * they still must never pass a raw secret as the top-level `message` string
 * (redaction only inspects `context` keys, not string contents).
 */
export const logger = {
  debug(message: string, context?: LogContext): void {
    log("debug", message, context);
  },
  info(message: string, context?: LogContext): void {
    log("info", message, context);
  },
  warn(message: string, context?: LogContext): void {
    log("warn", message, context);
  },
  error(message: string, context?: LogContext): void {
    log("error", message, context);
  },
};
