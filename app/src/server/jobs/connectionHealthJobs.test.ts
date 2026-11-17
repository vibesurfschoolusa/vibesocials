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
  backfillGbpLocationTitlesMock,
  sendConnectionNoticesMock,
  updateManyMock,
} = vi.hoisted(() => ({
  findManyMock: vi.fn(),
  findUniqueMock: vi.fn(),
  workspaceFindUniqueMock: vi.fn(),
  membersFindManyMock: vi.fn(),
  getPlatformClientMock: vi.fn(),
  refreshConnectionTokenMock: vi.fn(),
  sendEmailMock: vi.fn(),
  syncPageMock: vi.fn(),
  backfillGbpLocationTitlesMock: vi.fn(),
  sendConnectionNoticesMock: vi.fn(),
  updateManyMock: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    socialConnection: { findMany: findManyMock, findUnique: findUniqueMock, updateMany: updateManyMock },
    workspace: { findUnique: workspaceFindUniqueMock },
    workspaceMember: { findMany: membersFindManyMock },
    // 2026-11-09: the sweep's last step deletes YouTube statistics older than
    // 30 days (server/connections/youtubeData.ts); none are stale here.
    postMetric: { deleteMany: async () => ({ count: 0 }) },
  },
}));
vi.mock("@/server/platforms", () => ({ getPlatformClient: getPlatformClientMock }));
// 2026-11-09: the sweep's last step refreshes or expires stored LinkedIn page
// names (server/connections/linkedinData.ts, its own suite); none here.
vi.mock("@/server/connections/linkedinData", () => ({
  refreshLinkedInOrganizationProfiles: async () => ({ refreshed: 0, cleared: 0 }),
}));
// 2026-11-10: then it names Business Profile locations that have no title yet
// (server/connections/gbpLocationTitle.ts, its own suite); none here.
vi.mock("@/server/connections/gbpLocationTitle", () => ({
  backfillGbpLocationTitles: backfillGbpLocationTitlesMock,
}));
// R5-publishing M1: the sweep's last step sends the connection notices
// (connectionNotices.ts, its own suite). Only that function is replaced:
// notifyOwnersToReconnect, which refresh-connection uses, stays real.
vi.mock("@/server/jobs/connectionNotices", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/jobs/connectionNotices")>()),
  sendConnectionNotices: sendConnectionNoticesMock,
}));
// The lock helper has its own suite (connectionRefresh.test.ts); only the
// function is replaced, its error codes stay real.
vi.mock("@/server/platforms/connectionRefresh", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/platforms/connectionRefresh")>()),
  refreshConnectionToken: refreshConnectionTokenMock,
}));
// Only the transport is replaced; EmailRetryableError / isRetryableEmailError stay real.
vi.mock("@/server/notifications/email", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/notifications/email")>()),
  sendEmailOutcome: sendEmailMock,
}));
// R43 review: each owner's reconnect email is claimed (sendOncePer); every claim
// is free here, and connectionNotices.test.ts covers the claims themselves.
vi.mock("@/lib/rateLimit", () => ({ consumeFixedWindow: async () => ({ allowed: true }) }));
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
  INLINE_REFRESH_BUDGET_MS,
  isProactiveRefreshEligible,
  proactiveRefreshWhere,
  SWEEP_PAGE_SELECT,
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
const NO_NOTICES = { warned: 0, lapsed: 0, reconnectEmails: 0 };
/** The sweep's count of free workspaces' connections refreshed in its own step: none. */
const NO_FREE_REFRESH = { due: 0, refreshed: 0, flagged: 0, emailed: 0, unchanged: 0, failed: 0, leftForTomorrow: 0 };

/**
 * A workspace the fan-out keeps (grandfathered), as the page query selects it.
 * R10 (V3): free workspaces' connections are refreshed in the sweep's own step.
 */
const FANNED_OUT_WORKSPACE = {
  billingExempt: true,
  plan: null,
  planStatus: null,
  trialEndsAt: null,
  currentPeriodEnd: null,
  members: [{ user: { email: "owner-a@example.com", emailVerifiedAt: NOW } }],
};

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
  sendEmailMock.mockResolvedValue({ sent: true });
  backfillGbpLocationTitlesMock.mockReset();
  backfillGbpLocationTitlesMock.mockResolvedValue({ named: 0, failed: 0, flagged: [] });
  sendConnectionNoticesMock.mockReset();
  sendConnectionNoticesMock.mockResolvedValue(NO_NOTICES);
  updateManyMock.mockReset();
  updateManyMock.mockResolvedValue({ count: 1 });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("connectionHealthSweep (cron) — pages ids, fans out events", () => {
  const ids = (from: number, count: number) =>
    Array.from({ length: count }, (_, i) => ({
      id: `conn-${from + i}`,
      expiresAt: NOW,
      workspace: FANNED_OUT_WORKSPACE,
    }));
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

  it("pages ids with their workspace's plan and owners (take 1000), and a short second page ends the sweep with no third query", async () => {
    findManyMock
      .mockResolvedValueOnce(ids(0, HEALTH_SWEEP_PAGE_SIZE))
      .mockResolvedValueOnce(ids(HEALTH_SWEEP_PAGE_SIZE, 3));
    const step = fakeStep();

    const summary = await runCron(step);

    expect(findManyMock).toHaveBeenCalledTimes(2);
    const where = proactiveRefreshWhere(NOW);
    expect(findManyMock.mock.calls[0][0]).toEqual({
      where,
      select: SWEEP_PAGE_SELECT,
      orderBy: { id: "asc" },
      take: 1000,
    });
    // The second page resumes with a KEYSET condition (id > the last id of the
    // first page), not a Prisma cursor: a cursor row that stops matching the
    // WHERE (it was refreshed) or is deleted would make `skip: 1` drop the next
    // real row, or return an empty page and end the sweep early.
    expect(findManyMock.mock.calls[1][0]).toEqual({
      where: { AND: [where, { id: { gt: "conn-999" } }] },
      select: SWEEP_PAGE_SELECT,
      orderBy: { id: "asc" },
      take: 1000,
    });
    expect(findManyMock.mock.calls[1][0]).not.toHaveProperty("cursor");
    expect(findManyMock.mock.calls[1][0]).not.toHaveProperty("skip");
    expect(step.sendEvent).toHaveBeenCalledTimes(2);
    expect(eventsOf(step, 0)).toHaveLength(1000);
    expect(eventsOf(step, 1)).toHaveLength(3);
    expect(summary).toEqual({ pages: 2, connections: 1003, purgedYouTubeMetrics: 0, linkedinOrganizations: { refreshed: 0, cleared: 0 }, gbpLocationTitles: { named: 0, failed: 0, flagged: 0, reconnectEmails: 0 }, freeRefresh: NO_FREE_REFRESH, connectionNotices: NO_NOTICES });
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

  // 2026-11-10: the title backfill refreshes Google tokens; a dead grant flags the
  // connection outside refresh-connection, which is what emails the owners.
  it("emails the owners of a Business Profile connection the title backfill found dead", async () => {
    findManyMock.mockResolvedValueOnce([]);
    backfillGbpLocationTitlesMock.mockResolvedValue({ named: 2, failed: 1, flagged: ["conn-9"] });
    findUniqueMock.mockResolvedValue({
      platform: "google_business_profile",
      workspaceId: "ws-1",
      needsReconnect: true,
      lastRefreshErrorCode: "GOOGLE_TOKEN_REFRESH_FAILED",
      refreshFailedAt: NOW,
      reconnectEmailedAt: null,
    });
    workspaceFindUniqueMock.mockResolvedValue({ name: "Acme" });
    membersFindManyMock.mockResolvedValue([{ user: { id: "user-a", email: "owner-a@example.com" } }]);
    const step = fakeStep();

    const summary = await runCron(step);

    expect(step.order.slice(-3)).toEqual([
      "run:backfill-gbp-location-titles",
      "run:notify-gbp-reconnect-0",
      "run:connection-notices",
    ]);
    expect(findUniqueMock).toHaveBeenCalledWith({
      where: { id: "conn-9" },
      select: {
        platform: true,
        workspaceId: true,
        needsReconnect: true,
        lastRefreshErrorCode: true,
        refreshFailedAt: true,
        reconnectEmailedAt: true,
      },
    });
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    expect(sendEmailMock.mock.calls[0][0].to).toBe("owner-a@example.com");
    expect(sendEmailMock.mock.calls[0][0].subject).toContain("Google Business Profile");
    // The same per-day key refresh-connection uses, so nobody is emailed twice.
    expect(sendEmailMock.mock.calls[0][1]).toMatchObject({
      idempotencyKey: "reconnect/conn-9/2026-11-01/user-a",
    });
    expect((summary as unknown as { gbpLocationTitles: unknown }).gbpLocationTitles).toEqual({
      named: 2,
      failed: 1,
      flagged: 1,
      reconnectEmails: 1,
    });
  });

  // R5-publishing M1: warnings before an unrenewable sign-in ends, the flag when it
  // has, and the reconnect email for every flag that has not had one. One step,
  // last, so a failing send never holds back the steps before it.
  it("ends with one connection-notices step, given the memoized start time and its UTC day", async () => {
    findManyMock.mockResolvedValueOnce([]);
    sendConnectionNoticesMock.mockResolvedValue({ warned: 2, lapsed: 1, reconnectEmails: 3 });
    const step = fakeStep();

    const summary = await runCron(step);

    expect(step.order[step.order.length - 1]).toBe("run:connection-notices");
    expect(sendConnectionNoticesMock).toHaveBeenCalledWith(NOW.toISOString(), "2026-11-01");
    expect((summary as unknown as { connectionNotices: unknown }).connectionNotices).toEqual({
      warned: 2,
      lapsed: 1,
      reconnectEmails: 3,
    });
  });

  it("uses deterministic step ids: start, page-<i>, fan-out-<i>, then the YouTube and LinkedIn data steps", async () => {
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
      "run:purge-stale-youtube-metrics",
      "run:refresh-linkedin-organization-profiles",
      "run:backfill-gbp-location-titles",
      "run:connection-notices",
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
        return returned.map((id) => ({ id, expiresAt: NOW, workspace: FANNED_OUT_WORKSPACE }));
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
      expect(summary).toEqual({ pages: 3, connections: 2500, purgedYouTubeMetrics: 0, linkedinOrganizations: { refreshed: 0, cleared: 0 }, gbpLocationTitles: { named: 0, failed: 0, flagged: 0, reconnectEmails: 0 }, freeRefresh: NO_FREE_REFRESH, connectionNotices: NO_NOTICES });
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
    expect(summary).toEqual({ pages: 2, connections: 1000, purgedYouTubeMetrics: 0, linkedinOrganizations: { refreshed: 0, cleared: 0 }, gbpLocationTitles: { named: 0, failed: 0, flagged: 0, reconnectEmails: 0 }, freeRefresh: NO_FREE_REFRESH, connectionNotices: NO_NOTICES });
  });

  it("no eligible connection: one page query, no event", async () => {
    findManyMock.mockResolvedValueOnce([]);
    const step = fakeStep();

    const summary = await runCron(step);

    expect(findManyMock).toHaveBeenCalledTimes(1);
    expect(step.sendEvent).not.toHaveBeenCalled();
    expect(summary).toEqual({ pages: 1, connections: 0, purgedYouTubeMetrics: 0, linkedinOrganizations: { refreshed: 0, cleared: 0 }, gbpLocationTitles: { named: 0, failed: 0, flagged: 0, reconnectEmails: 0 }, freeRefresh: NO_FREE_REFRESH, connectionNotices: NO_NOTICES });
  });

  it("never loads token columns, and its step outputs hold no token or address", async () => {
    findManyMock.mockResolvedValueOnce(ids(0, 2));
    const step = fakeStep();

    await runCron(step);

    const select = findManyMock.mock.calls[0][0].select as Record<string, unknown>;
    expect(Object.keys(select)).toEqual(["id", "expiresAt", "refreshFailedAt", "workspace"]);
    expect(JSON.stringify(select)).not.toMatch(/accessToken|refreshToken/);
    expect(JSON.stringify(step.outputs)).not.toMatch(/accessToken|refreshToken|@example/);
  });

  it("does not refresh anything itself", async () => {
    findManyMock.mockResolvedValueOnce(ids(0, 2));

    await runCron(fakeStep());

    expect(getPlatformClientMock).not.toHaveBeenCalled();
    expect(refreshConnectionTokenMock).not.toHaveBeenCalled();
    expect(sendEmailMock).not.toHaveBeenCalled();
  });
});

// R10 (V3): the daily refresh of a free workspace's connection used to be a
// fanned-out run (two executions nothing counted). Now the sweep refreshes them
// itself, in one step, one after another, under the same per-connection lock
// and with the same flag and reconnect email as refresh-connection; at most
// FREE_INLINE_REFRESH_DAILY_CAP a day, soonest-expiring first, within
// INLINE_REFRESH_BUDGET_MS. Paid, grandfathered and operator-owned workspaces
// keep the fan-out.
describe("connectionHealthSweep — free workspaces' connections are refreshed in its own step", () => {
  type Row = Record<string, unknown> & { id: string; platform: Platform; expiresAt: Date; workspace: Record<string, unknown> };
  const OWNERS = [
    { user: { email: "owner-a@example.com", emailVerifiedAt: NOW } },
    { user: { email: "owner-b@example.com", emailVerifiedAt: NOW } },
  ];
  const FREE_WS = { billingExempt: false, plan: null, planStatus: null, trialEndsAt: null, currentPeriodEnd: null, members: OWNERS };
  // R10-security M1: paid means a paid invoice recorded (planPaidAt).
  const PAID_WS = {
    ...FREE_WS,
    plan: "growth",
    planStatus: "active",
    currentPeriodEnd: new Date(NOW.getTime() + 20 * 86_400_000),
    planPaidAt: new Date(NOW.getTime() - 10 * 86_400_000),
  };
  /** Access-token lifetime each refresher writes, per platform. */
  const LIFETIME: Partial<Record<Platform, number>> = { tiktok: 86_400_000, pinterest: 30 * 86_400_000 };

  let rows: Map<string, Row>;
  const add = (id: string, overrides: Partial<Row> = {}) => {
    const row: Row = {
      id,
      userId: "user-1",
      workspaceId: `ws-${id}`,
      platform: "tiktok",
      accessToken: "secret-access-token",
      refreshToken: "secret-refresh-token",
      expiresAt: new Date(NOW.getTime() - 60_000),
      needsReconnect: false,
      lastRefreshErrorCode: null,
      refreshFailedAt: null,
      reconnectEmailedAt: null,
      workspace: FREE_WS,
      ...overrides,
    };
    rows.set(id, row);
    return row;
  };
  /** The platform's refresher, as the real ones behave: a new expiry from the clock. */
  let refresher: ReturnType<typeof vi.fn>;

  const runCron = (step = fakeStep()) =>
    handlerOf<Record<string, unknown> & { connections: number; freeRefresh: typeof NO_FREE_REFRESH }>(connectionHealthSweep)({
      event: { name: "inngest/scheduled.timer", data: {} },
      step,
    }).then((summary) => ({ summary, step }));
  const fannedOut = (step: FakeStep) =>
    step.sendEvent.mock.calls.flatMap((call) => (call[1] as SentEvent[]).map((event) => event.data.socialConnectionId));
  const refreshedIds = () => refreshConnectionTokenMock.mock.calls.map((call) => (call[0] as Row).id);

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    rows = new Map();
    // The table: the page query's WHERE is the connection rule (its own suite pins the SQL).
    findManyMock.mockImplementation(async (args: { where: { AND?: Array<{ id?: { gt: string } }> }; take: number }) => {
      const gt = args.where.AND?.find((clause) => clause.id)?.id?.gt;
      return [...rows.values()]
        .filter((row) => isProactiveRefreshEligible(row as never, new Date()))
        .filter((row) => gt === undefined || row.id > gt)
        .sort((a, b) => (a.id < b.id ? -1 : 1))
        .slice(0, args.take)
        .map((row) => ({ id: row.id, expiresAt: row.expiresAt, refreshFailedAt: row.refreshFailedAt, workspace: row.workspace }));
    });
    findUniqueMock.mockImplementation(async (args: { where: { id: string }; select?: Record<string, boolean> }) => {
      const row = rows.get(args.where.id);
      if (!row) return null;
      if (!args.select) return row;
      return Object.fromEntries(Object.keys(args.select).map((key) => [key, row[key]]));
    });
    refresher = vi.fn(async (conn: Row) => {
      const row = rows.get(conn.id)!;
      row.expiresAt = new Date(Date.now() + (LIFETIME[row.platform] ?? 86_400_000));
      return row;
    });
    getPlatformClientMock.mockImplementation(() => ({ publishVideo: vi.fn(), refreshToken: refresher }));
    workspaceFindUniqueMock.mockResolvedValue({ name: "Acme" });
    membersFindManyMock.mockResolvedValue([
      { user: { id: "user-a", email: "owner-a@example.com" } },
      { user: { id: "user-b", email: "owner-b@example.com" } },
    ]);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("a free workspace's TikTok connection that is due is refreshed in the sweep's step, under the lock, with no fanned-out run", async () => {
    add("conn-1");

    const { summary, step } = await runCron();

    expect(step.sendEvent).not.toHaveBeenCalled();
    expect(refreshedIds()).toEqual(["conn-1"]);
    // The step's deadline, handed to the lock and to the platform's refresher.
    const [, refresh, opts] = refreshConnectionTokenMock.mock.calls[0];
    expect(opts).toEqual({ deadline: NOW.getTime() + INLINE_REFRESH_BUDGET_MS });
    await refresh(rows.get("conn-1"));
    expect(refresher).toHaveBeenLastCalledWith(rows.get("conn-1"), { deadline: NOW.getTime() + INLINE_REFRESH_BUDGET_MS });
    expect(step.order).toEqual([
      "run:start",
      "run:page-0",
      "run:refresh-free-connections",
      "run:purge-stale-youtube-metrics",
      "run:refresh-linkedin-organization-profiles",
      "run:backfill-gbp-location-titles",
      "run:connection-notices",
    ]);
    expect(summary.connections).toBe(0);
    expect(summary.freeRefresh).toEqual({ ...NO_FREE_REFRESH, due: 1, refreshed: 1 });
    expect(JSON.stringify(step.outputs)).not.toMatch(/secret|@example/);
  });

  it("a revoked grant: the connection is flagged and its owners are emailed the same day, in that step", async () => {
    add("conn-1");
    refresher.mockImplementation(async (conn: Row) => {
      rows.get(conn.id)!.needsReconnect = true; // what markConnectionNeedsReconnect writes
      throw Object.assign(new Error("revoked"), { code: "TIKTOK_RECONNECT_REQUIRED" });
    });

    const { summary, step } = await runCron();

    expect(step.sendEvent).not.toHaveBeenCalled();
    expect(sendEmailMock.mock.calls.map((call) => call[0].to)).toEqual(["owner-a@example.com", "owner-b@example.com"]);
    expect(sendEmailMock.mock.calls[0][0].subject).toContain("TikTok");
    // The key refresh-connection uses, so the notices step never emails them twice.
    expect(sendEmailMock.mock.calls.map((call) => call[1].idempotencyKey)).toEqual([
      "reconnect/conn-1/2026-11-01/user-a",
      "reconnect/conn-1/2026-11-01/user-b",
    ]);
    expect(updateManyMock).toHaveBeenCalledWith({
      where: { id: "conn-1", needsReconnect: true },
      data: { reconnectEmailedAt: NOW },
    });
    expect(summary.freeRefresh).toEqual({ ...NO_FREE_REFRESH, due: 1, flagged: 1, emailed: 2 });
  });

  it("150 free connections due: the 100 soonest-expiring today, the other 50 tomorrow", async () => {
    // Pinterest: a refresh moves expiresAt 30 days out, so today's are not due tomorrow.
    for (let i = 0; i < 150; i++) {
      add(`conn-${String(i).padStart(3, "0")}`, {
        platform: "pinterest",
        expiresAt: new Date(NOW.getTime() - (150 - i) * 60_000),
      });
    }
    const soonest = [...rows.keys()].slice(0, 100);
    const rest = [...rows.keys()].slice(100);

    const today = await runCron();

    expect(refreshedIds()).toEqual(soonest);
    expect(today.step.sendEvent).not.toHaveBeenCalled();
    expect(today.summary.freeRefresh).toEqual({ ...NO_FREE_REFRESH, due: 150, refreshed: 100, leftForTomorrow: 50 });

    refreshConnectionTokenMock.mockClear();
    vi.setSystemTime(new Date(NOW.getTime() + 86_400_000));
    const tomorrow = await runCron();

    expect(refreshedIds()).toEqual(rest);
    expect(tomorrow.summary.freeRefresh).toEqual({ ...NO_FREE_REFRESH, due: 50, refreshed: 50 });
  });

  it("a paid workspace's connection is fanned out as now", async () => {
    vi.stubEnv("BILLING_ENABLED", "true");
    add("conn-paid", { workspace: PAID_WS });
    add("conn-free");

    const { summary, step } = await runCron();

    expect(fannedOut(step)).toEqual(["conn-paid"]);
    expect((step.sendEvent.mock.calls[0][1] as SentEvent[])[0].id).toBe("refresh-conn-paid-2026-11-01");
    expect(refreshedIds()).toEqual(["conn-free"]);
    expect(summary.connections).toBe(1);
    expect(summary.freeRefresh).toEqual({ ...NO_FREE_REFRESH, due: 1, refreshed: 1 });
  });

  // R10-security M1: the page reads planPaidAt with the plan columns, and only a paid invoice keeps the fan-out.
  it("a paid workspace (planPaidAt set) is fanned out; a trialing one and an active one not yet paid are refreshed inline", async () => {
    vi.stubEnv("BILLING_ENABLED", "true");
    expect(SWEEP_PAGE_SELECT.workspace.select).toMatchObject({ planPaidAt: true });
    add("conn-paid", { workspace: PAID_WS });
    add("conn-trialing", {
      workspace: { ...PAID_WS, planStatus: "trialing", trialEndsAt: new Date(NOW.getTime() + 5 * 86_400_000), planPaidAt: null },
    });
    add("conn-unpaid", { workspace: { ...PAID_WS, planPaidAt: null } });

    const { step } = await runCron();

    expect(fannedOut(step)).toEqual(["conn-paid"]);
    expect(refreshedIds()).toEqual(["conn-trialing", "conn-unpaid"]);
  });

  it("a grandfathered workspace's connection is fanned out", async () => {
    add("conn-exempt", { workspace: { ...FREE_WS, billingExempt: true } });

    const { step } = await runCron();

    expect(fannedOut(step)).toEqual(["conn-exempt"]);
    expect(refreshConnectionTokenMock).not.toHaveBeenCalled();
    expect(step.order).not.toContain("run:refresh-free-connections");
  });

  it("the operator's client workspace is fanned out (billing off), a stranger's is refreshed inline", async () => {
    vi.stubEnv("ADMIN_EMAILS", "operator@example.com");
    add("conn-client", {
      workspace: { ...FREE_WS, members: [{ user: { email: "operator@example.com", emailVerifiedAt: NOW } }] },
    });
    add("conn-stranger");

    const { step } = await runCron();

    expect(fannedOut(step)).toEqual(["conn-client"]);
    expect(refreshedIds()).toEqual(["conn-stranger"]);
  });

  it("each refresh catches its own failure: a blip or a database error does not stop the next one", async () => {
    add("conn-a");
    add("conn-b");
    add("conn-c");
    refresher.mockImplementation(async (conn: Row) => {
      if (conn.id === "conn-a") throw Object.assign(new Error("timeout"), { code: "TIKTOK_TOKEN_REFRESH_FAILED" });
      const row = rows.get(conn.id)!;
      row.expiresAt = new Date(Date.now() + 86_400_000);
      return row;
    });
    const read = findUniqueMock.getMockImplementation()!;
    findUniqueMock.mockImplementation(async (args: { where: { id: string } }) => {
      if (args.where.id === "conn-b") throw new Error("connection reset");
      return read(args);
    });

    const { summary } = await runCron();

    expect(refreshedIds()).toEqual(["conn-a", "conn-c"]);
    expect(summary.freeRefresh).toEqual({ ...NO_FREE_REFRESH, due: 3, refreshed: 1, failed: 2 });
    expect(rows.get("conn-a")!.needsReconnect).toBe(false);
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it("a reconnect email that cannot be sent now does not fail the step; the notices step sends it", async () => {
    add("conn-a");
    add("conn-b");
    refresher.mockImplementation(async (conn: Row) => {
      const row = rows.get(conn.id)!;
      if (conn.id === "conn-a") {
        row.needsReconnect = true;
        throw Object.assign(new Error("revoked"), { code: "TIKTOK_RECONNECT_REQUIRED" });
      }
      row.expiresAt = new Date(Date.now() + 86_400_000);
      return row;
    });
    sendEmailMock.mockRejectedValue(new EmailRetryableError("Resend send failed (status 500)"));

    const { summary, step } = await runCron();

    expect(summary.freeRefresh).toEqual({ ...NO_FREE_REFRESH, due: 2, refreshed: 1, flagged: 1 });
    expect(updateManyMock).not.toHaveBeenCalled();
    expect(step.order[step.order.length - 1]).toBe("run:connection-notices");
  });

  it("stops starting refreshes when the step's time budget is spent; the rest wait for tomorrow", async () => {
    for (const id of ["conn-1", "conn-2", "conn-3", "conn-4", "conn-5", "conn-6"]) add(id);
    // Each refresh takes 60 s: they start at 0, 60, 120 and 180 s of the 200 s.
    refresher.mockImplementation(async (conn: Row) => {
      vi.setSystemTime(new Date(Date.now() + 60_000));
      const row = rows.get(conn.id)!;
      row.expiresAt = new Date(Date.now() + 86_400_000);
      return row;
    });

    const { summary } = await runCron();

    expect(refreshedIds()).toEqual(["conn-1", "conn-2", "conn-3", "conn-4"]);
    expect(summary.freeRefresh).toEqual({ ...NO_FREE_REFRESH, due: 6, refreshed: 4, leftForTomorrow: 2 });
  });

  // Coordinator's review: failing connections keep their old expiresAt, so by
  // expiry alone they would come first every day; they run after the healthy
  // ones. R11-publishing L2: but they keep places in the cap, so more healthy
  // ones due than the cap never leave them out for good.
  it("3 connections whose last refresh failed and 100 healthy ones due: the 3 first, then 97 healthy", async () => {
    for (let i = 0; i < 3; i++) {
      add(`bad-${i}`, { expiresAt: new Date(NOW.getTime() - 30 * 86_400_000), refreshFailedAt: new Date(NOW.getTime() - 86_400_000) });
    }
    for (let i = 0; i < 100; i++) add(`ok-${String(i).padStart(3, "0")}`);

    const { summary } = await runCron();

    expect(refreshedIds()).toHaveLength(100);
    expect(refreshedIds().slice(0, 3)).toEqual(["bad-0", "bad-1", "bad-2"]);
    expect(refreshedIds().slice(3).every((id) => id.startsWith("ok-"))).toBe(true);
    expect(summary.freeRefresh).toEqual({ ...NO_FREE_REFRESH, due: 103, refreshed: 100, leftForTomorrow: 3 });
  });

  // Coordinator, round 11: the sweep's candidates carry failedAt, so within
  // their 10 places failed ones go oldest failure first and take turns.
  it("15 failing over two days: the 10 oldest failures on day one, the other 5 first on day two", async () => {
    // bad-14 failed longest ago, bad-00 most recently; all expired long ago.
    for (let i = 0; i < 15; i++) {
      add(`bad-${String(i).padStart(2, "0")}`, {
        expiresAt: new Date(NOW.getTime() - (30 - i) * 86_400_000),
        refreshFailedAt: new Date(NOW.getTime() - (i + 1) * 3_600_000),
      });
    }
    for (let i = 0; i < 200; i++) add(`ok-${String(i).padStart(3, "0")}`);
    const bad = () => refreshedIds().filter((id) => id.startsWith("bad-"));

    await runCron();
    const dayOne = bad();
    expect(dayOne).toEqual(["bad-14", "bad-13", "bad-12", "bad-11", "bad-10", "bad-09", "bad-08", "bad-07", "bad-06", "bad-05"]);

    // They fail again: a new failure time, expiry unchanged.
    for (const id of dayOne) {
      const row = rows.get(id)!;
      row.expiresAt = new Date(NOW.getTime() - 30 * 86_400_000);
      row.refreshFailedAt = new Date(NOW.getTime() + 60_000);
    }
    refreshConnectionTokenMock.mockClear();
    await runCron();
    expect(bad().slice(0, 5)).toEqual(["bad-04", "bad-03", "bad-02", "bad-01", "bad-00"]);
  });

  // R11 review: the reserved failed ones run first, in their own 40 s share,
  // so a slow day never leaves them out and hanging ones never eat the rest.
  describe("the failed ones' share of the step's time", () => {
    /** Each call's start and deadline (ms after NOW), as the refresher saw them. */
    const seen: Array<{ id: string; at: number; deadline: number }> = [];
    const timed = (takes: (id: string, deadline: number) => number) =>
      refresher.mockImplementation(async (conn: Row, options?: { deadline?: number }) => {
        const deadline = options?.deadline ?? Number.POSITIVE_INFINITY;
        seen.push({ id: conn.id, at: Date.now() - NOW.getTime(), deadline: deadline - NOW.getTime() });
        vi.setSystemTime(new Date(Date.now() + takes(conn.id, deadline)));
        if (conn.id.startsWith("bad-")) throw Object.assign(new Error("timeout"), { code: "TIKTOK_TOKEN_REFRESH_FAILED" });
        const row = rows.get(conn.id)!;
        row.expiresAt = new Date(Date.now() + 86_400_000);
        return row;
      });
    beforeEach(() => {
      seen.length = 0;
    });

    it("90 healthy at 2.2 s + 1 failed: the failed one is tried today, first", async () => {
      add("bad-0", { expiresAt: new Date(NOW.getTime() - 30 * 86_400_000), refreshFailedAt: new Date(NOW.getTime() - 86_400_000) });
      for (let i = 0; i < 90; i++) add(`ok-${String(i).padStart(3, "0")}`);
      timed(() => 2_200);

      await runCron();

      expect(seen[0]).toEqual({ id: "bad-0", at: 0, deadline: 40_000 });
      expect(seen[1]).toMatchObject({ id: "ok-000", at: 2_200, deadline: 200_000 });
    });

    it("10 failed that each hang: they stop at 40 s, and the healthy still get the 160 s after", async () => {
      for (let i = 0; i < 10; i++) {
        add(`bad-${i}`, { expiresAt: new Date(NOW.getTime() - 30 * 86_400_000), refreshFailedAt: new Date(NOW.getTime() - (i + 1) * 3_600_000) });
      }
      for (let i = 0; i < 90; i++) add(`ok-${String(i).padStart(3, "0")}`);
      // A hang lasts until its deadline; a healthy refresh takes 1 s.
      timed((id, deadline) => (id.startsWith("bad-") ? deadline - Date.now() : 1_000));

      const { summary } = await runCron();

      const bad = seen.filter((call) => call.id.startsWith("bad-"));
      expect(bad).toEqual([{ id: "bad-9", at: 0, deadline: 40_000 }]);
      const healthy = seen.filter((call) => call.id.startsWith("ok-"));
      expect(healthy[0]).toMatchObject({ at: 40_000, deadline: 200_000 });
      expect(healthy).toHaveLength(90);
      expect(summary.freeRefresh).toMatchObject({ refreshed: 90, failed: 1, leftForTomorrow: 9 });
    });

    it("no failed ones: the healthy ones get the whole 200 s", async () => {
      for (let i = 0; i < 5; i++) add(`ok-${i}`);
      timed(() => 1_000);

      await runCron();

      expect(seen[0]).toEqual({ id: "ok-0", at: 0, deadline: 200_000 });
    });
  });

  it("a refresh that fails without flagging records refreshFailedAt (not the flag), so it goes last next time", async () => {
    add("conn-a");
    refresher.mockImplementation(async () => {
      throw Object.assign(new Error("timeout"), { code: "TIKTOK_TOKEN_REFRESH_FAILED" });
    });

    const { summary } = await runCron();

    expect(summary.freeRefresh).toEqual({ ...NO_FREE_REFRESH, due: 1, failed: 1 });
    expect(updateManyMock).toHaveBeenCalledWith({
      where: { id: "conn-a", needsReconnect: false },
      data: { refreshFailedAt: NOW },
    });
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  // Coordinator's review: a sweep that started before this release memoized its
  // pages as plain id lists; on the new code they are fanned out, as they were.
  it("a page output in the old shape (a plain id list) is fanned out, not thrown on", async () => {
    add("conn-1");
    const step = fakeStep();
    const run = step.run.getMockImplementation()!;
    step.run.mockImplementation(async (id: string, cb: () => unknown) => {
      if (id === "page-0") {
        step.order.push(`run:${id}`);
        return ["conn-old-1", "conn-old-2"];
      }
      return run(id, cb);
    });

    const { summary } = await runCron(step);

    expect(fannedOut(step)).toEqual(["conn-old-1", "conn-old-2"]);
    expect((step.sendEvent.mock.calls[0][1] as SentEvent[])[0].id).toBe("refresh-conn-old-1-2026-11-01");
    expect(findManyMock).not.toHaveBeenCalled();
    expect(refreshConnectionTokenMock).not.toHaveBeenCalled();
    expect(summary.connections).toBe(2);
    expect(summary.pages).toBe(1);
  });

  it("a connection refreshed elsewhere since the page was read is left alone", async () => {
    add("conn-1");
    const page = findManyMock.getMockImplementation()!;
    findManyMock.mockImplementation(async (args: never) => {
      const out = await page(args);
      // A publish refreshes it between the page and the step.
      rows.get("conn-1")!.expiresAt = new Date(NOW.getTime() + 2 * 86_400_000);
      return out;
    });

    const { summary } = await runCron();

    expect(refreshConnectionTokenMock).not.toHaveBeenCalled();
    expect(summary.freeRefresh).toEqual({ ...NO_FREE_REFRESH, due: 1, unchanged: 1 });
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
    lastRefreshErrorCode: null,
    refreshFailedAt: null,
    reconnectEmailedAt: null,
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
    expect(step.order).toEqual(["run:refresh", "run:notify-day", "run:notify-owners"]);
    expect(sendEmailMock).toHaveBeenCalledTimes(2);
    expect(sendEmailMock.mock.calls.map((c) => c[0].to)).toEqual([
      "owner-a@example.com",
      "owner-b@example.com",
    ]);
    // The email names the platform and the workspace.
    expect(sendEmailMock.mock.calls[0][0].subject).toContain("TikTok");
    expect(JSON.stringify(sendEmailMock.mock.calls[0][0])).toContain("Acme");
    expect(workspaceFindUniqueMock).toHaveBeenCalledWith({ where: { id: "ws-1" }, select: { name: true, pausedAt: true, pausedReason: true } });
    expect(membersFindManyMock).toHaveBeenCalledWith({
      where: { workspaceId: "ws-1", role: "owner" },
      select: { user: { select: { id: true, email: true } } },
    });
    // Recorded, so the sweep's notices step does not send it again.
    expect(updateManyMock).toHaveBeenCalledWith({
      where: { id: "conn-1", needsReconnect: true },
      data: { reconnectEmailedAt: NOW },
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

  // 2026-11-02 scale audit (jobs, notifications): the UTC day in the key comes from
  // the memoized `notify-day` step, so a retry of `notify-owners` after midnight UTC
  // builds the same key and Resend still treats it as a no-op for owners emailed.
  it("FLAGGED: notify-day is memoized before notify-owners and its day builds the key, even if the clock moved to the next UTC day", async () => {
    clientWith(async () => {
      row = { ...row!, needsReconnect: true };
      throw Object.assign(new Error("expired"), { code: "TIKTOK_RECONNECT_REQUIRED" });
    });
    const step = fakeStep();
    const runStep = step.run.getMockImplementation()!;
    step.run.mockImplementation(async (id, cb) => {
      // A retry that re-enters the function after UTC midnight: the memoized
      // `notify-day` output is replayed ("2026-11-01"), its callback is not run.
      if (id === "notify-day") {
        step.order.push(`run:${id}`);
        vi.setSystemTime(new Date("2026-11-02T00:00:30.000Z"));
        return "2026-11-01";
      }
      return runStep(id, cb);
    });

    const { result } = await run(step);

    expect(step.order).toEqual(["run:refresh", "run:notify-day", "run:notify-owners"]);
    expect(result.emailed).toBe(2);
    expect(sendEmailMock.mock.calls.map((c) => c[1].idempotencyKey)).toEqual([
      "reconnect/conn-1/2026-11-01/user-a",
      "reconnect/conn-1/2026-11-01/user-b",
    ]);
  });

  it("FLAGGED: notify-day computes the UTC date of the run (ISO date, no time)", async () => {
    clientWith(async () => {
      row = { ...row!, needsReconnect: true };
      throw new Error("expired");
    });

    const { step } = await run();

    expect(step.outputs["notify-day"]).toBe("2026-11-01");
  });

  it("notify-day runs only when the connection was flagged", async () => {
    clientWith(async (conn) => conn);

    const { step } = await run();

    expect(step.order).toEqual(["run:refresh"]);
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

  // R5-publishing M1: a connection flagged by a failed post is never refreshed;
  // its reconnect email comes from the sweep's connection-notices step instead.
  it("ALREADY FLAGGED: no refresher call and no email (the notices step sends it)", async () => {
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
