import type { Platform } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Handler-level tests for the connection-health pipeline (2026-11-01 scale
// audit, jobs, token refresh): the daily cron only PAGES connection ids and fans
// them out as `connection/refresh.requested` events; `refresh-connection`
// refreshes one connection under the per-connection lock and emails the owners
// only when THIS run flagged it. vi.mock is hoisted above the imports: no
// database, platform API, Resend or Inngest is reached.
const {
  findManyMock,
  findUniqueMock,
  workspaceFindUniqueMock,
  membersFindManyMock,
  getPlatformClientMock,
  refreshConnectionTokenMock,
  sendEmailMock,
  syncPageMock,
} = vi.hoisted(() => ({
  findManyMock: vi.fn(),
  findUniqueMock: vi.fn(),
  workspaceFindUniqueMock: vi.fn(),
  membersFindManyMock: vi.fn(),
  getPlatformClientMock: vi.fn(),
  refreshConnectionTokenMock: vi.fn(),
  sendEmailMock: vi.fn(),
  syncPageMock: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    socialConnection: { findMany: findManyMock, findUnique: findUniqueMock },
    workspace: { findUnique: workspaceFindUniqueMock },
    workspaceMember: { findMany: membersFindManyMock },
  },
}));
vi.mock("@/server/platforms", () => ({ getPlatformClient: getPlatformClientMock }));
// The lock helper has its own suite (connectionRefresh.test.ts); only the
// function is replaced, its error codes stay real.
vi.mock("@/server/platforms/connectionRefresh", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/platforms/connectionRefresh")>()),
  refreshConnectionToken: refreshConnectionTokenMock,
}));
// Only the transport is replaced; EmailRetryableError / isRetryableEmailError stay real.
vi.mock("@/server/notifications/email", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/notifications/email")>()),
  sendEmail: sendEmailMock,
}));
// The page logic has its own suite (youtubeMetricsSync.test.ts); the handler's
// paging loop is what is under test here.
vi.mock("@/server/jobs/youtubeMetricsSync", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/jobs/youtubeMetricsSync")>()),
  syncYouTubeMetricsPage: syncPageMock,
}));
vi.mock("@vercel/blob", () => ({ del: vi.fn() }));
vi.mock("@/server/jobs/failPendingResults", () => ({
  failPendingPostJobResults: vi.fn(),
  recomputeAndStorePostJobStatus: vi.fn(),
}));

import {
  connectionHealthSweep,
  inngestFunctions,
  refreshConnection,
  youtubePostMetricsSync,
} from "./inngest-functions";
import { inngestPlanConcurrency, refreshConnectionConcurrency } from "./publishFlowControl";
import {
  GOOGLE_IDLE_REFRESH_MS,
  HEALTH_SWEEP_PAGE_SIZE,
  proactiveRefreshWhere,
} from "./connectionHealthSweep";
import { PUBLISH_STEP_BUDGET_MS } from "@/server/platforms/publishBudget";
import { EmailRetryableError } from "@/server/notifications/email";
import { METRICS_MAX_PAGES_PER_RUN, METRICS_UNITS_PER_RUN } from "@/server/jobs/metricsScanner";
import type { MetricsPageResult as SyncPage } from "@/server/jobs/youtubeMetricsSync";

type SentEvent = { id: string; name: string; data: Record<string, unknown> };

/**
 * Stand-in for Inngest's `step`: runs each step inline and JSON-round-trips its
 * output the way Inngest's memoization does (so a step that leaks a Date or a
 * non-serializable value shows up here), recording ids in call order.
 */
function fakeStep() {
  const order: string[] = [];
  const outputs: Record<string, unknown> = {};
  return {
    order,
    outputs,
    run: vi.fn(async (id: string, cb: () => unknown) => {
      order.push(`run:${id}`);
      const out = await cb();
      const stored = out === undefined ? undefined : JSON.parse(JSON.stringify(out));
      outputs[id] = stored;
      return stored;
    }),
    sendEvent: vi.fn(async (id: string, payload: SentEvent[]) => {
      order.push(`sendEvent:${id}`);
      return { ids: payload.map((event) => event.id) };
    }),
  };
}
type FakeStep = ReturnType<typeof fakeStep>;

/** The function's handler (`fn` is private in Inngest's types but plain at runtime). */
function handlerOf<T>(fn: unknown): (args: { event: unknown; step: FakeStep; runId?: string }) => Promise<T> {
  const handler = (fn as { fn: (args: unknown) => Promise<T> }).fn;
  return (args) => handler({ runId: "run-1", ...args });
}

const optsOf = (fn: unknown) => (fn as { opts: Record<string, unknown> }).opts;
/** What Inngest's serve() registers for the function (private in the SDK's types, public at runtime). */
function registeredConfig(fn: unknown, id: string) {
  const { getConfig } = fn as {
    getConfig(opts: { baseUrl: URL; appPrefix: string }): Array<{ id: string; triggers: unknown }>;
  };
  return getConfig
    .call(fn, { baseUrl: new URL("https://app.example/api/inngest"), appPrefix: "vibe-socials" })
    .find((config) => config.id === `vibe-socials-${id}`);
}

const NOW = new Date("2026-11-01T04:45:00.000Z");

beforeEach(() => {
  for (const mock of [
    findManyMock,
    findUniqueMock,
    workspaceFindUniqueMock,
    membersFindManyMock,
    getPlatformClientMock,
    refreshConnectionTokenMock,
    sendEmailMock,
    syncPageMock,
  ]) {
    mock.mockReset();
  }
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  // Pass-through lock: the refresher runs on the snapshot.
  refreshConnectionTokenMock.mockImplementation(
    (snapshot: unknown, refresh: (current: unknown) => Promise<unknown>) => refresh(snapshot),
  );
  sendEmailMock.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("connectionHealthSweep (cron) — pages ids, fans out events", () => {
  const ids = (from: number, count: number) =>
    Array.from({ length: count }, (_, i) => ({ id: `conn-${from + i}` }));
  const runCron = (step: FakeStep) =>
    handlerOf<{ pages: number; connections: number }>(connectionHealthSweep)({
      event: { name: "inngest/scheduled.timer", data: {} },
      step,
    });
  const eventsOf = (step: FakeStep, call: number) => step.sendEvent.mock.calls[call][1];

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  it("is a singleton cron (a tick that arrives while a sweep is running is skipped)", () => {
    expect(optsOf(connectionHealthSweep).id).toBe("connection-health-sweep");
    expect(optsOf(connectionHealthSweep).singleton).toEqual({ mode: "skip" });
  });

  it("pages ids only (select id, take 1000), and a short second page ends the sweep with no third query", async () => {
    findManyMock
      .mockResolvedValueOnce(ids(0, HEALTH_SWEEP_PAGE_SIZE))
      .mockResolvedValueOnce(ids(HEALTH_SWEEP_PAGE_SIZE, 3));
    const step = fakeStep();

    const summary = await runCron(step);

    expect(findManyMock).toHaveBeenCalledTimes(2);
    const where = proactiveRefreshWhere(NOW);
    expect(findManyMock.mock.calls[0][0]).toEqual({
      where,
      select: { id: true },
      orderBy: { id: "asc" },
      take: 1000,
    });
    // The second page resumes with a KEYSET condition (id > the last id of the
    // first page), not a Prisma cursor: a cursor row that stops matching the
    // WHERE (it was refreshed) or is deleted would make `skip: 1` drop the next
    // real row, or return an empty page and end the sweep early.
    expect(findManyMock.mock.calls[1][0]).toEqual({
      where: { AND: [where, { id: { gt: "conn-999" } }] },
      select: { id: true },
      orderBy: { id: "asc" },
      take: 1000,
    });
    expect(findManyMock.mock.calls[1][0]).not.toHaveProperty("cursor");
    expect(findManyMock.mock.calls[1][0]).not.toHaveProperty("skip");
    expect(step.sendEvent).toHaveBeenCalledTimes(2);
    expect(eventsOf(step, 0)).toHaveLength(1000);
    expect(eventsOf(step, 1)).toHaveLength(3);
    expect(summary).toEqual({ pages: 2, connections: 1003 });
  });

  it("sends one event per connection with the id refresh-<id>-<UTC date> (a same-day re-run dedupes)", async () => {
    findManyMock.mockResolvedValueOnce(ids(0, 2));
    const step = fakeStep();

    await runCron(step);

    expect(eventsOf(step, 0)).toEqual([
      {
        id: "refresh-conn-0-2026-11-01",
        name: "connection/refresh.requested",
        data: { socialConnectionId: "conn-0" },
      },
      {
        id: "refresh-conn-1-2026-11-01",
        name: "connection/refresh.requested",
        data: { socialConnectionId: "conn-1" },
      },
    ]);
  });

  it("uses deterministic step ids: start, page-<i>, fan-out-<i>", async () => {
    findManyMock
      .mockResolvedValueOnce(ids(0, HEALTH_SWEEP_PAGE_SIZE))
      .mockResolvedValueOnce(ids(HEALTH_SWEEP_PAGE_SIZE, 3));
    const step = fakeStep();

    await runCron(step);

    expect(step.order).toEqual([
      "run:start",
      "run:page-0",
      "sendEvent:fan-out-0",
      "run:page-1",
      "sendEvent:fan-out-1",
    ]);
    expect(step.outputs.start).toBe(NOW.toISOString());
  });

  it("derives every page's WHERE and the event date from the memoized start time, not a later clock", async () => {
    findManyMock
      .mockImplementationOnce(async () => {
        // The clock moves past UTC midnight while the first page is read.
        vi.setSystemTime(new Date("2026-11-02T00:00:05.000Z"));
        return ids(0, HEALTH_SWEEP_PAGE_SIZE);
      })
      .mockResolvedValueOnce(ids(HEALTH_SWEEP_PAGE_SIZE, 1));
    const step = fakeStep();

    await runCron(step);

    expect(findManyMock.mock.calls[1][0].where).toEqual({
      AND: [proactiveRefreshWhere(NOW), { id: { gt: "conn-999" } }],
    });
    expect((eventsOf(step, 1) as SentEvent[])[0].id).toBe("refresh-conn-1000-2026-11-01");
  });

  // An in-memory stand-in for the table: evaluates just what the cron asks for
  // (the id keyset condition, ordering by id, take), over rows that other
  // processes keep refreshing out of the WHERE or deleting.
  describe("keyset paging over a table that changes under the sweep", () => {
    const pad = (n: number) => `c${String(n).padStart(5, "0")}`;
    type PageArgs = {
      where: { AND?: Array<{ id?: { gt: string } }> };
      take: number;
      cursor?: unknown;
      skip?: number;
    };

    function table(count: number, afterPage: (page: number, returned: string[], rows: Set<string>) => void) {
      const rows = new Set(Array.from({ length: count }, (_, i) => pad(i)));
      let page = 0;
      findManyMock.mockImplementation(async (args: PageArgs) => {
        expect(args).not.toHaveProperty("cursor");
        expect(args).not.toHaveProperty("skip");
        const gt = args.where.AND?.find((clause) => clause.id)?.id?.gt;
        const returned = [...rows]
          .sort()
          .filter((id) => gt === undefined || id > gt)
          .slice(0, args.take);
        afterPage(page++, returned, rows);
        return returned.map((id) => ({ id }));
      });
      return rows;
    }

    const fannedOut = (step: FakeStep) =>
      step.sendEvent.mock.calls.flatMap((call) => (call[1] as SentEvent[]).map((e) => e.id));

    it("a page-boundary row that is refreshed out of the WHERE (or deleted) before the next page loses no row and does not end the sweep", async () => {
      // 2,500 rows. After each page, the page's LAST row stops matching: exactly
      // the row the next page would have used as its cursor.
      table(2500, (_page, returned, rows) => {
        rows.delete(returned[returned.length - 1]);
      });
      const step = fakeStep();

      const summary = await runCron(step);

      const sent = fannedOut(step);
      // Every row was fanned out exactly once.
      expect(new Set(sent).size).toBe(sent.length);
      expect(sent).toHaveLength(2500);
      expect(sent[0]).toBe(`refresh-${pad(0)}-2026-11-01`);
      expect(sent[sent.length - 1]).toBe(`refresh-${pad(2499)}-2026-11-01`);
      expect(summary).toEqual({ pages: 3, connections: 2500 });
    });

    it("rows added while the sweep runs are picked up when they sort after the current page", async () => {
      const rows = table(1500, (page, _returned, live) => {
        if (page === 0) live.add(pad(9999));
      });

      await runCron(fakeStep());

      expect(rows.has(pad(9999))).toBe(true);
      expect(findManyMock).toHaveBeenCalledTimes(2);
    });
  });

  it("a full page followed by an empty page sends nothing for the empty one", async () => {
    findManyMock
      .mockResolvedValueOnce(ids(0, HEALTH_SWEEP_PAGE_SIZE))
      .mockResolvedValueOnce([]);
    const step = fakeStep();

    const summary = await runCron(step);

    expect(step.sendEvent).toHaveBeenCalledTimes(1);
    expect(summary).toEqual({ pages: 2, connections: 1000 });
  });

  it("no eligible connection: one page query, no event", async () => {
    findManyMock.mockResolvedValueOnce([]);
    const step = fakeStep();

    const summary = await runCron(step);

    expect(findManyMock).toHaveBeenCalledTimes(1);
    expect(step.sendEvent).not.toHaveBeenCalled();
    expect(summary).toEqual({ pages: 1, connections: 0 });
  });

  it("never loads token columns, and its step outputs hold only ids", async () => {
    findManyMock.mockResolvedValueOnce(ids(0, 2));
    const step = fakeStep();

    await runCron(step);

    const select = findManyMock.mock.calls[0][0].select as Record<string, boolean>;
    expect(Object.keys(select)).toEqual(["id"]);
    expect(JSON.stringify(step.outputs)).not.toMatch(/accessToken|refreshToken/);
  });

  it("does not refresh anything itself", async () => {
    findManyMock.mockResolvedValueOnce(ids(0, 2));

    await runCron(fakeStep());

    expect(getPlatformClientMock).not.toHaveBeenCalled();
    expect(refreshConnectionTokenMock).not.toHaveBeenCalled();
    expect(sendEmailMock).not.toHaveBeenCalled();
  });
});

describe("every registered function fits the Inngest plan", () => {
  it("never sets a concurrency limit above the plan ceiling (the sync rejects the whole app)", () => {
    const ceiling = inngestPlanConcurrency();
    for (const fn of inngestFunctions) {
      const { id, concurrency } = optsOf(fn) as {
        id: string;
        concurrency?: number | { limit: number } | Array<{ limit: number }>;
      };
      if (concurrency === undefined) continue;
      const limits =
        typeof concurrency === "number"
          ? [concurrency]
          : (Array.isArray(concurrency) ? concurrency : [concurrency]).map((c) => c.limit);
      for (const limit of limits) {
        expect({ id, limit }).toEqual({ id, limit: Math.min(limit, ceiling) });
      }
    }
  });
});

describe("refreshConnection (refresh-connection) — configuration", () => {
  it("keeps the contract: id, retries 2, one run per connection and a plan-clamped total, event trigger", () => {
    const opts = optsOf(refreshConnection);
    expect(opts.id).toBe("refresh-connection");
    expect(opts.retries).toBe(2);
    expect(opts.concurrency).toEqual(refreshConnectionConcurrency());
    expect(opts.concurrency).toEqual([
      { key: "event.data.socialConnectionId", limit: 1 },
      { limit: Math.min(10, inngestPlanConcurrency()) },
    ]);
    expect(registeredConfig(refreshConnection, "refresh-connection")?.triggers).toEqual([
      { event: "connection/refresh.requested" },
    ]);
  });

  it("is registered, and the cron keeps its id", () => {
    expect(inngestFunctions).toContain(refreshConnection);
    expect(inngestFunctions).toContain(connectionHealthSweep);
  });
});

describe("refreshConnection — one connection", () => {
  const EVENT = { name: "connection/refresh.requested", data: { socialConnectionId: "conn-1" } };

  /** The in-memory row the mocked prisma serves; refreshers mutate it like the real ones. */
  let row: Record<string, unknown> | null;
  const connectionRow = (overrides: Record<string, unknown> = {}) => ({
    id: "conn-1",
    userId: "user-1",
    workspaceId: "ws-1",
    platform: "tiktok" as Platform,
    accessToken: "secret-access-token",
    refreshToken: "secret-refresh-token",
    expiresAt: new Date("2026-10-31T00:00:00.000Z"),
    needsReconnect: false,
    ...overrides,
  });

  /** A platform client whose refreshToken is the given function. */
  const clientWith = (refreshToken: (conn: unknown, opts?: unknown) => Promise<unknown>) =>
    getPlatformClientMock.mockReturnValue({ publishVideo: vi.fn(), refreshToken });

  const run = (step = fakeStep()) =>
    handlerOf<{ socialConnectionId: string; outcome: string; emailed: number }>(refreshConnection)({
      event: EVENT,
      step,
    }).then((result) => ({ result, step }));

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    row = connectionRow();
    findUniqueMock.mockImplementation(async (args: { select?: Record<string, boolean> }) => {
      if (!row) return null;
      if (!args.select) return row;
      return Object.fromEntries(Object.keys(args.select).map((key) => [key, row![key]]));
    });
    workspaceFindUniqueMock.mockResolvedValue({ name: "Acme" });
    membersFindManyMock.mockResolvedValue([
      { user: { id: "user-a", email: "owner-a@example.com" } },
      { user: { id: "user-b", email: "owner-b@example.com" } },
    ]);
  });

  it("refreshes through the lock with the step deadline and reports 'refreshed' (no email)", async () => {
    const refresher = vi.fn(async (conn: unknown) => conn);
    clientWith(refresher);

    const { result, step } = await run();

    expect(result).toEqual({ socialConnectionId: "conn-1", outcome: "refreshed", emailed: 0 });
    expect(step.order).toEqual(["run:refresh"]);
    expect(refreshConnectionTokenMock).toHaveBeenCalledTimes(1);
    const [snapshot, refresh, opts] = refreshConnectionTokenMock.mock.calls[0];
    expect(snapshot).toBe(row);
    expect(opts).toEqual({ deadline: NOW.getTime() + PUBLISH_STEP_BUDGET_MS });
    // The refresher callback hands the lock's row and the same deadline to the client.
    await refresh(row);
    expect(refresher).toHaveBeenCalledWith(row, { deadline: NOW.getTime() + PUBLISH_STEP_BUDGET_MS });
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it("FLAGGED: a refresher that flags the connection runs notify-owners, which emails each owner once", async () => {
    clientWith(async () => {
      row = { ...row!, needsReconnect: true }; // what markConnectionNeedsReconnect writes
      throw Object.assign(new Error("expired"), { code: "TIKTOK_RECONNECT_REQUIRED" });
    });

    const { result, step } = await run();

    expect(result).toEqual({ socialConnectionId: "conn-1", outcome: "flagged", emailed: 2 });
    expect(step.order).toEqual(["run:refresh", "run:notify-owners"]);
    expect(sendEmailMock).toHaveBeenCalledTimes(2);
    expect(sendEmailMock.mock.calls.map((c) => c[0].to)).toEqual([
      "owner-a@example.com",
      "owner-b@example.com",
    ]);
    // The email names the platform and the workspace.
    expect(sendEmailMock.mock.calls[0][0].subject).toContain("TikTok");
    expect(JSON.stringify(sendEmailMock.mock.calls[0][0])).toContain("Acme");
    expect(workspaceFindUniqueMock).toHaveBeenCalledWith({ where: { id: "ws-1" }, select: { name: true } });
    expect(membersFindManyMock).toHaveBeenCalledWith({
      where: { workspaceId: "ws-1", role: "owner" },
      select: { user: { select: { id: true, email: true } } },
    });
  });

  // 2026-11-01 scale audit (jobs, notifications): a Resend 429 / 5xx now fails the
  // notify-owners step so Inngest retries it, and the per-owner key makes the
  // retry (or a lost ack) a no-op for owners already emailed (V18).
  it("FLAGGED: each owner email carries a per-owner, per-UTC-day idempotency key and throws on retryable errors", async () => {
    clientWith(async () => {
      row = { ...row!, needsReconnect: true };
      throw Object.assign(new Error("expired"), { code: "TIKTOK_RECONNECT_REQUIRED" });
    });

    await run();

    expect(sendEmailMock.mock.calls.map((c) => c[1])).toEqual([
      { idempotencyKey: "reconnect/conn-1/2026-11-01/user-a", throwOnRetryable: true },
      { idempotencyKey: "reconnect/conn-1/2026-11-01/user-b", throwOnRetryable: true },
    ]);
  });

  it("FLAGGED: a retryable send error fails the notify-owners step (and so is retried)", async () => {
    clientWith(async () => {
      row = { ...row!, needsReconnect: true };
      throw new Error("expired");
    });
    sendEmailMock.mockRejectedValueOnce(new EmailRetryableError("Resend send failed (status 503)"));

    await expect(run()).rejects.toBeInstanceOf(EmailRetryableError);
  });

  it("never puts tokens or email addresses in step output", async () => {
    clientWith(async () => {
      row = { ...row!, needsReconnect: true };
      throw new Error("expired");
    });

    const { step } = await run();

    const outputs = JSON.stringify(step.outputs);
    expect(outputs).not.toMatch(/secret-access-token|secret-refresh-token|@example\.com/);
  });

  it("TRANSIENT: a refresh that throws without flagging sends no email and reports 'transient_error'", async () => {
    clientWith(async () => {
      throw Object.assign(new Error("Failed to refresh (status 503)"), { status: 503 });
    });

    const { result, step } = await run();

    expect(result.outcome).toBe("transient_error");
    expect(step.order).toEqual(["run:refresh"]);
    expect(sendEmailMock).not.toHaveBeenCalled();
    expect(membersFindManyMock).not.toHaveBeenCalled();
  });

  it("a lock timeout (CONNECTION_REFRESH_BUSY) is transient: no email, retried by tomorrow's sweep", async () => {
    clientWith(async () => ({}));
    refreshConnectionTokenMock.mockRejectedValue(
      Object.assign(new Error("busy"), { code: "CONNECTION_REFRESH_BUSY", status: 503 }),
    );

    const { result } = await run();

    expect(result.outcome).toBe("transient_error");
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it("ALREADY FLAGGED: no refresher call and no email", async () => {
    row = connectionRow({ needsReconnect: true });
    const refresher = vi.fn();
    clientWith(refresher);

    const { result, step } = await run();

    expect(result.outcome).toBe("already_flagged");
    expect(refresher).not.toHaveBeenCalled();
    expect(refreshConnectionTokenMock).not.toHaveBeenCalled();
    expect(step.order).toEqual(["run:refresh"]);
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it("flagged by another process inside the lock (RECONNECT_REQUIRED): 'already_flagged', that process owns the email", async () => {
    clientWith(async () => ({}));
    refreshConnectionTokenMock.mockRejectedValue(
      Object.assign(new Error("needs reconnect"), { code: "RECONNECT_REQUIRED" }),
    );
    const { result } = await run();

    expect(result.outcome).toBe("already_flagged");
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it("GONE: the connection was deleted before the run, or inside the lock", async () => {
    row = null;
    clientWith(vi.fn());
    expect((await run()).result.outcome).toBe("gone");

    row = connectionRow();
    refreshConnectionTokenMock.mockRejectedValue(
      Object.assign(new Error("removed"), { code: "CONNECTION_GONE" }),
    );
    expect((await run()).result.outcome).toBe("gone");
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it("NOT ELIGIBLE: re-checked at run time (a Google token refreshed since the cron paged it)", async () => {
    row = connectionRow({ platform: "youtube", expiresAt: new Date(NOW.getTime() + 30 * 60 * 1000) });
    const refresher = vi.fn();
    clientWith(refresher);

    const { result } = await run();

    expect(result.outcome).toBe("not_eligible");
    expect(refresher).not.toHaveBeenCalled();
    expect(refreshConnectionTokenMock).not.toHaveBeenCalled();
  });

  it("a Google connection idle past the window is refreshed", async () => {
    row = connectionRow({
      platform: "youtube",
      expiresAt: new Date(NOW.getTime() - GOOGLE_IDLE_REFRESH_MS - 60_000),
    });
    clientWith(async (conn) => conn);

    const { result } = await run();

    expect(result.outcome).toBe("refreshed");
  });

  it("NO REFRESH: a platform client without refreshToken (e.g. LinkedIn) is left alone", async () => {
    row = connectionRow({ platform: "linkedin" });
    getPlatformClientMock.mockReturnValue({ publishVideo: vi.fn() });

    const { result } = await run();

    expect(result.outcome).toBe("no_refresh");
    expect(refreshConnectionTokenMock).not.toHaveBeenCalled();
  });

  it("a connection that vanished while the refresh failed is 'gone', not an email", async () => {
    clientWith(async () => {
      row = null;
      throw new Error("boom");
    });

    const { result } = await run();

    expect(result.outcome).toBe("gone");
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it("notify-owners re-checks the flag: nothing is sent when the connection is no longer flagged", async () => {
    clientWith(async () => {
      row = { ...row!, needsReconnect: true };
      throw new Error("expired");
    });
    // The owner reconnected between the two steps.
    const step = fakeStep();
    const runStep = step.run.getMockImplementation()!;
    step.run.mockImplementation(async (id, cb) => {
      if (id === "notify-owners") row = { ...row!, needsReconnect: false };
      return runStep(id, cb);
    });

    const { result } = await run(step);

    expect(result.outcome).toBe("flagged");
    expect(result.emailed).toBe(0);
    expect(sendEmailMock).not.toHaveBeenCalled();
  });
});

describe("youtubePostMetricsSync (cron) — least-recently-checked pages within a unit budget", () => {
  type Summary = {
    pages: number;
    attempted: number;
    updated: number;
    notFound: number;
    errors: number;
    unitsUsed: number;
    stopped: boolean;
  };
  const page = (over: Partial<SyncPage> = {}): SyncPage => ({
    attempted: 200,
    updated: 190,
    notFound: 5,
    errors: 5,
    unitsUsed: 4,
    stop: false,
    ...over,
  });
  const run = (step: FakeStep = fakeStep()) =>
    handlerOf<Summary>(youtubePostMetricsSync)({
      event: { name: "inngest/scheduled.timer", data: {} },
      step,
    });

  it("keeps its function id and hourly cron, and is a singleton (a tick during a running sync is skipped)", () => {
    expect(optsOf(youtubePostMetricsSync).id).toBe("youtube-post-metrics-sync");
    expect(optsOf(youtubePostMetricsSync).singleton).toEqual({ mode: "skip" });
    expect(registeredConfig(youtubePostMetricsSync, "youtube-post-metrics-sync")?.triggers).toEqual([
      { cron: "0 * * * *" },
    ]);
    expect(inngestFunctions).toContain(youtubePostMetricsSync);
  });

  it("pages until a page attempts nothing, one deterministic step per page, passing the units left", async () => {
    syncPageMock
      .mockResolvedValueOnce(page({ unitsUsed: 4 }))
      .mockResolvedValueOnce(page({ unitsUsed: 6 }))
      .mockResolvedValueOnce(page({ attempted: 0, updated: 0, notFound: 0, errors: 0, unitsUsed: 0 }));
    const step = fakeStep();

    const summary = await run(step);

    expect(step.order).toEqual(["run:sync-page-0", "run:sync-page-1", "run:sync-page-2"]);
    expect(syncPageMock.mock.calls.map((call) => call[0])).toEqual([
      { unitsLeft: METRICS_UNITS_PER_RUN },
      { unitsLeft: METRICS_UNITS_PER_RUN - 4 },
      { unitsLeft: METRICS_UNITS_PER_RUN - 10 },
    ]);
    expect(summary).toEqual({
      pages: 3,
      attempted: 400,
      updated: 380,
      notFound: 10,
      errors: 10,
      unitsUsed: 10,
      stopped: false,
    });
  });

  it("stops right after a page that hit the YouTube quota", async () => {
    syncPageMock.mockResolvedValue(page({ stop: true }));
    const step = fakeStep();

    const summary = await run(step);

    expect(step.order).toEqual(["run:sync-page-0"]);
    expect(summary.stopped).toBe(true);
  });

  it("stops when the run's unit budget is spent", async () => {
    syncPageMock
      .mockResolvedValueOnce(page({ unitsUsed: 200 }))
      .mockResolvedValueOnce(page({ unitsUsed: 100 }))
      .mockResolvedValue(page());
    const step = fakeStep();

    const summary = await run(step);

    expect(step.order).toEqual(["run:sync-page-0", "run:sync-page-1"]);
    expect(summary.unitsUsed).toBe(METRICS_UNITS_PER_RUN);
  });

  it("never runs more than METRICS_MAX_PAGES_PER_RUN pages", async () => {
    syncPageMock.mockResolvedValue(page({ unitsUsed: 1 }));
    const step = fakeStep();

    const summary = await run(step);

    expect(step.order).toHaveLength(METRICS_MAX_PAGES_PER_RUN);
    expect(step.order[METRICS_MAX_PAGES_PER_RUN - 1]).toBe(`run:sync-page-${METRICS_MAX_PAGES_PER_RUN - 1}`);
    expect(summary.pages).toBe(METRICS_MAX_PAGES_PER_RUN);
  });

  it("step outputs are counts only (no tokens, no emails, no ids)", async () => {
    syncPageMock.mockResolvedValueOnce(page()).mockResolvedValueOnce(page({ attempted: 0 }));
    const step = fakeStep();

    await run(step);

    expect(Object.keys(step.outputs)).toEqual(["sync-page-0", "sync-page-1"]);
    expect(Object.keys(step.outputs["sync-page-0"] as object).sort()).toEqual([
      "attempted",
      "errors",
      "notFound",
      "stop",
      "unitsUsed",
      "updated",
    ]);
  });
});
