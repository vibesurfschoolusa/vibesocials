import type { PrismaClient, SocialConnection } from "@prisma/client";

import { logger } from "@/lib/logger";

import { TOKEN_REFRESH_SUPERSEDED_CODE } from "./connectionHealth";
import {
  budgetedTimeout,
  MIN_REQUEST_WINDOW_MS,
  PUBLISH_BUDGET_EXCEEDED_CODE,
  publishBudgetExceededError,
  remainingMs,
} from "./publishBudget";

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
// POOL BUDGET (fix round 1, C1). The lock transaction pins ONE pooled
// connection for the whole refresh, and the re-read, the refresher's token write
// and the guarded flag each need a SECOND connection from the same per-instance
// pool (they go through the extended `prisma`, so the refresher code is
// unchanged). Unbounded, the lock transactions of one instance could take the
// whole pool and starve their own queries and the publish claim/finalize
// queries: at connection_limit=1 no refresh could ever succeed, and at 5 (the
// production value, docs/STAGING_SETUP.md) ten concurrent refreshes deadlock
// once five lock transactions are open. So, per process:
//  - concurrent callers for one connection id share ONE flight (single-flight):
//    they do not each take a pool connection and the lock;
//  - at most refreshLockCap() lock transactions run at once, a semaphore sized
//    from DATABASE_URL's connection_limit: min(2, connection_limit - 1). It
//    always leaves a connection free for the queries of the lock holders and of
//    everything else; waiters wait in memory, holding no connection;
//  - connection_limit=1 leaves no room for a lock transaction: the lock is
//    skipped (a one-time warning), the refresh runs unserialized across
//    instances, as it did before this helper.
//
// BUDGET-BOUND WAITS (2026-11-02 scale audit, jobs, token refresh). Both waits the
// helper adds in front of a refresh end by the CALLER's step deadline, not only by
// REFRESH_LOCK_WAIT_MS: a caller with 12 s left must not queue for 20 s, and a
// single-flight follower must not wait out the whole of a leader's flight. When it
// is the budget that ran out the error is PUBLISH_TIME_BUDGET_EXCEEDED (nothing
// was sent, the step's retry is safe), not CONNECTION_REFRESH_BUSY.
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
 * (transaction-local `lock_timeout`), and how long a caller waits in memory for
 * one of this process's lock slots. A refresh request is bounded at 30 s
 * (DEFAULT_FETCH_TIMEOUT_MS), so a holder that is merely slow finishes well
 * inside this; a holder stuck longer is reported as CONNECTION_REFRESH_BUSY.
 * The in-memory wait is shorter when the caller's step budget is (see
 * {@link slotWait}); the transaction-local `lock_timeout` stays at this value.
 */
export const REFRESH_LOCK_WAIT_MS = 20_000;

/**
 * Upper bound of the lock-holding transaction: lock wait (20 s) + one refresh
 * request (30 s) + the re-reads fit in it. Also clamped to the step deadline.
 * If the pooler ignored `lock_timeout` (U6, unconfirmed) this still bounds the
 * wait. It starts when the lock slot is granted, so a wait for a slot does not
 * use it up.
 */
export const REFRESH_TX_TIMEOUT_MS = 60_000;

/** Prisma `maxWait`: how long to wait for a pooled connection to open the transaction. */
export const REFRESH_TX_MAX_WAIT_MS = 10_000;

/**
 * Most lock transactions one process runs at once, and the cap when
 * DATABASE_URL has no usable `connection_limit` (Prisma's default pool is
 * num_cpus * 2 + 1, at least 3). Two keep a Fluid-compute instance's pool
 * (production: connection_limit=5) from being taken by lock holders: 2 pinned,
 * at least 1 free for the queries of those two holders and of every publish.
 */
export const REFRESH_LOCK_MAX_CONCURRENCY = 2;

/** Another process holds the refresh lock and did not finish in time. Transient (503). */
export const CONNECTION_REFRESH_BUSY_CODE = "CONNECTION_REFRESH_BUSY";

/** Same code the publish pipeline records when a connection row no longer exists. */
export const CONNECTION_GONE_CODE = "CONNECTION_GONE";

/** Same code the publish pipeline records for a connection flagged needsReconnect. */
export const CONNECTION_RECONNECT_REQUIRED_CODE = "RECONNECT_REQUIRED";

/**
 * How many lock transactions this process may run at once, from the
 * `connection_limit` query parameter of `databaseUrl` (Prisma's per-instance pool
 * size): `min(REFRESH_LOCK_MAX_CONCURRENCY, connection_limit - 1)`, so one pooled
 * connection always stays free for the lock holders' own queries. 0 means no
 * lock transaction fits (connection_limit=1). A missing, empty or invalid
 * parameter (not a whole number >= 1) gives REFRESH_LOCK_MAX_CONCURRENCY.
 * https://www.prisma.io/docs/orm/prisma-client/setup-and-configuration/databases-connections/connection-pool
 */
export function refreshLockCap(databaseUrl: string | undefined): number {
  const raw = /[?&]connection_limit=([^&#]*)/.exec(databaseUrl ?? "")?.[1];
  if (raw === undefined || !/^\d+$/.test(raw)) return REFRESH_LOCK_MAX_CONCURRENCY;
  const connectionLimit = Number.parseInt(raw, 10);
  if (connectionLimit < 1) return REFRESH_LOCK_MAX_CONCURRENCY;
  return Math.min(REFRESH_LOCK_MAX_CONCURRENCY, connectionLimit - 1);
}

/** Process-wide state of the helper (one per serverless instance). */
interface RefreshLockState {
  /** Lock transactions currently open (or about to be). */
  active: number;
  /** Callers waiting in memory for a slot, oldest first; each takes the slot when called. */
  waiters: Array<() => void>;
  /** The refresh in flight per connection id (single-flight). */
  inFlight: Map<string, Promise<SocialConnection>>;
  /** The "running without the lock" warning was logged. */
  warnedNoLock: boolean;
}

function newLockState(): RefreshLockState {
  return { active: 0, waiters: [], inFlight: new Map(), warnedNoLock: false };
}

let lockState = newLockState();

/** Test seam: forget every slot, waiter, in-flight refresh and the warn-once flag. */
export function resetRefreshLockStateForTests(): void {
  lockState = newLockState();
}

function codedError<T extends object = object>(
  message: string,
  code: string,
  extra?: T,
): Error & { code: string } & T {
  return Object.assign(new Error(message), { code }, extra) as Error & { code: string } & T;
}

function busyError(): Error & { code: string; status: number } {
  return codedError(
    "Another refresh of this connection is in progress. Please retry.",
    CONNECTION_REFRESH_BUSY_CODE,
    { status: 503 },
  );
}

/**
 * Did the caller fail to get what it needs to START the refresh? A Postgres lock
 * timeout (SQLSTATE 55P03: Prisma reports it as P2010 with the SQLSTATE in
 * `meta.code` and "canceling statement due to lock timeout" in the message),
 * Prisma failing to open / keep the transaction in time (P2028), or the pool
 * having no connection for a query within `pool_timeout` (P2024). Only ever
 * treated as "busy" before the refresher is called: nothing was sent then.
 */
function isLockWaitFailure(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const err = error as { code?: unknown; message?: unknown; meta?: { code?: unknown; message?: unknown } };
  if (err.code === "P2028" || err.code === "P2024") return true;
  const text = [err.message, err.meta?.code, err.meta?.message]
    .filter((part): part is string => typeof part === "string")
    .join(" ");
  return /\b55P03\b|lock timeout/i.test(text);
}

/**
 * Take one of this process's lock slots, or wait in memory (holding no pooled
 * connection) until one frees up. A free slot is taken at once, whatever `waitMs`.
 * Otherwise it waits at most `waitMs` and then rejects with `onTimeout()`; with
 * `waitMs <= 0` there is nothing to wait for and it rejects at once, starting no
 * timer. Resolves to the function that gives the slot back.
 */
function acquireSlot(
  state: RefreshLockState,
  cap: number,
  waitMs: number,
  onTimeout: () => Error,
): Promise<() => void> {
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    state.active--;
    state.waiters.shift()?.();
  };

  if (state.active < cap) {
    state.active++;
    return Promise.resolve(release);
  }

  if (waitMs <= 0) return Promise.reject(onTimeout());

  return new Promise((resolve, reject) => {
    const grant = () => {
      clearTimeout(timer);
      state.active++;
      resolve(release);
    };
    const timer = setTimeout(() => {
      const index = state.waiters.indexOf(grant);
      if (index >= 0) state.waiters.splice(index, 1);
      reject(onTimeout());
    }, waitMs);
    state.waiters.push(grant);
  });
}

/**
 * How long a caller may wait for a lock slot: the REFRESH_LOCK_WAIT_MS bound,
 * clamped to its own budget (`remainingMs(deadline) - MIN_REQUEST_WINDOW_MS`: the
 * refresh request that follows needs that window). `onTimeout` is the error for
 * the bound that applies - CONNECTION_REFRESH_BUSY when the 20 s bound is the
 * shorter (or ties), PUBLISH_TIME_BUDGET_EXCEEDED when the budget is.
 */
function slotWait(deadline: number | undefined): { waitMs: number; onTimeout: () => Error } {
  const budgetMs = remainingMs(deadline) - MIN_REQUEST_WINDOW_MS;
  return budgetMs < REFRESH_LOCK_WAIT_MS
    ? { waitMs: budgetMs, onTimeout: publishBudgetExceededError }
    : { waitMs: REFRESH_LOCK_WAIT_MS, onTimeout: busyError };
}

/**
 * Re-read the row (extended client: tokens decrypted) and refuse a gone or
 * flagged connection.
 */
async function loadUsable(prisma: PrismaClient, connectionId: string): Promise<SocialConnection> {
  const stored = await prisma.socialConnection.findUnique({ where: { id: connectionId } });
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

interface RefreshProgress {
  /**
   * Once the refresher has been called a request may have been sent: a failure
   * after that point is the refresher's, never "busy" (which promises that
   * nothing was sent and a retry is safe).
   */
  refreshStarted: boolean;
  /** Set when the work is done, so an expiring transaction cannot lose it. */
  finished?: SocialConnection;
}

/** The work done with the lock held (or, at connection_limit=1, without it). */
async function refreshFromStoredRow(
  prisma: PrismaClient,
  snapshot: SocialConnection,
  refresh: (current: SocialConnection) => Promise<SocialConnection>,
  progress: RefreshProgress,
): Promise<SocialConnection> {
  const stored = await loadUsable(prisma, snapshot.id);
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
    // The refresher's terminal failure was refused by the guarded flag because
    // the stored tokens changed under it: the stored row is the winner's (it
    // also re-checks gone / flagged).
    connection = await loadUsable(prisma, snapshot.id);
  }
  progress.finished = connection;
  return connection;
}

async function runRefresh(
  state: RefreshLockState,
  snapshot: SocialConnection,
  refresh: (current: SocialConnection) => Promise<SocialConnection>,
  opts: { deadline?: number } | undefined,
): Promise<SocialConnection> {
  const { prisma } = await import("@/lib/db");
  const progress: RefreshProgress = { refreshStarted: false };

  try {
    const cap = refreshLockCap(process.env.DATABASE_URL);

    if (cap < 1) {
      // connection_limit=1: a lock transaction would take the only connection and
      // the re-read could never run. Refresh without the lock, as before.
      if (!state.warnedNoLock) {
        state.warnedNoLock = true;
        logger.warn(
          "[ConnectionRefresh] connection_limit=1: OAuth refresh runs without the per-connection lock; set connection_limit >= 3",
        );
      }
      return await refreshFromStoredRow(prisma, snapshot, refresh, progress);
    }

    const { waitMs, onTimeout } = slotWait(opts?.deadline);
    const releaseSlot = await acquireSlot(state, cap, waitMs, onTimeout);
    try {
      // Computed AFTER the wait for a slot: throws PUBLISH_TIME_BUDGET_EXCEEDED
      // when the wait used up the step budget, and the transaction may not
      // outlive the deadline.
      const txTimeoutMs = budgetedTimeout(REFRESH_TX_TIMEOUT_MS, opts?.deadline);

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

          return refreshFromStoredRow(prisma, snapshot, refresh, progress);
        },
        { maxWait: REFRESH_TX_MAX_WAIT_MS, timeout: txTimeoutMs },
      );
    } finally {
      releaseSlot();
    }
  } catch (error) {
    // The work finished but the transaction expired before it could commit:
    // nothing is left to protect (the lock only serialized the refresh, which
    // wrote through its own session), so hand back the result.
    if (progress.finished && (error as { code?: unknown } | null)?.code === "P2028") {
      return progress.finished;
    }
    if (!progress.refreshStarted && isLockWaitFailure(error)) throw busyError();
    throw error;
  }
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
 * Within one process, concurrent calls for the same connection id share one
 * flight: the first call's `refresh` and deadline serve all of them, and they all
 * get the same row (or the same error). The entry is cleared when the flight
 * settles. Across processes the advisory lock does the serializing.
 *
 * A follower waits for the leader's flight at most its OWN
 * `remainingMs(deadline) - MIN_REQUEST_WINDOW_MS`, then rejects
 * PUBLISH_TIME_BUDGET_EXCEEDED; the leader is not cancelled. If the leader
 * rejects PUBLISH_TIME_BUDGET_EXCEEDED (ITS budget ran out - nothing was sent) a
 * follower with budget left starts its own flight, once, after the leader's entry
 * is cleared; later followers join that flight. Any other leader error is shared.
 *
 * @returns the connection row to use: the refreshed one, or the stored one when
 *   another process refreshed first (or our flag was refused as superseded).
 *
 * Throws (with `error.code`):
 *  - `PUBLISH_TIME_BUDGET_EXCEEDED` with under MIN_REQUEST_WINDOW_MS left (checked
 *    first, and again after waiting for a lock slot); no transaction is opened.
 *    Also when the caller's budget (less MIN_REQUEST_WINDOW_MS) ends before a lock
 *    slot frees up, or before the flight it follows settles.
 *  - `CONNECTION_GONE` when the row no longer exists.
 *  - `RECONNECT_REQUIRED` when the row is already flagged needsReconnect; no
 *    refresh is attempted.
 *  - `CONNECTION_REFRESH_BUSY` (`status: 503`) when the refresh could not start:
 *    no lock slot free in this process within REFRESH_LOCK_WAIT_MS, the advisory
 *    lock not taken in REFRESH_LOCK_WAIT_MS, or the pool had no connection in
 *    time (P2024/P2028). Nothing was sent to the platform, so the in-step
 *    transient retry (transientRetry.ts) may safely run again.
 *  - whatever `refresh` throws, unchanged, except TOKEN_REFRESH_SUPERSEDED.
 */
export async function refreshConnectionToken(
  snapshot: SocialConnection,
  refresh: (current: SocialConnection) => Promise<SocialConnection>,
  opts?: { deadline?: number },
): Promise<SocialConnection> {
  // Throws PUBLISH_TIME_BUDGET_EXCEEDED (before any flight, lock or transaction)
  // when the step budget is spent. A caller with no budget must not join a flight
  // it cannot wait for.
  budgetedTimeout(REFRESH_TX_TIMEOUT_MS, opts?.deadline);

  const state = lockState;
  const leader = state.inFlight.get(snapshot.id);
  if (!leader) return startFlight(state, snapshot, refresh, opts);

  const followed = await followFlight(leader, opts?.deadline);
  if ("row" in followed) return followed.row;

  // The leader ran out of ITS budget before anything was sent. This follower has
  // budget left (its own wait did not end first), so it takes over - once.
  forgetFlight(state, snapshot.id, leader);
  budgetedTimeout(REFRESH_TX_TIMEOUT_MS, opts?.deadline);
  const successor = state.inFlight.get(snapshot.id);
  if (!successor) return startFlight(state, snapshot, refresh, opts);

  // Another follower of the same leader already started the new flight: join it,
  // and take its answer as final.
  const again = await followFlight(successor, opts?.deadline);
  if ("row" in again) return again.row;
  throw again.leaderBudgetError;
}

/** Start a flight for `snapshot.id` and register it for this process's other callers. */
function startFlight(
  state: RefreshLockState,
  snapshot: SocialConnection,
  refresh: (current: SocialConnection) => Promise<SocialConnection>,
  opts: { deadline?: number } | undefined,
): Promise<SocialConnection> {
  const flight = runRefresh(state, snapshot, refresh, opts);
  state.inFlight.set(snapshot.id, flight);
  const clear = () => forgetFlight(state, snapshot.id, flight);
  flight.then(clear, clear);
  return flight;
}

/** Drop `flight`'s entry, unless a newer flight has already replaced it. */
function forgetFlight(
  state: RefreshLockState,
  connectionId: string,
  flight: Promise<SocialConnection>,
): void {
  if (state.inFlight.get(connectionId) === flight) state.inFlight.delete(connectionId);
}

/** What a follower learns from the leader's flight. */
type Followed =
  | { row: SocialConnection }
  /** The leader rejected PUBLISH_TIME_BUDGET_EXCEEDED: its budget, not the follower's. */
  | { leaderBudgetError: Error };

/**
 * Wait for `flight` (another caller's refresh) for at most this follower's own
 * `remainingMs(deadline) - MIN_REQUEST_WINDOW_MS`, then reject
 * PUBLISH_TIME_BUDGET_EXCEEDED. The flight itself is never cancelled. Without a
 * deadline there is no bound. With nothing to wait (<= 0) it rejects at once and
 * starts no timer. A leader error other than PUBLISH_TIME_BUDGET_EXCEEDED is
 * rethrown as is (shared).
 */
function followFlight(
  flight: Promise<SocialConnection>,
  deadline: number | undefined,
): Promise<Followed> {
  const waitMs = remainingMs(deadline) - MIN_REQUEST_WINDOW_MS;
  if (waitMs <= 0) return Promise.reject(publishBudgetExceededError());

  return new Promise<Followed>((resolve, reject) => {
    const timer = Number.isFinite(waitMs)
      ? setTimeout(() => reject(publishBudgetExceededError()), waitMs)
      : undefined;
    flight.then(
      (row) => {
        clearTimeout(timer);
        resolve({ row });
      },
      (error: unknown) => {
        clearTimeout(timer);
        if ((error as { code?: unknown } | null)?.code === PUBLISH_BUDGET_EXCEEDED_CODE) {
          resolve({ leaderBudgetError: error as Error });
        } else {
          reject(error);
        }
      },
    );
  });
}
