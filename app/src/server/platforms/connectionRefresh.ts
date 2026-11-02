import type { SocialConnection } from "@prisma/client";

import { TOKEN_REFRESH_SUPERSEDED_CODE } from "./connectionHealth";
import { budgetedTimeout } from "./publishBudget";

// Server-only: touches prisma.
//
// 2026-11-01 scale audit (jobs, token refresh): ONE choke point for every OAuth
// token refresh (publish, health sweep, metrics sync, reviews, GBP location
// picker). Without it two processes refresh the same connection at once - two
// publishes, or a publish plus the health sweep or the metrics sync - and
// because TikTok rotates its refresh token (V15) the loser gets `invalid_grant`,
// which marked a WORKING connection needsReconnect and emailed its owners.
// Google and LinkedIn do not rotate (V16, googleTokens.ts header) but go
// through here too, so the re-read and the guarded flag apply everywhere.
//
// The fix has three parts:
//  1. a per-connection, transaction-scoped Postgres advisory lock;
//  2. a re-read of the row INSIDE the lock: if the tokens changed, another
//     process already refreshed and its row is returned (no second refresh);
//  3. a re-read before flagging (markConnectionNeedsReconnect `expected`): a
//     refresher whose terminal failure was overtaken throws
//     TOKEN_REFRESH_SUPERSEDED and this helper returns the stored row.
//
// X is excluded: it is OAuth 1.0a in this app and never refreshes (xClient.ts).
// An OAuth 2.0 migration of X must refresh through this helper.

/**
 * First key of the two-key advisory lock `pg_advisory_xact_lock(key1, key2)`.
 * The two-key and one-key spaces "do not overlap" (V20,
 * https://www.postgresql.org/docs/current/functions-admin.html), so this cannot
 * collide with mediaBlob.ts's one-key `hashtext(<url>)` locks. The second key is
 * `hashtext(<connectionId>)`.
 */
export const REFRESH_LOCK_NAMESPACE = 7301;

/**
 * How long a caller waits for another process's refresh of the same connection
 * (transaction-local `lock_timeout`). A refresh request is bounded at 30 s
 * (DEFAULT_FETCH_TIMEOUT_MS), so a holder that is merely slow finishes well
 * inside this; a holder stuck longer is reported as CONNECTION_REFRESH_BUSY.
 */
export const REFRESH_LOCK_WAIT_MS = 20_000;

/**
 * Upper bound of the lock-holding transaction: lock wait (20 s) + one refresh
 * request (30 s) + the re-reads fit in it. Also clamped to the step deadline.
 * If the pooler ignored `lock_timeout` (U6, unconfirmed) this still bounds the
 * wait.
 */
export const REFRESH_TX_TIMEOUT_MS = 60_000;

/** Prisma `maxWait`: how long to wait for a pooled connection to open the transaction. */
export const REFRESH_TX_MAX_WAIT_MS = 10_000;

/** Another process holds the refresh lock and did not finish in time. Transient (503). */
export const CONNECTION_REFRESH_BUSY_CODE = "CONNECTION_REFRESH_BUSY";

/** Same code the publish pipeline records when a connection row no longer exists. */
export const CONNECTION_GONE_CODE = "CONNECTION_GONE";

/** Same code the publish pipeline records for a connection flagged needsReconnect. */
export const CONNECTION_RECONNECT_REQUIRED_CODE = "RECONNECT_REQUIRED";

function codedError<T extends object = object>(
  message: string,
  code: string,
  extra?: T,
): Error & { code: string } & T {
  return Object.assign(new Error(message), { code }, extra) as Error & { code: string } & T;
}

/**
 * Did the caller's wait for the lock fail? A Postgres lock timeout (SQLSTATE
 * 55P03: Prisma reports it as P2010 with the SQLSTATE in `meta.code` and
 * "canceling statement due to lock timeout" in the message), or Prisma failing
 * to open / keep the transaction in time (P2028).
 */
function isLockWaitFailure(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const err = error as { code?: unknown; message?: unknown; meta?: { code?: unknown; message?: unknown } };
  if (err.code === "P2028") return true;
  const text = [err.message, err.meta?.code, err.meta?.message]
    .filter((part): part is string => typeof part === "string")
    .join(" ");
  return /\b55P03\b|lock timeout/i.test(text);
}

/**
 * Refresh `snapshot`'s OAuth tokens at most once across all processes.
 *
 * @param snapshot the connection as the caller loaded it. Its tokens are what
 *   the caller believes are current; if the stored ones differ by the time the
 *   lock is held, another process refreshed and its row is returned instead.
 * @param refresh the platform refresher (e.g. `(c) => refreshTikTokToken(c,
 *   { deadline })`). It receives the row re-read under the lock, persists the new
 *   tokens itself and returns the updated row. Run in the caller's own database
 *   session: the lock transaction exists only to HOLD the lock, so reads and
 *   writes go through the extended `prisma` client (tokens are decrypted on read
 *   and encrypted on write) and, under Read Committed, a read after the lock
 *   sees the previous holder's commit.
 * @param opts.deadline epoch ms by which the caller's step must be done
 *   (publishBudget.ts). Bounds the transaction; the refresher gets the same
 *   deadline from its caller's closure.
 *
 * @returns the connection row to use: the refreshed one, or the stored one when
 *   another process refreshed first (or our flag was refused as superseded).
 *
 * Throws (with `error.code`):
 *  - `PUBLISH_TIME_BUDGET_EXCEEDED` with under MIN_REQUEST_WINDOW_MS left; no
 *    transaction is opened.
 *  - `CONNECTION_GONE` when the row no longer exists.
 *  - `RECONNECT_REQUIRED` when the row is already flagged needsReconnect; no
 *    refresh is attempted.
 *  - `CONNECTION_REFRESH_BUSY` (`status: 503`) when the lock could not be taken
 *    in REFRESH_LOCK_WAIT_MS. Nothing was sent to the platform, so the in-step
 *    transient retry (transientRetry.ts) may safely run again.
 *  - whatever `refresh` throws, unchanged, except TOKEN_REFRESH_SUPERSEDED.
 */
export async function refreshConnectionToken(
  snapshot: SocialConnection,
  refresh: (current: SocialConnection) => Promise<SocialConnection>,
  opts?: { deadline?: number },
): Promise<SocialConnection> {
  // Throws PUBLISH_TIME_BUDGET_EXCEEDED (before any transaction) when the step
  // budget is spent; otherwise the transaction may not outlive the deadline.
  const txTimeoutMs = budgetedTimeout(REFRESH_TX_TIMEOUT_MS, opts?.deadline);

  const { prisma } = await import("@/lib/db");

  // Re-read the row (extended client: tokens decrypted) and refuse a gone or
  // flagged connection. Always called with the lock held.
  async function loadUsable(): Promise<SocialConnection> {
    const stored = await prisma.socialConnection.findUnique({ where: { id: snapshot.id } });
    if (!stored) {
      throw codedError("This platform connection was removed. Reconnect and retry.", CONNECTION_GONE_CODE);
    }
    if (stored.needsReconnect) {
      throw codedError(
        "This platform needs to be reconnected in Settings before publishing.",
        CONNECTION_RECONNECT_REQUIRED_CODE,
      );
    }
    return stored;
  }

  // Once the refresher has been called a request may have been sent: a failure
  // after that point is the refresher's, never "busy" (which promises that
  // nothing was sent and a retry is safe).
  const progress: { refreshStarted: boolean; finished?: SocialConnection } = {
    refreshStarted: false,
  };

  try {
    return await prisma.$transaction(
      async (tx) => {
        // Transaction-local (set_config(..., true)): a stuck holder cannot keep
        // this caller waiting past REFRESH_LOCK_WAIT_MS, and the setting does
        // not leak to other users of a pooled session. The lock is released at
        // the end of the transaction (V20), which the Neon pooler allows (U6).
        await tx.$executeRaw`SELECT set_config('lock_timeout', ${`${REFRESH_LOCK_WAIT_MS}ms`}, true)`;
        // `::int` is required: Prisma sends a JS number as bigint, and Postgres
        // has no pg_advisory_xact_lock(bigint, integer) (checked on Postgres,
        // SQLSTATE 42883, 2026-11-02).
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(${REFRESH_LOCK_NAMESPACE}::int, hashtext(${snapshot.id}))`;

        const stored = await loadUsable();
        if (
          stored.accessToken !== snapshot.accessToken ||
          stored.refreshToken !== snapshot.refreshToken
        ) {
          // Another process refreshed between the caller's load and our lock.
          progress.finished = stored;
          return stored;
        }

        progress.refreshStarted = true;
        let connection: SocialConnection;
        try {
          connection = await refresh(stored);
        } catch (error) {
          if ((error as { code?: unknown } | null)?.code !== TOKEN_REFRESH_SUPERSEDED_CODE) throw error;
          // The refresher's terminal failure was refused by the guarded flag
          // because the stored tokens changed under it: the stored row is the
          // winner's (it also re-checks gone / flagged).
          connection = await loadUsable();
        }
        progress.finished = connection;
        return connection;
      },
      { maxWait: REFRESH_TX_MAX_WAIT_MS, timeout: txTimeoutMs },
    );
  } catch (error) {
    // The work finished but the transaction expired before it could commit:
    // nothing is left to protect (the lock only serialized the refresh, which
    // wrote through its own session), so hand back the result.
    if (progress.finished && (error as { code?: unknown } | null)?.code === "P2028") {
      return progress.finished;
    }
    if (!progress.refreshStarted && isLockWaitFailure(error)) {
      throw codedError(
        "Another refresh of this connection is in progress. Please retry.",
        CONNECTION_REFRESH_BUSY_CODE,
        { status: 503 },
      );
    }
    throw error;
  }
}
