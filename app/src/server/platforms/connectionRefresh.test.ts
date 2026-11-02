import type { SocialConnection } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { logger } from "@/lib/logger";
import { tokenRefreshSupersededError } from "@/server/platforms/connectionHealth";
import {
  CONNECTION_GONE_CODE,
  CONNECTION_REFRESH_BUSY_CODE,
  CONNECTION_RECONNECT_REQUIRED_CODE,
  REFRESH_LOCK_MAX_CONCURRENCY,
  REFRESH_LOCK_NAMESPACE,
  REFRESH_LOCK_WAIT_MS,
  REFRESH_TX_MAX_WAIT_MS,
  REFRESH_TX_TIMEOUT_MS,
  refreshConnectionToken,
  refreshLockCap,
  resetRefreshLockStateForTests,
} from "@/server/platforms/connectionRefresh";
import {
  MIN_REQUEST_WINDOW_MS,
  PUBLISH_BUDGET_EXCEEDED_CODE,
  publishBudgetExceededError,
} from "@/server/platforms/publishBudget";

// 2026-11-01 scale audit (jobs, token refresh): the helper opens a Prisma
// interactive transaction ONLY to hold a transaction-scoped Postgres advisory
// lock; every read and write goes through the extended `prisma` client. The
// `$transaction` mock below invokes the callback with a tx that records its
// `$executeRaw` calls (tagged templates), so the lock statements and their
// order are asserted without a database.
const { executeRawMock, findUniqueMock, transactionMock } = vi.hoisted(() => ({
  executeRawMock: vi.fn(),
  findUniqueMock: vi.fn(),
  transactionMock: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    $transaction: transactionMock,
    socialConnection: { findUnique: findUniqueMock },
  },
}));

type CodedError = Error & { code?: string; status?: number };

function makeConnection(overrides: Partial<SocialConnection> = {}): SocialConnection {
  return {
    id: "conn-1",
    userId: "user-1",
    workspaceId: "workspace-1",
    platform: "tiktok",
    accessToken: "access-1",
    refreshToken: "refresh-1",
    expiresAt: new Date("2020-01-01T00:00:00Z"),
    accountIdentifier: "acct-1",
    scopes: null,
    metadata: null,
    needsReconnect: false,
    lastRefreshErrorCode: null,
    refreshFailedAt: null,
    createdAt: new Date("2020-01-01T00:00:00Z"),
    updatedAt: new Date("2020-01-01T00:00:00Z"),
    ...overrides,
  };
}

async function caught(promise: Promise<unknown>): Promise<CodedError | null> {
  return promise.then(
    () => null,
    (e: unknown) => e as CodedError,
  );
}

/** A `$executeRaw` tagged-template call as `{ sql, values }` (`$n` placeholders). */
function statement(call: unknown[]): { sql: string; values: unknown[] } {
  const [strings, ...values] = call as [readonly string[], ...unknown[]];
  return {
    sql: strings.reduce((acc, part, i) => acc + part + (i < values.length ? `$${i + 1}` : ""), ""),
    values,
  };
}

const statements = () => executeRawMock.mock.calls.map(statement);

beforeEach(() => {
  // The semaphore, the single-flight map and the warn-once flag are process-wide.
  resetRefreshLockStateForTests();
  // Neutral pool settings: no connection_limit -> the lock cap is 2.
  vi.stubEnv("DATABASE_URL", "postgresql://user:pass@localhost:5432/db");
  executeRawMock.mockReset();
  findUniqueMock.mockReset();
  transactionMock.mockReset();
  executeRawMock.mockResolvedValue(1);
  // Default: the callback runs at once with a tx that records its raw statements.
  transactionMock.mockImplementation((callback: (tx: unknown) => unknown) =>
    callback({ $executeRaw: executeRawMock }),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("constants", () => {
  it("pins the lock namespace, the lock wait, and the transaction bounds", () => {
    expect(REFRESH_LOCK_NAMESPACE).toBe(7301);
    expect(REFRESH_LOCK_WAIT_MS).toBe(20_000);
    expect(REFRESH_TX_TIMEOUT_MS).toBe(60_000);
    expect(REFRESH_TX_MAX_WAIT_MS).toBe(10_000);
    expect(CONNECTION_REFRESH_BUSY_CODE).toBe("CONNECTION_REFRESH_BUSY");
    expect(CONNECTION_GONE_CODE).toBe("CONNECTION_GONE");
    expect(CONNECTION_RECONNECT_REQUIRED_CODE).toBe("RECONNECT_REQUIRED");
  });
});

describe("refreshConnectionToken — the lock", () => {
  it("takes the per-connection two-key advisory lock BEFORE the re-read, then refreshes", async () => {
    const snapshot = makeConnection({ id: "conn-1" });
    findUniqueMock.mockResolvedValue(snapshot);
    const refresh = vi.fn().mockResolvedValue(makeConnection({ accessToken: "access-2" }));

    await refreshConnectionToken(snapshot, refresh);

    const [setConfig, lock] = statements();
    expect(statements()).toHaveLength(2);
    // Transaction-local lock_timeout (set_config(..., true)) so a stuck holder
    // cannot hold this caller past REFRESH_LOCK_WAIT_MS.
    expect(setConfig.sql).toContain("set_config('lock_timeout'");
    expect(setConfig.sql).toContain(", true)");
    expect(setConfig.values).toEqual([`${REFRESH_LOCK_WAIT_MS}ms`]);
    // Two-key space (7301, hashtext(<connectionId>)): it cannot collide with
    // mediaBlob.ts's one-key URL locks.
    expect(lock.sql).toContain("pg_advisory_xact_lock(");
    expect(lock.sql).toContain("hashtext(");
    // Prisma binds a JS number as bigint and Postgres has no
    // pg_advisory_xact_lock(bigint, integer): without the cast the lock fails.
    expect(lock.sql).toContain("$1::int");
    expect(lock.values).toEqual([7301, "conn-1"]);

    const order = (mock: { mock: { invocationCallOrder: number[] } }) =>
      mock.mock.invocationCallOrder[0];
    expect(order(executeRawMock)).toBeLessThan(order(findUniqueMock));
    expect(executeRawMock.mock.invocationCallOrder[1]).toBeLessThan(order(findUniqueMock));
    expect(order(findUniqueMock)).toBeLessThan(order(refresh));
  });

  it("opens the transaction with maxWait 10 s and a 60 s timeout, only to hold the lock", async () => {
    const snapshot = makeConnection();
    findUniqueMock.mockResolvedValue(snapshot);

    await refreshConnectionToken(snapshot, vi.fn().mockResolvedValue(snapshot));

    expect(transactionMock).toHaveBeenCalledTimes(1);
    expect(transactionMock.mock.calls[0][1]).toEqual({ maxWait: 10_000, timeout: 60_000 });
  });

  it("clamps the transaction timeout to the time left before the step deadline", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-02T10:00:00Z"));
    const snapshot = makeConnection();
    findUniqueMock.mockResolvedValue(snapshot);

    await refreshConnectionToken(snapshot, vi.fn().mockResolvedValue(snapshot), {
      deadline: Date.now() + 25_000,
    });

    expect(transactionMock.mock.calls[0][1]).toEqual({ maxWait: 10_000, timeout: 25_000 });
  });

  it("reads and writes through the extended prisma client: refresh gets the re-read row, not the snapshot", async () => {
    const snapshot = makeConnection();
    const stored = makeConnection({ metadata: { organizations: [] } });
    findUniqueMock.mockResolvedValue(stored);
    const refreshed = makeConnection({ accessToken: "access-2" });
    const refresh = vi.fn().mockResolvedValue(refreshed);

    const result = await refreshConnectionToken(snapshot, refresh);

    expect(findUniqueMock).toHaveBeenCalledWith({ where: { id: "conn-1" } });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledWith(stored);
    expect(result).toBe(refreshed);
  });
});

describe("refreshConnectionToken — the re-read inside the lock", () => {
  it("does not refresh and returns the stored row when the access token changed (someone else refreshed)", async () => {
    const snapshot = makeConnection({ accessToken: "access-1" });
    const stored = makeConnection({ accessToken: "access-2" });
    findUniqueMock.mockResolvedValue(stored);
    const refresh = vi.fn();

    const result = await refreshConnectionToken(snapshot, refresh);

    expect(refresh).not.toHaveBeenCalled();
    expect(result).toBe(stored);
  });

  it("does not refresh and returns the stored row when only the refresh token rotated (TikTok)", async () => {
    const snapshot = makeConnection({ refreshToken: "refresh-1" });
    const stored = makeConnection({ refreshToken: "refresh-2" });
    findUniqueMock.mockResolvedValue(stored);
    const refresh = vi.fn();

    const result = await refreshConnectionToken(snapshot, refresh);

    expect(refresh).not.toHaveBeenCalled();
    expect(result).toBe(stored);
  });

  it("refreshes exactly once, with the stored row, when the tokens are unchanged", async () => {
    const snapshot = makeConnection();
    const stored = makeConnection();
    findUniqueMock.mockResolvedValue(stored);
    const refreshed = makeConnection({ accessToken: "access-2" });
    const refresh = vi.fn().mockResolvedValue(refreshed);

    const result = await refreshConnectionToken(snapshot, refresh);

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledWith(stored);
    expect(result).toBe(refreshed);
  });

  it("treats a null refresh token on both sides as unchanged", async () => {
    const snapshot = makeConnection({ refreshToken: null });
    findUniqueMock.mockResolvedValue(makeConnection({ refreshToken: null }));
    const refresh = vi.fn().mockResolvedValue(snapshot);

    await refreshConnectionToken(snapshot, refresh);

    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("returns the re-read row when refresh reports it was superseded (the flag was refused)", async () => {
    const snapshot = makeConnection();
    const stored = makeConnection();
    const afterSupersede = makeConnection({ accessToken: "access-9", refreshToken: "refresh-9" });
    findUniqueMock.mockResolvedValueOnce(stored).mockResolvedValueOnce(afterSupersede);
    const refresh = vi.fn().mockRejectedValue(tokenRefreshSupersededError());

    const result = await refreshConnectionToken(snapshot, refresh);

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(findUniqueMock).toHaveBeenCalledTimes(2);
    expect(result).toBe(afterSupersede);
  });

  it("reports CONNECTION_GONE when the row vanished after a superseded refresh", async () => {
    findUniqueMock.mockResolvedValueOnce(makeConnection()).mockResolvedValueOnce(null);
    const refresh = vi.fn().mockRejectedValue(tokenRefreshSupersededError());

    const error = await caught(refreshConnectionToken(makeConnection(), refresh));

    expect(error?.code).toBe("CONNECTION_GONE");
  });

  it("propagates any other refresh error unchanged", async () => {
    findUniqueMock.mockResolvedValue(makeConnection());
    const failure = Object.assign(new Error("TikTok connection expired"), {
      code: "TIKTOK_RECONNECT_REQUIRED",
    });

    const error = await caught(
      refreshConnectionToken(makeConnection(), vi.fn().mockRejectedValue(failure)),
    );

    expect(error).toBe(failure);
  });
});

describe("refreshConnectionToken — row states", () => {
  it("throws CONNECTION_GONE when the row no longer exists, without refreshing", async () => {
    findUniqueMock.mockResolvedValue(null);
    const refresh = vi.fn();

    const error = await caught(refreshConnectionToken(makeConnection(), refresh));

    expect(error?.code).toBe("CONNECTION_GONE");
    expect(error?.message).toBe("This platform connection was removed. Reconnect and retry.");
    expect(refresh).not.toHaveBeenCalled();
  });

  it("throws RECONNECT_REQUIRED when the row is already flagged, without refreshing", async () => {
    findUniqueMock.mockResolvedValue(makeConnection({ needsReconnect: true }));
    const refresh = vi.fn();

    const error = await caught(refreshConnectionToken(makeConnection(), refresh));

    expect(error?.code).toBe("RECONNECT_REQUIRED");
    expect(error?.message).toBe(
      "This platform needs to be reconnected in Settings before publishing.",
    );
    expect(refresh).not.toHaveBeenCalled();
  });

  it("checks the flag before the tokens: a flagged row whose tokens also changed is still RECONNECT_REQUIRED", async () => {
    findUniqueMock.mockResolvedValue(
      makeConnection({ needsReconnect: true, accessToken: "access-2" }),
    );

    const error = await caught(refreshConnectionToken(makeConnection(), vi.fn()));

    expect(error?.code).toBe("RECONNECT_REQUIRED");
  });
});

describe("refreshConnectionToken — lock timeout", () => {
  /** What Prisma throws for a raw query rejected by Postgres (P2010 wraps SQLSTATE 55P03). */
  function lockTimeoutError(): Error {
    return Object.assign(
      new Error(
        "Raw query failed. Code: `55P03`. Message: `ERROR: canceling statement due to lock timeout`",
      ),
      { code: "P2010", meta: { code: "55P03", message: "canceling statement due to lock timeout" } },
    );
  }

  it("turns a lock timeout into CONNECTION_REFRESH_BUSY with status 503, and never refreshes", async () => {
    executeRawMock.mockResolvedValueOnce(1).mockRejectedValueOnce(lockTimeoutError());
    const refresh = vi.fn();

    const error = await caught(refreshConnectionToken(makeConnection(), refresh));

    expect(error?.code).toBe("CONNECTION_REFRESH_BUSY");
    expect(error?.status).toBe(503);
    expect(refresh).not.toHaveBeenCalled();
    expect(findUniqueMock).not.toHaveBeenCalled();
  });

  it("recognises the SQLSTATE alone (55P03) as a lock timeout", async () => {
    executeRawMock
      .mockResolvedValueOnce(1)
      .mockRejectedValueOnce(Object.assign(new Error("boom"), { meta: { code: "55P03" } }));

    const error = await caught(refreshConnectionToken(makeConnection(), vi.fn()));

    expect(error?.code).toBe("CONNECTION_REFRESH_BUSY");
  });

  it("recognises a transaction that could not start or expired while waiting (P2028) as busy", async () => {
    transactionMock.mockRejectedValueOnce(
      Object.assign(new Error("Transaction API error: Unable to start a transaction in the given time."), {
        code: "P2028",
      }),
    );

    const error = await caught(refreshConnectionToken(makeConnection(), vi.fn()));

    expect(error?.code).toBe("CONNECTION_REFRESH_BUSY");
    expect(error?.status).toBe(503);
  });

  it("does NOT call a lock-timeout-looking failure raised by the refresh itself 'busy' (the refresh may have been sent)", async () => {
    findUniqueMock.mockResolvedValue(makeConnection());
    const failure = Object.assign(new Error("canceling statement due to lock timeout"), {
      code: "P2010",
    });

    const error = await caught(
      refreshConnectionToken(makeConnection(), vi.fn().mockRejectedValue(failure)),
    );

    expect(error).toBe(failure);
  });

  it("propagates an unrelated database error from the lock statements unchanged", async () => {
    const failure = new Error("connection reset");
    executeRawMock.mockRejectedValueOnce(failure);

    const error = await caught(refreshConnectionToken(makeConnection(), vi.fn()));

    expect(error).toBe(failure);
  });
});

describe("refreshConnectionToken — the lock transaction expiring", () => {
  const p2028 = () =>
    Object.assign(new Error("Transaction API error: A commit cannot be executed on an expired transaction."), {
      code: "P2028",
    });

  it("returns the refreshed row when the transaction expires only AFTER the work finished (it wrote through its own session)", async () => {
    const snapshot = makeConnection();
    findUniqueMock.mockResolvedValue(snapshot);
    const refreshed = makeConnection({ accessToken: "access-2" });
    transactionMock.mockImplementation(async (callback: (tx: unknown) => Promise<unknown>) => {
      await callback({ $executeRaw: executeRawMock });
      throw p2028(); // the commit fails
    });

    const result = await refreshConnectionToken(snapshot, vi.fn().mockResolvedValue(refreshed));

    expect(result).toBe(refreshed);
  });
});

describe("refreshConnectionToken — two instances refreshing the same connection", () => {
  const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

  it("refreshes ONCE: the second instance waits for the lock, then its re-read sees the first one's new tokens", async () => {
    // The mock serializes the transaction callbacks like the advisory lock does.
    let chain: Promise<unknown> = Promise.resolve();
    transactionMock.mockImplementation((callback: (tx: unknown) => Promise<unknown>) => {
      const run = chain.then(() => callback({ $executeRaw: executeRawMock }));
      chain = run.catch(() => undefined);
      return run;
    });

    // The "database": the first refresh writes new tokens that later reads see.
    let stored = makeConnection({ accessToken: "access-1", refreshToken: "refresh-1" });
    findUniqueMock.mockImplementation(async () => stored);
    // The first refresh is still in flight (holding the lock) until released.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const refresh = vi.fn(async () => {
      await gate;
      stored = makeConnection({ accessToken: "access-2", refreshToken: "refresh-2" });
      return stored;
    });

    // Both callers hold the SAME stale snapshot (two publishes, or a publish
    // plus the health sweep, loaded the row before either refreshed). They run
    // in different serverless instances, so each has its own single-flight map:
    // the reset between the calls stands in for the second instance. The second
    // call also starts a macro-task later: Vitest can hand a second dynamic
    // import of the mocked db module, made in the same tick, the real module.
    const snapshot = makeConnection({ accessToken: "access-1", refreshToken: "refresh-1" });
    const first = refreshConnectionToken(snapshot, refresh);
    await tick();
    resetRefreshLockStateForTests();
    const second = refreshConnectionToken(snapshot, refresh);
    await tick();

    // The second caller is parked behind the first's lock: no second refresh,
    // not even a second re-read yet.
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(findUniqueMock).toHaveBeenCalledTimes(1);

    release();
    const [a, b] = await Promise.all([first, second]);

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(a.accessToken).toBe("access-2");
    expect(b.accessToken).toBe("access-2");
    expect(b.refreshToken).toBe("refresh-2");
    // Both took the lock (two transactions, each with set_config + lock).
    expect(transactionMock).toHaveBeenCalledTimes(2);
    expect(executeRawMock).toHaveBeenCalledTimes(4);
  });
});

describe("refreshConnectionToken — step deadline", () => {
  it("refuses with PUBLISH_TIME_BUDGET_EXCEEDED, opening no transaction, with 4 s left", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-02T10:00:00Z"));
    const refresh = vi.fn();

    const error = await caught(
      refreshConnectionToken(makeConnection(), refresh, { deadline: Date.now() + 4_000 }),
    );

    expect(error?.code).toBe(PUBLISH_BUDGET_EXCEEDED_CODE);
    expect(transactionMock).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("refuses at the 5 s window edge (just under MIN_REQUEST_WINDOW_MS) and runs at exactly it", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-02T10:00:00Z"));
    findUniqueMock.mockResolvedValue(makeConnection());
    const refresh = vi.fn().mockResolvedValue(makeConnection());

    const refused = await caught(
      refreshConnectionToken(makeConnection(), refresh, {
        deadline: Date.now() + MIN_REQUEST_WINDOW_MS - 1,
      }),
    );
    expect(refused?.code).toBe(PUBLISH_BUDGET_EXCEEDED_CODE);

    await refreshConnectionToken(makeConnection(), refresh, {
      deadline: Date.now() + MIN_REQUEST_WINDOW_MS,
    });
    expect(transactionMock).toHaveBeenCalledTimes(1);
  });
});

// 2026-11-01 scale audit (jobs, token refresh), fix round 1 (C1): the lock
// transaction pins one pooled connection for the whole refresh, while the
// re-read, the refresher's token write and the guarded flag each need a SECOND
// connection from the same per-instance pool. Unbounded, the lock transactions
// of one instance can take the whole pool and starve their own queries (and the
// publish claim/finalize queries). So the lock transactions are capped per
// process (a semaphore sized from DATABASE_URL's connection_limit), and
// concurrent callers for one connection share a single flight.
describe("refreshLockCap (the per-process cap on lock transactions)", () => {
  const url = (query: string) => `postgresql://user:pass@host.example/db${query}`;

  it("never exceeds REFRESH_LOCK_MAX_CONCURRENCY (2)", () => {
    expect(REFRESH_LOCK_MAX_CONCURRENCY).toBe(2);
  });

  it.each([
    ["undefined DATABASE_URL", undefined, 2],
    ["an empty DATABASE_URL", "", 2],
    ["no connection_limit parameter (Prisma's default pool is at least 3)", url("?sslmode=require"), 2],
    ["no query string at all", url(""), 2],
    ["connection_limit=5 (production)", url("?connection_limit=5"), 2],
    [
      "the production query string",
      url("?sslmode=require&connection_limit=5&pool_timeout=20&connect_timeout=15"),
      2,
    ],
    ["connection_limit=3 (the documented floor)", url("?connection_limit=3"), 2],
    ["connection_limit=2: one connection stays free for the queries", url("?connection_limit=2"), 1],
    ["connection_limit=1: no lock transaction at all", url("?connection_limit=1"), 0],
    ["connection_limit=1 among other parameters", url("?sslmode=require&connection_limit=1&pool_timeout=20"), 0],
    ["a connection_limit that is not a number", url("?connection_limit=abc"), 2],
    ["an empty connection_limit", url("?connection_limit="), 2],
    ["connection_limit=0", url("?connection_limit=0"), 2],
    ["a negative connection_limit", url("?connection_limit=-1"), 2],
    ["a fractional connection_limit", url("?connection_limit=2.5"), 2],
    ["garbage that is not a URL", "not a url", 2],
  ] as const)("%s -> %i", (_label, databaseUrl, expected) => {
    expect(refreshLockCap(databaseUrl)).toBe(expected);
  });

  it("is read from DATABASE_URL at call time", async () => {
    vi.stubEnv("DATABASE_URL", url("?connection_limit=1"));
    findUniqueMock.mockResolvedValue(makeConnection());

    await refreshConnectionToken(makeConnection(), vi.fn().mockResolvedValue(makeConnection()));

    expect(transactionMock).not.toHaveBeenCalled();
  });
});

describe("refreshConnectionToken — at most REFRESH_LOCK_MAX_CONCURRENCY lock transactions per process", () => {
  const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

  /** `$transaction` calls that start at once but whose callback only runs when released. */
  function gatedTransactions() {
    const releases: Array<() => void> = [];
    transactionMock.mockImplementation(
      (callback: (tx: unknown) => Promise<unknown>) =>
        new Promise((resolve, reject) => {
          releases.push(() => callback({ $executeRaw: executeRawMock }).then(resolve, reject));
        }),
    );
    return releases;
  }

  beforeEach(() => {
    // Every connection id is stored with the tokens its snapshot carries.
    findUniqueMock.mockImplementation(async ({ where }: { where: { id: string } }) =>
      makeConnection({ id: where.id }),
    );
  });

  const call = (id: string, refresh = vi.fn().mockResolvedValue(makeConnection())) =>
    refreshConnectionToken(makeConnection({ id }), refresh);

  it("a third concurrent caller does not start a $transaction until one finishes, and holds no connection while it waits", async () => {
    const releases = gatedTransactions();

    const a = call("conn-a");
    await tick();
    const b = call("conn-b");
    await tick();
    const c = call("conn-c");
    await tick();

    // Two lock transactions are open; the third caller waits in memory.
    expect(transactionMock).toHaveBeenCalledTimes(REFRESH_LOCK_MAX_CONCURRENCY);
    expect(executeRawMock).not.toHaveBeenCalled();

    releases[0]();
    await a;
    await tick();

    expect(transactionMock).toHaveBeenCalledTimes(3);

    releases[1]();
    releases[2]();
    await Promise.all([b, c]);
    expect(findUniqueMock).toHaveBeenCalledTimes(3);
  });

  it("frees the slot when a refresh fails", async () => {
    const releases = gatedTransactions();
    const failure = new Error("TikTok is down");

    const a = call("conn-a", vi.fn().mockRejectedValue(failure));
    await tick();
    const b = call("conn-b");
    await tick();
    const c = call("conn-c");
    await tick();
    expect(transactionMock).toHaveBeenCalledTimes(2);

    releases[0]();
    await expect(a).rejects.toBe(failure);
    await tick();

    expect(transactionMock).toHaveBeenCalledTimes(3);
    releases[1]();
    releases[2]();
    await Promise.all([b, c]);
  });

  it("connection_limit=2 allows ONE lock transaction at a time", async () => {
    vi.stubEnv("DATABASE_URL", "postgresql://user:pass@host.example/db?connection_limit=2");
    const releases = gatedTransactions();

    const a = call("conn-a");
    await tick();
    const b = call("conn-b");
    await tick();

    expect(transactionMock).toHaveBeenCalledTimes(1);

    releases[0]();
    await a;
    await tick();
    expect(transactionMock).toHaveBeenCalledTimes(2);
    releases[1]();
    await b;
  });

  it("a waiter past REFRESH_LOCK_WAIT_MS throws CONNECTION_REFRESH_BUSY (503) and never starts a $transaction", async () => {
    vi.useFakeTimers();
    const releases = gatedTransactions();
    const refreshC = vi.fn();

    const a = call("conn-a");
    await vi.advanceTimersByTimeAsync(0);
    const b = call("conn-b");
    await vi.advanceTimersByTimeAsync(0);
    const c = call("conn-c", refreshC);
    const cOutcome = c.then(
      () => null,
      (e: unknown) => e as CodedError,
    );
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(REFRESH_LOCK_WAIT_MS - 1);
    // Not yet: still waiting.
    expect(transactionMock).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(1);
    const error = await cOutcome;

    expect(error?.code).toBe(CONNECTION_REFRESH_BUSY_CODE);
    expect(error?.status).toBe(503);
    expect(transactionMock).toHaveBeenCalledTimes(2);
    expect(refreshC).not.toHaveBeenCalled();

    // The timed-out waiter left the queue: releasing a slot starts nobody.
    releases[0]();
    await a;
    await vi.advanceTimersByTimeAsync(0);
    expect(transactionMock).toHaveBeenCalledTimes(2);
    releases[1]();
    await b;
  });

  it("a waiter that gets its slot in time leaves no timer behind", async () => {
    vi.useFakeTimers();
    const releases = gatedTransactions();

    const a = call("conn-a");
    await vi.advanceTimersByTimeAsync(0);
    const b = call("conn-b");
    await vi.advanceTimersByTimeAsync(0);
    const c = call("conn-c");
    await vi.advanceTimersByTimeAsync(0);

    releases[0]();
    await a;
    await vi.advanceTimersByTimeAsync(0);
    releases[1]();
    releases[2]();
    await Promise.all([b, c]);

    expect(vi.getTimerCount()).toBe(0);
  });

  it("re-checks the step budget after waiting for a slot: PUBLISH_TIME_BUDGET_EXCEEDED, no $transaction for it", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-02T10:00:00Z"));
    const releases = gatedTransactions();

    const a = call("conn-a");
    await vi.advanceTimersByTimeAsync(0);
    const b = call("conn-b");
    await vi.advanceTimersByTimeAsync(0);
    // 8 s left when it starts waiting; a slot only frees after 5 s, leaving 3 s.
    const c = refreshConnectionToken(makeConnection({ id: "conn-c" }), vi.fn(), {
      deadline: Date.now() + 8_000,
    });
    const cOutcome = c.then(
      () => null,
      (e: unknown) => e as CodedError,
    );
    await vi.advanceTimersByTimeAsync(5_000);
    releases[0]();
    await a;
    const error = await cOutcome;

    expect(error?.code).toBe(PUBLISH_BUDGET_EXCEEDED_CODE);
    expect(transactionMock).toHaveBeenCalledTimes(2);
    releases[1]();
    await b;
  });
});

describe("refreshConnectionToken — single-flight per connection in one process", () => {
  it("two simultaneous callers for the same id make ONE $transaction and ONE refresh, and both get the same row", async () => {
    findUniqueMock.mockResolvedValue(makeConnection());
    const refreshed = makeConnection({ accessToken: "access-2" });
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const refresh = vi.fn(async () => {
      await gate;
      return refreshed;
    });

    const first = refreshConnectionToken(makeConnection(), refresh);
    const second = refreshConnectionToken(makeConnection(), refresh);
    finish();
    const [a, b] = await Promise.all([first, second]);

    expect(transactionMock).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(a).toBe(refreshed);
    expect(b).toBe(refreshed);
  });

  it("shares a failure too, and every caller sees the same error", async () => {
    findUniqueMock.mockResolvedValue(makeConnection());
    const failure = Object.assign(new Error("expired"), { code: "TIKTOK_RECONNECT_REQUIRED" });
    const refresh = vi.fn().mockRejectedValue(failure);

    const results = await Promise.allSettled([
      refreshConnectionToken(makeConnection(), refresh),
      refreshConnectionToken(makeConnection(), refresh),
      refreshConnectionToken(makeConnection(), refresh),
    ]);

    expect(transactionMock).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledTimes(1);
    for (const result of results) {
      expect(result).toEqual({ status: "rejected", reason: failure });
    }
  });

  it("clears the entry on settle: a later caller refreshes again (success and failure alike)", async () => {
    findUniqueMock.mockResolvedValue(makeConnection());
    const failure = new Error("boom");

    await refreshConnectionToken(makeConnection(), vi.fn().mockResolvedValue(makeConnection()));
    await expect(
      refreshConnectionToken(makeConnection(), vi.fn().mockRejectedValue(failure)),
    ).rejects.toBe(failure);
    const refresh = vi.fn().mockResolvedValue(makeConnection({ accessToken: "access-3" }));
    const result = await refreshConnectionToken(makeConnection(), refresh);

    expect(transactionMock).toHaveBeenCalledTimes(3);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(result.accessToken).toBe("access-3");
  });

  it("does not share across different connection ids", async () => {
    findUniqueMock.mockImplementation(async ({ where }: { where: { id: string } }) =>
      makeConnection({ id: where.id }),
    );
    const refreshA = vi.fn().mockResolvedValue(makeConnection({ id: "conn-a", accessToken: "a-2" }));
    const refreshB = vi.fn().mockResolvedValue(makeConnection({ id: "conn-b", accessToken: "b-2" }));

    // The second starts a macro-task later (Vitest can hand a second dynamic
    // import of the mocked db module, made in the same tick, the real module).
    const first = refreshConnectionToken(makeConnection({ id: "conn-a" }), refreshA);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const second = refreshConnectionToken(makeConnection({ id: "conn-b" }), refreshB);
    const [a, b] = await Promise.all([first, second]);

    expect(transactionMock).toHaveBeenCalledTimes(2);
    expect(refreshA).toHaveBeenCalledTimes(1);
    expect(refreshB).toHaveBeenCalledTimes(1);
    expect(a.accessToken).toBe("a-2");
    expect(b.accessToken).toBe("b-2");
  });

  it("a caller with an exhausted budget neither joins nor starts a flight", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-02T10:00:00Z"));
    findUniqueMock.mockResolvedValue(makeConnection());
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const leader = refreshConnectionToken(
      makeConnection(),
      vi.fn(async () => {
        await gate;
        return makeConnection();
      }),
    );

    const error = await caught(
      refreshConnectionToken(makeConnection(), vi.fn(), { deadline: Date.now() + 1_000 }),
    );

    expect(error?.code).toBe(PUBLISH_BUDGET_EXCEEDED_CODE);
    finish();
    await leader;
    expect(transactionMock).toHaveBeenCalledTimes(1);
  });
});

// 2026-11-02 scale audit (jobs, token refresh): the waits the helper adds in front
// of a refresh were bounded by REFRESH_LOCK_WAIT_MS (20 s) alone, not by the
// caller's step budget, so a caller 12 s from its deadline could sit in the queue
// for 20 s, and a single-flight follower could wait out the whole of a leader's
// flight. Both waits now end by the caller's OWN deadline (less the 5 s a request
// needs), with PUBLISH_TIME_BUDGET_EXCEEDED - the code that means "nothing was
// sent, retry" - instead of BUSY when it is the budget that ran out.
const BUDGET_NOW = new Date("2026-11-02T10:00:00Z");

/** A promise's outcome as it settles, so a test can look at WHEN it settled. */
function track(promise: Promise<unknown>) {
  const state: { settled: boolean; error: CodedError | null; value?: unknown } = {
    settled: false,
    error: null,
  };
  void promise.then(
    (value) => {
      state.settled = true;
      state.value = value;
    },
    (e: unknown) => {
      state.settled = true;
      state.error = e as CodedError;
    },
  );
  return state;
}

describe("refreshConnectionToken — the wait for a lock slot is bounded by the caller's budget", () => {
  /** `$transaction` calls that start at once but whose callback only runs when released. */
  function gatedTransactions() {
    const releases: Array<() => void> = [];
    transactionMock.mockImplementation(
      (callback: (tx: unknown) => Promise<unknown>) =>
        new Promise((resolve, reject) => {
          releases.push(() => callback({ $executeRaw: executeRawMock }).then(resolve, reject));
        }),
    );
    return releases;
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(BUDGET_NOW);
    findUniqueMock.mockImplementation(async ({ where }: { where: { id: string } }) =>
      makeConnection({ id: where.id }),
    );
  });

  const callWith = (id: string, opts?: { deadline?: number }, refresh = vi.fn().mockResolvedValue(makeConnection())) =>
    refreshConnectionToken(makeConnection({ id }), refresh, opts);

  /** Two callers hold both lock slots (cap 2); `finish` lets them go. */
  async function holdBothSlots() {
    const releases = gatedTransactions();
    const a = callWith("conn-a");
    await vi.advanceTimersByTimeAsync(0);
    const b = callWith("conn-b");
    await vi.advanceTimersByTimeAsync(0);
    expect(transactionMock).toHaveBeenCalledTimes(REFRESH_LOCK_MAX_CONCURRENCY);
    return {
      releases,
      finish: async () => {
        releases[0]();
        releases[1]();
        await Promise.all([a, b]);
      },
    };
  }

  it("with 12 s left and both slots held, gives up with PUBLISH_TIME_BUDGET_EXCEEDED at 7 s (deadline - 5 s), not at 20 s", async () => {
    const { finish } = await holdBothSlots();
    const refresh = vi.fn();
    const c = track(callWith("conn-c", { deadline: Date.now() + 12_000 }, refresh));

    await vi.advanceTimersByTimeAsync(6_999);
    expect(c.settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    expect(c.settled).toBe(true);
    expect(c.error?.code).toBe(PUBLISH_BUDGET_EXCEEDED_CODE);
    expect(refresh).not.toHaveBeenCalled();
    expect(transactionMock).toHaveBeenCalledTimes(REFRESH_LOCK_MAX_CONCURRENCY);

    await finish();
  });

  it("the timed-out waiter leaves no timer and no queue entry behind: freeing a slot starts nobody", async () => {
    const { finish } = await holdBothSlots();
    const c = track(callWith("conn-c", { deadline: Date.now() + 12_000 }, vi.fn()));

    await vi.advanceTimersByTimeAsync(7_000);
    expect(c.error?.code).toBe(PUBLISH_BUDGET_EXCEEDED_CODE);
    expect(vi.getTimerCount()).toBe(0);

    await finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(transactionMock).toHaveBeenCalledTimes(REFRESH_LOCK_MAX_CONCURRENCY);
  });

  it("with no deadline, still gives up with CONNECTION_REFRESH_BUSY (503) at 20 s", async () => {
    const { finish } = await holdBothSlots();
    const c = track(callWith("conn-c", undefined, vi.fn()));

    await vi.advanceTimersByTimeAsync(REFRESH_LOCK_WAIT_MS - 1);
    expect(c.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    expect(c.error?.code).toBe(CONNECTION_REFRESH_BUSY_CODE);
    expect(c.error?.status).toBe(503);

    await finish();
  });

  it("with a deadline far beyond 20 s, the 20 s bound wins: CONNECTION_REFRESH_BUSY at 20 s", async () => {
    const { finish } = await holdBothSlots();
    const c = track(callWith("conn-c", { deadline: Date.now() + 120_000 }, vi.fn()));

    await vi.advanceTimersByTimeAsync(REFRESH_LOCK_WAIT_MS - 1);
    expect(c.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    expect(c.error?.code).toBe(CONNECTION_REFRESH_BUSY_CODE);

    await finish();
  });

  it("where the budget and the 20 s bound tie (25 s left), the 20 s bound is the one reported: BUSY", async () => {
    const { finish } = await holdBothSlots();
    const c = track(
      callWith("conn-c", { deadline: Date.now() + REFRESH_LOCK_WAIT_MS + MIN_REQUEST_WINDOW_MS }, vi.fn()),
    );

    await vi.advanceTimersByTimeAsync(REFRESH_LOCK_WAIT_MS);

    expect(c.error?.code).toBe(CONNECTION_REFRESH_BUSY_CODE);

    await finish();
  });

  it("with 4 s left it rejects immediately (the budget check), starting no timer", async () => {
    const { finish } = await holdBothSlots();
    const timersBefore = vi.getTimerCount();

    const error = await caught(callWith("conn-c", { deadline: Date.now() + 4_000 }, vi.fn()));

    expect(error?.code).toBe(PUBLISH_BUDGET_EXCEEDED_CODE);
    expect(vi.getTimerCount()).toBe(timersBefore);

    await finish();
  });

  it("with exactly 5 s left and both slots held there is no wait to give: rejects immediately, starting no timer", async () => {
    const { finish } = await holdBothSlots();
    const timersBefore = vi.getTimerCount();
    const c = track(callWith("conn-c", { deadline: Date.now() + MIN_REQUEST_WINDOW_MS }, vi.fn()));

    await vi.advanceTimersByTimeAsync(0);

    expect(c.settled).toBe(true);
    expect(c.error?.code).toBe(PUBLISH_BUDGET_EXCEEDED_CODE);
    expect(vi.getTimerCount()).toBe(timersBefore);
    expect(transactionMock).toHaveBeenCalledTimes(REFRESH_LOCK_MAX_CONCURRENCY);

    await finish();
  });

  it("with exactly 5 s left and a FREE slot it still runs (nothing to wait for)", async () => {
    const refresh = vi.fn().mockResolvedValue(makeConnection());

    await callWith("conn-a", { deadline: Date.now() + MIN_REQUEST_WINDOW_MS }, refresh);

    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("a slot that frees up inside the clamped wait is used, and leaves no timer behind", async () => {
    const { releases } = await holdBothSlots();
    const refreshC = vi.fn().mockResolvedValue(makeConnection({ id: "conn-c", accessToken: "c-2" }));
    const c = callWith("conn-c", { deadline: Date.now() + 30_000 }, refreshC);
    await vi.advanceTimersByTimeAsync(3_000);

    // Frees one slot; the waiter takes it and opens its own transaction.
    releases[0]();
    await vi.advanceTimersByTimeAsync(0);
    expect(transactionMock).toHaveBeenCalledTimes(3);
    releases[1]();
    releases[2]();
    await c;
    await vi.advanceTimersByTimeAsync(0);

    expect(refreshC).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("refreshConnectionToken — a single-flight follower is bounded by its OWN budget", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(BUDGET_NOW);
    findUniqueMock.mockResolvedValue(makeConnection());
  });

  /** A leader whose refresh stays in flight until `finish` / `fail` is called. */
  function startLeader(opts?: { deadline?: number }) {
    let finish!: (row: SocialConnection) => void;
    let fail!: (error: Error) => void;
    const gate = new Promise<SocialConnection>((resolve, reject) => {
      finish = resolve;
      fail = reject;
    });
    const refresh = vi.fn(() => gate);
    const promise = refreshConnectionToken(makeConnection(), refresh, opts);
    return { refresh, promise, finish, fail, state: track(promise) };
  }

  it("a follower with 8 s left and a leader that never settles rejects PUBLISH_TIME_BUDGET_EXCEEDED by 3 s, and the leader keeps running", async () => {
    const leader = startLeader();
    await vi.advanceTimersByTimeAsync(0);
    const followerRefresh = vi.fn();
    const follower = track(
      refreshConnectionToken(makeConnection(), followerRefresh, { deadline: Date.now() + 8_000 }),
    );

    await vi.advanceTimersByTimeAsync(2_999);
    expect(follower.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    expect(follower.settled).toBe(true);
    expect(follower.error?.code).toBe(PUBLISH_BUDGET_EXCEEDED_CODE);
    // The follower never refreshes, never opens a transaction, and does not cancel the leader.
    expect(followerRefresh).not.toHaveBeenCalled();
    expect(transactionMock).toHaveBeenCalledTimes(1);
    expect(leader.state.settled).toBe(false);
    expect(leader.refresh).toHaveBeenCalledTimes(1);

    // The leader finishes later and still resolves its own row.
    const row = makeConnection({ accessToken: "access-2" });
    leader.finish(row);
    await expect(leader.promise).resolves.toBe(row);
  });

  it("the leader failing after a follower timed out is not an unhandled rejection, and no timer is left", async () => {
    const leader = startLeader();
    await vi.advanceTimersByTimeAsync(0);
    const follower = track(
      refreshConnectionToken(makeConnection(), vi.fn(), { deadline: Date.now() + 8_000 }),
    );
    await vi.advanceTimersByTimeAsync(3_000);
    expect(follower.error?.code).toBe(PUBLISH_BUDGET_EXCEEDED_CODE);

    const failure = new Error("TikTok is down");
    leader.fail(failure);
    await expect(leader.promise).rejects.toBe(failure);
    await vi.advanceTimersByTimeAsync(0);

    expect(vi.getTimerCount()).toBe(0);
  });

  it("a follower with budget left gets the leader's row when it finishes in time, and leaves no timer behind", async () => {
    const leader = startLeader();
    await vi.advanceTimersByTimeAsync(0);
    const followerRefresh = vi.fn();
    const follower = refreshConnectionToken(makeConnection(), followerRefresh, {
      deadline: Date.now() + 60_000,
    });

    await vi.advanceTimersByTimeAsync(10_000);
    const row = makeConnection({ accessToken: "access-2" });
    leader.finish(row);

    await expect(follower).resolves.toBe(row);
    expect(followerRefresh).not.toHaveBeenCalled();
    expect(transactionMock).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a follower with exactly 5 s left has no wait to give: rejects at once, starting no timer", async () => {
    const leader = startLeader();
    await vi.advanceTimersByTimeAsync(0);
    const timersBefore = vi.getTimerCount();

    const follower = track(
      refreshConnectionToken(makeConnection(), vi.fn(), { deadline: Date.now() + MIN_REQUEST_WINDOW_MS }),
    );
    await vi.advanceTimersByTimeAsync(0);

    expect(follower.error?.code).toBe(PUBLISH_BUDGET_EXCEEDED_CODE);
    expect(vi.getTimerCount()).toBe(timersBefore);
    leader.finish(makeConnection());
    await leader.promise;
  });

  it("a follower with no deadline still waits for the leader however long it takes", async () => {
    const leader = startLeader();
    await vi.advanceTimersByTimeAsync(0);
    const follower = track(refreshConnectionToken(makeConnection(), vi.fn()));

    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(follower.settled).toBe(false);

    const row = makeConnection({ accessToken: "access-2" });
    leader.finish(row);
    await leader.promise;
    await vi.advanceTimersByTimeAsync(0);

    expect(follower.value).toBe(row);
  });

  it("any other leader error is shared with the follower, which starts no flight of its own", async () => {
    const leader = startLeader();
    await vi.advanceTimersByTimeAsync(0);
    const followerRefresh = vi.fn();
    const follower = track(
      refreshConnectionToken(makeConnection(), followerRefresh, { deadline: Date.now() + 60_000 }),
    );

    const failure = Object.assign(new Error("expired"), { code: "TIKTOK_RECONNECT_REQUIRED" });
    leader.fail(failure);
    await vi.advanceTimersByTimeAsync(0);

    expect(follower.error).toBe(failure);
    expect(followerRefresh).not.toHaveBeenCalled();
    expect(transactionMock).toHaveBeenCalledTimes(1);
  });

  it("the leader rejects PUBLISH_TIME_BUDGET_EXCEEDED while a follower has 60 s left: the follower starts its OWN flight (refresh called a second time) and resolves its row", async () => {
    const leader = startLeader();
    await vi.advanceTimersByTimeAsync(0);
    const ownRow = makeConnection({ accessToken: "access-own" });
    const followerRefresh = vi.fn().mockResolvedValue(ownRow);
    const follower = refreshConnectionToken(makeConnection(), followerRefresh, {
      deadline: Date.now() + 60_000,
    });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(followerRefresh).not.toHaveBeenCalled();

    leader.fail(publishBudgetExceededError());
    await expect(leader.promise).rejects.toMatchObject({ code: PUBLISH_BUDGET_EXCEEDED_CODE });

    await expect(follower).resolves.toBe(ownRow);
    expect(leader.refresh).toHaveBeenCalledTimes(1);
    expect(followerRefresh).toHaveBeenCalledTimes(1);
    expect(transactionMock).toHaveBeenCalledTimes(2);
  });

  it("two followers of a leader that ran out of budget share ONE new flight: refresh runs twice in all, not three times", async () => {
    const leader = startLeader();
    await vi.advanceTimersByTimeAsync(0);
    const ownRow = makeConnection({ accessToken: "access-own" });
    let finishOwn!: () => void;
    const ownGate = new Promise<void>((resolve) => {
      finishOwn = resolve;
    });
    const firstRefresh = vi.fn(async () => {
      await ownGate;
      return ownRow;
    });
    const secondRefresh = vi.fn().mockResolvedValue(makeConnection({ accessToken: "access-other" }));
    const first = refreshConnectionToken(makeConnection(), firstRefresh, { deadline: Date.now() + 60_000 });
    const second = refreshConnectionToken(makeConnection(), secondRefresh, { deadline: Date.now() + 60_000 });

    leader.fail(publishBudgetExceededError());
    await vi.advanceTimersByTimeAsync(0);
    finishOwn();
    const [a, b] = await Promise.all([first, second]);

    expect(a).toBe(ownRow);
    expect(b).toBe(ownRow);
    expect(firstRefresh).toHaveBeenCalledTimes(1);
    expect(secondRefresh).not.toHaveBeenCalled();
    expect(transactionMock).toHaveBeenCalledTimes(2);
  });

  it("a follower retries only ONCE: if its own flight also runs out of budget it rejects, with no third flight", async () => {
    const leader = startLeader();
    await vi.advanceTimersByTimeAsync(0);
    const followerRefresh = vi.fn().mockRejectedValue(publishBudgetExceededError());
    const follower = track(
      refreshConnectionToken(makeConnection(), followerRefresh, { deadline: Date.now() + 60_000 }),
    );

    leader.fail(publishBudgetExceededError());
    await vi.advanceTimersByTimeAsync(0);

    expect(follower.error?.code).toBe(PUBLISH_BUDGET_EXCEEDED_CODE);
    expect(followerRefresh).toHaveBeenCalledTimes(1);
    expect(transactionMock).toHaveBeenCalledTimes(2);
  });

  it("a follower whose own wait already ended is not revived by the leader giving up later", async () => {
    const leader = startLeader();
    await vi.advanceTimersByTimeAsync(0);
    const followerRefresh = vi.fn();
    const follower = track(
      refreshConnectionToken(makeConnection(), followerRefresh, { deadline: Date.now() + 9_000 }),
    );

    // The follower's own wait ends at 4 s; the leader gives up only afterwards.
    await vi.advanceTimersByTimeAsync(4_000);
    expect(follower.error?.code).toBe(PUBLISH_BUDGET_EXCEEDED_CODE);
    leader.fail(publishBudgetExceededError());
    await vi.advanceTimersByTimeAsync(0);

    expect(followerRefresh).not.toHaveBeenCalled();
    expect(transactionMock).toHaveBeenCalledTimes(1);
  });

  it("a caller arriving after the leader gave up joins the follower's new flight (the leader's entry was cleared first)", async () => {
    const leader = startLeader();
    await vi.advanceTimersByTimeAsync(0);
    let finishOwn!: () => void;
    const ownGate = new Promise<void>((resolve) => {
      finishOwn = resolve;
    });
    const ownRow = makeConnection({ accessToken: "access-own" });
    const followerRefresh = vi.fn(async () => {
      await ownGate;
      return ownRow;
    });
    const follower = refreshConnectionToken(makeConnection(), followerRefresh, {
      deadline: Date.now() + 60_000,
    });

    leader.fail(publishBudgetExceededError());
    await vi.advanceTimersByTimeAsync(0);
    const lateRefresh = vi.fn();
    const late = refreshConnectionToken(makeConnection(), lateRefresh);
    finishOwn();

    await expect(Promise.all([follower, late])).resolves.toEqual([ownRow, ownRow]);
    expect(lateRefresh).not.toHaveBeenCalled();
    expect(followerRefresh).toHaveBeenCalledTimes(1);
  });
});

describe("refreshConnectionToken — pool timeout (P2024)", () => {
  const poolTimeout = () =>
    Object.assign(
      new Error("Timed out fetching a new connection from the connection pool."),
      { code: "P2024" },
    );

  it("before the refresh started (the lock statements): CONNECTION_REFRESH_BUSY, nothing was sent", async () => {
    executeRawMock.mockRejectedValueOnce(poolTimeout());
    const refresh = vi.fn();

    const error = await caught(refreshConnectionToken(makeConnection(), refresh));

    expect(error?.code).toBe(CONNECTION_REFRESH_BUSY_CODE);
    expect(error?.status).toBe(503);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("before the refresh started (the re-read waiting for a second connection): CONNECTION_REFRESH_BUSY", async () => {
    findUniqueMock.mockRejectedValue(poolTimeout());
    const refresh = vi.fn();

    const error = await caught(refreshConnectionToken(makeConnection(), refresh));

    expect(error?.code).toBe(CONNECTION_REFRESH_BUSY_CODE);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("when the transaction itself cannot get a connection: CONNECTION_REFRESH_BUSY", async () => {
    transactionMock.mockRejectedValueOnce(poolTimeout());

    const error = await caught(refreshConnectionToken(makeConnection(), vi.fn()));

    expect(error?.code).toBe(CONNECTION_REFRESH_BUSY_CODE);
  });

  it("after the refresh started: rethrown as is (a request may have been sent)", async () => {
    findUniqueMock.mockResolvedValue(makeConnection());
    const failure = poolTimeout();

    const error = await caught(
      refreshConnectionToken(makeConnection(), vi.fn().mockRejectedValue(failure)),
    );

    expect(error).toBe(failure);
    expect(error?.code).toBe("P2024");
  });
});

describe("refreshConnectionToken — connection_limit=1 (no lock transaction)", () => {
  const LIMIT_ONE = "postgresql://user:pass@host.example/db?sslmode=require&connection_limit=1";

  beforeEach(() => {
    vi.stubEnv("DATABASE_URL", LIMIT_ONE);
    vi.spyOn(logger, "warn").mockImplementation(() => {});
  });

  it("opens no $transaction and takes no lock, but still re-reads and refreshes", async () => {
    const stored = makeConnection();
    findUniqueMock.mockResolvedValue(stored);
    const refreshed = makeConnection({ accessToken: "access-2" });
    const refresh = vi.fn().mockResolvedValue(refreshed);

    const result = await refreshConnectionToken(makeConnection(), refresh);

    expect(transactionMock).not.toHaveBeenCalled();
    expect(executeRawMock).not.toHaveBeenCalled();
    expect(findUniqueMock).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledWith(stored);
    expect(result).toBe(refreshed);
  });

  it("still returns the stored row when the tokens changed, and refuses a gone or flagged row", async () => {
    const stored = makeConnection({ accessToken: "access-2" });
    findUniqueMock.mockResolvedValueOnce(stored);
    const refresh = vi.fn();
    await expect(refreshConnectionToken(makeConnection(), refresh)).resolves.toBe(stored);
    expect(refresh).not.toHaveBeenCalled();

    findUniqueMock.mockResolvedValueOnce(null);
    expect((await caught(refreshConnectionToken(makeConnection(), refresh)))?.code).toBe("CONNECTION_GONE");
    findUniqueMock.mockResolvedValueOnce(makeConnection({ needsReconnect: true }));
    expect((await caught(refreshConnectionToken(makeConnection(), refresh)))?.code).toBe(
      "RECONNECT_REQUIRED",
    );
  });

  it("still turns a superseded refresh into the stored row", async () => {
    const afterSupersede = makeConnection({ accessToken: "access-9" });
    findUniqueMock.mockResolvedValueOnce(makeConnection()).mockResolvedValueOnce(afterSupersede);

    const result = await refreshConnectionToken(
      makeConnection(),
      vi.fn().mockRejectedValue(tokenRefreshSupersededError()),
    );

    expect(result).toBe(afterSupersede);
  });

  it("maps a pool timeout before the refresh to BUSY here too", async () => {
    findUniqueMock.mockRejectedValue(
      Object.assign(new Error("Timed out fetching a new connection"), { code: "P2024" }),
    );

    const error = await caught(refreshConnectionToken(makeConnection(), vi.fn()));

    expect(error?.code).toBe(CONNECTION_REFRESH_BUSY_CODE);
  });

  it("logs the warning ONCE per process, not once per refresh", async () => {
    findUniqueMock.mockResolvedValue(makeConnection());

    await refreshConnectionToken(makeConnection(), vi.fn().mockResolvedValue(makeConnection()));
    await refreshConnectionToken(makeConnection(), vi.fn().mockResolvedValue(makeConnection()));
    await refreshConnectionToken(makeConnection(), vi.fn().mockResolvedValue(makeConnection()));

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(vi.mocked(logger.warn).mock.calls[0][0]).toContain("connection_limit=1");
    expect(vi.mocked(logger.warn).mock.calls[0][0]).toContain("connection_limit >= 3");
  });

  it("does not log it when the lock is in use", async () => {
    vi.stubEnv("DATABASE_URL", "postgresql://user:pass@host.example/db?connection_limit=5");
    findUniqueMock.mockResolvedValue(makeConnection());

    await refreshConnectionToken(makeConnection(), vi.fn().mockResolvedValue(makeConnection()));

    expect(logger.warn).not.toHaveBeenCalled();
    expect(transactionMock).toHaveBeenCalledTimes(1);
  });

  it("concurrent callers for one connection still share a single flight", async () => {
    findUniqueMock.mockResolvedValue(makeConnection());
    const refresh = vi.fn().mockResolvedValue(makeConnection({ accessToken: "access-2" }));

    const [a, b] = await Promise.all([
      refreshConnectionToken(makeConnection(), refresh),
      refreshConnectionToken(makeConnection(), refresh),
    ]);

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
  });
});
