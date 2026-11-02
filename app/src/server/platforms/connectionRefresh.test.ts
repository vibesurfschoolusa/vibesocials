import type { SocialConnection } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { tokenRefreshSupersededError } from "@/server/platforms/connectionHealth";
import {
  CONNECTION_GONE_CODE,
  CONNECTION_REFRESH_BUSY_CODE,
  CONNECTION_RECONNECT_REQUIRED_CODE,
  REFRESH_LOCK_NAMESPACE,
  REFRESH_LOCK_WAIT_MS,
  REFRESH_TX_MAX_WAIT_MS,
  REFRESH_TX_TIMEOUT_MS,
  refreshConnectionToken,
} from "@/server/platforms/connectionRefresh";
import {
  MIN_REQUEST_WINDOW_MS,
  PUBLISH_BUDGET_EXCEEDED_CODE,
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

describe("refreshConnectionToken — two concurrent callers", () => {
  const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

  it("refreshes ONCE: the second caller waits for the lock, then its re-read sees the first caller's new tokens", async () => {
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
    // plus the health sweep, loaded the row before either refreshed). The
    // second starts a macro-task later: Vitest can hand a second dynamic import
    // of the mocked db module, made in the same tick, the real module.
    const snapshot = makeConnection({ accessToken: "access-1", refreshToken: "refresh-1" });
    const first = refreshConnectionToken(snapshot, refresh);
    await tick();
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
