import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The daily caps across workspaces, against an in-memory copy of the tables
 * they read (R6 review of K2), so a sequence of sends, retries and deletions
 * is counted the way the database would count it.
 */

type Row = Record<string, unknown>;
type Owner = { userId: string; user: { email: string; name?: string; emailVerifiedAt: Date | null; createdAt: Date } };
type Workspace = Row & { id: string; owners: Owner[] };

const store = vi.hoisted(() => ({
  /** Every usage read throws while set: the checks must fail open. */
  down: false,
  events: [] as Record<string, unknown>[],
  /** The transaction locks taken: the SQL and the key. */
  locks: [] as Array<{ sql: string; key: unknown }>,
  posts: [] as Record<string, unknown>[],
  /** Results per post (R8-publishing L3: the retry sentence), and the platforms that need reconnecting. */
  results: {} as Record<string, Array<{ platform: string; status: string; errorCode: string | null }>>,
  deadPlatforms: [] as string[],
  /** RateLimitEntry rows by key (the once-a-day emails). */
  limits: new Map<string, number>(),
  /** User.timeZone by user id. */
  timeZones: {} as Record<string, string>,
  workspaces: [] as Array<Record<string, unknown> & { id: string; owners: Array<{ userId: string; user: unknown }> }>,
}));

const sendEmailMock = vi.hoisted(() => vi.fn());
vi.mock("@/server/notifications/email", () => ({ sendEmail: sendEmailMock }));

function comparable(value: unknown): unknown {
  return value instanceof Date ? value.getTime() : value;
}

/** The subset of Prisma's where clauses the counting code uses. */
function matches(row: Row, where: Row | undefined): boolean {
  for (const [key, cond] of Object.entries(where ?? {})) {
    if (key === "OR") {
      if (!(cond as Row[]).some((branch) => matches(row, branch))) return false;
      continue;
    }
    const value = row[key];
    if (cond === null) {
      if (value !== null && value !== undefined) return false;
      continue;
    }
    if (typeof cond === "object" && !(cond instanceof Date)) {
      const c = cond as Row;
      if ("in" in c && !(c.in as unknown[]).includes(value)) return false;
      if ("notIn" in c && (c.notIn as unknown[]).includes(value)) return false;
      if ("not" in c && value === c.not) return false;
      if ("gte" in c && !((comparable(value) as number) >= (comparable(c.gte) as number))) return false;
      if ("lt" in c && !((comparable(value) as number) < (comparable(c.lt) as number))) return false;
      if ("startsWith" in c && !(typeof value === "string" && value.startsWith(c.startsWith as string))) return false;
      if ("has" in c && !(Array.isArray(value) && value.includes(c.has))) return false;
      continue;
    }
    if (comparable(value) !== comparable(cond)) return false;
  }
  return true;
}

const BILLING_KEYS = ["billingExempt", "plan", "planStatus", "trialEndsAt", "currentPeriodEnd"];
const billing = (workspace: Row) => Object.fromEntries(BILLING_KEYS.filter((k) => k in workspace).map((k) => [k, workspace[k]]));

vi.mock("@/lib/db", () => {
  const usageEvent = {
    create: async ({ data }: { data: Row }) => {
      if (store.events.some((event) => event.sourceId === data.sourceId)) throw new Error("Unique constraint failed");
      store.events.push({ createdAt: new Date(), pool: null, ownerIds: [], ...data });
      return data;
    },
    createMany: async ({ data, skipDuplicates }: { data: Row[]; skipDuplicates?: boolean }) => {
      let count = 0;
      for (const row of data) {
        if (store.events.some((event) => event.sourceId === row.sourceId)) {
          if (!skipDuplicates) throw new Error("Unique constraint failed");
          continue;
        }
        store.events.push({ createdAt: new Date(), pool: null, ownerIds: [], ...row });
        count += 1;
      }
      return { count };
    },
    count: async ({ where }: { where: Row }) => {
      if (store.down) throw new Error("db down");
      return store.events.filter((event) => matches(event, where)).length;
    },
    findMany: async ({ where }: { where: Row }) => {
      if (store.down) throw new Error("db down");
      return store.events.filter((event) => matches(event, where));
    },
    groupBy: async ({ by, where }: { by: string[]; where: Row }) => {
      if (store.down) throw new Error("db down");
      const counts = new Map<string, { key: Row; n: number }>();
      for (const event of store.events.filter((e) => matches(e, where))) {
        const key = Object.fromEntries(by.map((field) => [field, event[field] ?? null]));
        const id = JSON.stringify(key);
        counts.set(id, { key, n: (counts.get(id)?.n ?? 0) + 1 });
      }
      return [...counts.values()].map(({ key, n }) => ({ ...key, _count: { _all: n } }));
    },
    updateMany: async ({ where, data }: { where: Row; data: Row }) => {
      const hit = store.events.filter((event) => matches(event, where));
      for (const event of hit) Object.assign(event, data);
      return { count: hit.length };
    },
    deleteMany: async ({ where }: { where: Row }) => {
      const before = store.events.length;
      store.events = store.events.filter((event) => !matches(event, where));
      return { count: before - store.events.length };
    },
  };
  // The transaction locks (pg_advisory_xact_lock): a post's (its id) and the
  // service-wide one (no argument): a second transaction asking for the same
  // key waits until the first ends. The transaction reads and writes the same
  // tables as the client.
  const held = new Map<string, Promise<void>>();
  let client: Record<string, unknown> = {};
  const $transaction = async <T>(work: (tx: unknown) => Promise<T>): Promise<T> => {
    const releases: Array<() => void> = [];
    const tx = {
      ...client,
      $executeRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
        const key = values.length > 0 ? String(values[0]) : "service";
        store.locks.push({ sql: strings.join("?"), key });
        const before = held.get(key) ?? Promise.resolve();
        let release!: () => void;
        const mine = new Promise<void>((resolve) => (release = resolve));
        held.set(key, before.then(() => mine));
        releases.push(release);
        await before;
        return 1;
      },
    };
    try {
      return await work(tx);
    } finally {
      for (const release of releases) release();
    }
  };
  client = {
      usageEvent,
      postJob: {
        findMany: async ({ where }: { where: Row }) => store.posts.filter((post) => matches(post, where)),
      },
      postJobResult: {
        findMany: async ({ where }: { where: { postJobId?: string; status?: string } }) =>
          where.postJobId ? (store.results[where.postJobId] ?? []).filter((row) => row.status === where.status) : [],
      },
      socialConnection: {
        findMany: async ({ where }: { where: { platform: { in: string[] } } }) =>
          where.platform.in.map((platform) => ({ platform, needsReconnect: store.deadPlatforms.includes(platform) })),
      },
      rateLimitEntry: {
        upsert: async ({ where }: { where: { key: string } }) => {
          const count = (store.limits.get(where.key) ?? 0) + 1;
          store.limits.set(where.key, count);
          return { key: where.key, count };
        },
        deleteMany: async ({ where }: { where: { key: string } }) => ({ count: store.limits.delete(where.key) ? 1 : 0 }),
      },
      user: {
        findUnique: async ({ where }: { where: { id: string } }) => ({ timeZone: store.timeZones[where.id] ?? null }),
        findMany: async ({ where }: { where: { id: { in: string[] } } }) => {
          const users = new Map<string, unknown>();
          for (const w of store.workspaces) {
            for (const o of w.owners) users.set(o.userId, { id: o.userId, email: (o.user as { email: string }).email });
          }
          return where.id.in.filter((id) => users.has(id)).map((id) => users.get(id));
        },
      },
      workspaceMember: {
        findMany: async ({ where }: { where: { workspaceId?: string; userId?: string } }) =>
          where.workspaceId
            ? (store.workspaces.find((w) => w.id === where.workspaceId)?.owners ?? [])
            : store.workspaces
                .filter((w) => w.owners.some((owner) => owner.userId === where.userId))
                .map((w) => ({ workspace: { id: w.id, ...billing(w) } })),
      },
      workspace: {
        findUnique: async ({ where }: { where: { id: string } }) => {
          const found = store.workspaces.find((w) => w.id === where.id);
          return found ? billing(found) : null;
        },
        findMany: async ({ where }: { where: { id: { in: string[] } } }) =>
          store.workspaces
            .filter((w) => where.id.in.includes(w.id))
            .map((w) => ({ id: w.id, ...billing(w), members: w.owners.map((owner) => ({ user: owner.user })) })),
      },
  };
  return { prisma: { $transaction, ...client } };
});


import {
  copyUsageBeforeDeletion,
  crossWorkspacePostRefusal,
  ownersPersonalUsage,
  recordRetry,
  recordSend,
  reserveRetry,
  retryRefusal,
  sendRecorded,
  reserveFreeRuns,
  withdrawRetry,
  withdrawSend,
} from "./usageLog";

const DAY_1 = new Date("2026-11-13T12:00:00.000Z");
const NOW = new Date("2026-11-14T15:00:00.000Z");
const LONG_AGO = new Date("2026-10-01T00:00:00Z");
const DAY = 24 * 60 * 60 * 1000;

const owner = (userId: string, overrides: Partial<Owner["user"]> = {}): Owner => ({
  userId,
  user: { email: `${userId}@example.com`, emailVerifiedAt: LONG_AGO, createdAt: LONG_AGO, ...overrides },
});
/** Signed up an hour ago (14:00 UTC on the 14th) and confirmed: still a new account. */
const fresh = (userId: string) => owner(userId, { createdAt: new Date(NOW.getTime() - 3_600_000), emailVerifiedAt: NOW });
const OPS = owner("ops", { email: "ops@example.com" });
const PAID = { billingExempt: false, plan: "growth", planStatus: "active", currentPeriodEnd: new Date("2026-12-10T00:00:00Z") };

function workspace(id: string, fields: Row = {}, owners: Owner[] = [owner(`owner-of-${id}`)]): Workspace {
  const row = { id, billingExempt: false, ...fields, owners };
  store.workspaces.push(row);
  return row;
}

let othersSent = 0;

/** `n` more runs of free workspaces that other confirmed people sent on `at`'s day, 15 each (main pool: 20). */
async function sentElsewhere(n: number, at: Date) {
  for (let i = 0; i < n; i += 1) {
    othersSent += 1;
    const id = `ws-others-${Math.ceil(othersSent / 15)}`;
    if (!store.workspaces.some((w) => w.id === id)) workspace(id);
    await recordSend({ workspaceId: id, postJobIds: [`other-${othersSent}`], at });
  }
}

/** One post due in `workspaceId` at `at`: reserved as the scanner does (written when allowed); the refusal or null. */
async function due(workspaceId: string, postJobId: string, at: Date = NOW): Promise<string | null> {
  const reservation = await reserveFreeRuns({ workspaceId, postJobIds: [postJobId], at, check: "atSend" });
  return reservation.ok ? null : reservation.refusal.error;
}

/** The scanner's check alone: reserved, then taken back, so nothing stays written. */
async function atSendCheck(workspaceId: string, postJobIds: string[], at: Date = NOW): Promise<{ errorMessage: string } | null> {
  const reservation = await reserveFreeRuns({ workspaceId, postJobIds, at, check: "atSend" });
  if (!reservation.ok) return { errorMessage: reservation.refusal.error };
  await withdrawSend({ postJobIds: reservation.written, day: at });
  return null;
}

const runsIn = (pool: string | null) => store.events.filter((event) => event.kind === "send" && event.pool === pool).length;
const sendsOf = (postJobId: string) =>
  store.events.filter((event) => event.kind === "send" && String(event.sourceId).startsWith(`send:${postJobId}:`));

const LEAVE_SMALL_POOL = "It stops applying from the day after the account was made (00:00 UTC), once the owner's email address is confirmed.";
const FULL_AT_SEND =
  "Not sent: Vibe Socials had reached its daily limit of posts for the whole service when this post was due. Retry it tomorrow, or schedule it again.";
const SMALL_POOL_AT_SEND = `Not sent: Vibe Socials had reached the day's limit of 5 posts shared by accounts made today (UTC) or with an unconfirmed email address when this post was due. Retry it tomorrow, or schedule it again. ${LEAVE_SMALL_POOL}`;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  store.events = [];
  store.locks = [];
  store.posts = [];
  store.workspaces = [];
  store.down = false;
  store.results = {};
  store.deadPlatforms = [];
  store.limits = new Map();
  store.timeZones = {};
  sendEmailMock.mockReset();
  sendEmailMock.mockResolvedValue(undefined);
  othersSent = 0;
  vi.stubEnv("BILLING_ENABLED", "");
  vi.stubEnv("ADMIN_EMAILS", "ops@example.com");
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

// R7-security M1 (a): new accounts draw from their own small pool.
describe("new and unconfirmed accounts have a pool of their own", () => {
  it("8 fresh accounts at 5 each: 5 runs go, the main pool is untouched, and a 9th fresh account is refused", async () => {
    const outcomes: Array<string | null> = [];
    for (let a = 1; a <= 8; a += 1) {
      workspace(`ws-fresh-${a}`, {}, [a % 2 ? fresh(`fresh-${a}`) : owner(`unconfirmed-${a}`, { emailVerifiedAt: null })]);
      for (let p = 1; p <= 5; p += 1) outcomes.push(await due(`ws-fresh-${a}`, `fresh-${a}-${p}`));
    }
    expect(outcomes.filter((outcome) => outcome === null)).toHaveLength(5);
    expect(outcomes.filter((outcome) => outcome === SMALL_POOL_AT_SEND)).toHaveLength(35);
    expect(runsIn("new")).toBe(5);
    expect(runsIn("main")).toBe(0);

    workspace("ws-fresh-9", {}, [fresh("fresh-9")]);
    await expect(due("ws-fresh-9", "fresh-9-1")).resolves.toBe(SMALL_POOL_AT_SEND);

    // Confirmed customers still have the whole main pool: all 20 go today.
    await sentElsewhere(19, NOW);
    workspace("ws-customer", {}, [owner("customer")]);
    await expect(due("ws-customer", "c-1")).resolves.toBeNull();
    expect(runsIn("main")).toBe(20);
  });

  it("a full main pool never refuses a new account, and a full small pool never refuses a confirmed one", async () => {
    workspace("ws-fresh", {}, [fresh("fresh-1")]);
    workspace("ws-customer", {}, [owner("customer")]);
    await sentElsewhere(20, NOW);
    for (let p = 1; p <= 5; p += 1) await expect(due("ws-fresh", `f-${p}`)).resolves.toBeNull();
    expect(runsIn("new")).toBe(5);
    // The customer's first run of the day goes on their guaranteed share.
    await expect(due("ws-customer", "c-1")).resolves.toBeNull();
  });

  it("a workspace with one confirmed, day-old owner uses the main pool even with a new co-owner", async () => {
    workspace("ws-team", {}, [owner("lead"), fresh("new-hire")]);
    await due("ws-team", "t-1");
    expect(store.events[0]).toMatchObject({ pool: "main", ownerIds: ["lead", "new-hire"] });
  });

  // R8-new-customer M1: the pools and the per-person number use one definition.
  it("an account made yesterday evening uses the main pool from 00:00 UTC, under a day old or not", async () => {
    const signup = new Date("2026-11-13T18:00:00Z");
    workspace("ws-a", {}, [owner("a", { createdAt: signup, emailVerifiedAt: signup })]);
    await due("ws-a", "a-0", new Date("2026-11-13T21:00:00Z"));
    await due("ws-a", "a-1", new Date("2026-11-14T10:00:00Z"));
    await due("ws-a", "a-2", new Date("2026-11-14T19:00:00Z"));
    expect(store.events.map((event) => event.pool)).toEqual(["new", "main", "main"]);
  });

  it("Post now and scheduling for today meet the small pool too, with their own sentences", async () => {
    workspace("ws-fresh", {}, [fresh("fresh-1")]);
    workspace("ws-fresh-3", {}, [fresh("fresh-3")]);
    for (let p = 1; p <= 5; p += 1) await due("ws-fresh", `f-${p}`);
    expect((await crossWorkspacePostRefusal({ workspaceId: "ws-fresh-3", workspace: {}, day: NOW, mode: "now" }))?.error).toBe(
      `Vibe Socials has reached today's limit of 5 posts shared by accounts made today (UTC) or with an unconfirmed email address. Schedule this post for another day, or try again tomorrow. ${LEAVE_SMALL_POOL}`,
    );
    expect(
      (await crossWorkspacePostRefusal({ workspaceId: "ws-fresh-3", workspace: {}, day: NOW, mode: "schedule" }))?.code,
    ).toBe("SERVICE_DAILY_POST_LIMIT");
    // Nothing has gone out on a later day yet.
    await expect(
      crossWorkspacePostRefusal({ workspaceId: "ws-fresh-3", workspace: {}, day: new Date(NOW.getTime() + 2 * DAY), mode: "schedule" }),
    ).resolves.toBeNull();
  });
});

// R7-security M1 (b): a share of the main pool nobody else can take.
describe("each confirmed person's first 3 runs a day", () => {
  it("main pool used up: a confirmed customer's first 3 runs still go, the 4th is refused", async () => {
    workspace("ws-customer", {}, [owner("customer")]);
    await sentElsewhere(20, NOW);
    const outcomes = [];
    for (let p = 1; p <= 4; p += 1) outcomes.push(await due("ws-customer", `c-${p}`));
    expect(outcomes).toEqual([null, null, null, FULL_AT_SEND]);
    // They still count in the pool.
    expect(runsIn("main")).toBe(23);
  });

  it("a customer who used 3 earlier in the day, while the pool had room, gets no more once it is full", async () => {
    workspace("ws-customer", {}, [owner("customer")]);
    for (let p = 1; p <= 3; p += 1) await due("ws-customer", `c-${p}`);
    await sentElsewhere(17, NOW);
    await expect(due("ws-customer", "c-4")).resolves.toBe(FULL_AT_SEND);
  });

  it("a pair needs both places inside the share: 2 used, the pair is refused once the pool is full", async () => {
    workspace("ws-customer", {}, [owner("customer")]);
    await sentElsewhere(20, NOW);
    await due("ws-customer", "c-1");
    await expect(
      atSendCheck("ws-customer", ["feed", "story"]),
    ).resolves.toBeNull();
    await due("ws-customer", "c-2");
    expect(
      (await atSendCheck("ws-customer", ["feed", "story"]))?.errorMessage,
    ).toBe(FULL_AT_SEND);
  });

  it("a co-owned workspace goes while any of its confirmed owners has a guaranteed run left", async () => {
    workspace("ws-busy", {}, [owner("busy")]);
    workspace("ws-shared", {}, [owner("busy"), owner("quiet")]);
    for (let p = 1; p <= 3; p += 1) await due("ws-busy", `b-${p}`);
    await sentElsewhere(17, NOW);
    await expect(due("ws-busy", "b-4")).resolves.toBe(FULL_AT_SEND);
    await expect(due("ws-shared", "s-1")).resolves.toBeNull();
  });

  it("the share starts again on the next UTC day", async () => {
    workspace("ws-customer", {}, [owner("customer")]);
    for (let p = 1; p <= 3; p += 1) await due("ws-customer", `c-${p}`, DAY_1);
    await sentElsewhere(20, NOW);
    await expect(due("ws-customer", "c-4")).resolves.toBeNull();
  });
});

// R7-security M1 (c) and (d): 15 a day, counted toward the owners at the time of the run.
describe("the per-person number", () => {
  function scheduled(workspaceId: string, n: number, at: Date = NOW) {
    for (let i = 0; i < n; i += 1) {
      store.posts.push({ id: `${workspaceId}-s-${i}-${at.getTime()}`, workspaceId, status: "scheduled", scheduledFor: at, createdAt: LONG_AGO });
    }
  }

  it("counts runs today and posts still to go today across owned free workspaces, and refuses the 16th", async () => {
    workspace("ws-1", {}, [owner("owner-1")]);
    workspace("ws-2", {}, [owner("owner-1")]);
    for (let p = 1; p <= 8; p += 1) await due("ws-1", `a-${p}`);
    scheduled("ws-2", 6, new Date("2026-11-14T20:00:00Z"));
    await expect(crossWorkspacePostRefusal({ workspaceId: "ws-1", workspace: {}, day: NOW, mode: "now" })).resolves.toBeNull();
    await due("ws-2", "b-1");
    await expect(crossWorkspacePostRefusal({ workspaceId: "ws-1", workspace: {}, day: NOW, mode: "now" })).resolves.toEqual({
      code: "OWNER_DAILY_POST_LIMIT",
      error:
        "This workspace's owner has reached the limit of 15 posts a day across all the workspaces they own, and retries count toward it. Schedule this post for another day, or try again tomorrow.",
    });
    // Tomorrow has nothing yet.
    await expect(
      crossWorkspacePostRefusal({ workspaceId: "ws-1", workspace: {}, day: new Date(NOW.getTime() + DAY), mode: "schedule" }),
    ).resolves.toBeNull();
  });

  it("15 scheduled on a day's calendar: the 16th is refused with the calendar sentence", async () => {
    workspace("ws-1", {}, [owner("owner-1")]);
    const day = new Date("2026-11-18T10:00:00Z");
    scheduled("ws-1", 15, day);
    await expect(crossWorkspacePostRefusal({ workspaceId: "ws-1", workspace: {}, day, mode: "schedule" })).resolves.toEqual({
      code: "OWNER_DAILY_POST_LIMIT",
      error:
        "That day already has 15 posts across all the workspaces this workspace's owner owns, which is the daily limit for one person (retries count toward it). Pick another day.",
    });
  });

  it("a post due 23:55 that has not gone out yet counts on its own day, not the next", async () => {
    workspace("ws-1", {}, [owner("owner-1")]);
    const nextDay = new Date("2026-11-15T12:00:00Z");
    scheduled("ws-1", 14, nextDay);
    scheduled("ws-1", 1, new Date("2026-11-14T23:55:00Z"));
    await expect(crossWorkspacePostRefusal({ workspaceId: "ws-1", workspace: {}, day: nextDay, mode: "schedule" })).resolves.toBeNull();
  });

  it("owner hands a workspace to a co-owner and leaves: their count today is unchanged", async () => {
    const handedOver = workspace("ws-old", {}, [owner("leaver"), owner("heir")]);
    for (let p = 1; p <= 15; p += 1) await due("ws-old", `o-${p}`);
    handedOver.owners = [owner("heir")];
    workspace("ws-new", {}, [owner("leaver")]);
    expect((await crossWorkspacePostRefusal({ workspaceId: "ws-new", workspace: {}, day: NOW, mode: "now" }))?.code).toBe(
      "OWNER_DAILY_POST_LIMIT",
    );
    expect((await retryRefusal({ workspaceId: "ws-new", postJobId: "older", now: NOW }))?.code).toBe("OWNER_DAILY_POST_LIMIT");
    // The heir's count has the same 15: the runs happened while they were an owner too.
    workspace("ws-heir", {}, [owner("heir")]);
    expect((await crossWorkspacePostRefusal({ workspaceId: "ws-heir", workspace: {}, day: NOW, mode: "now" }))?.code).toBe(
      "OWNER_DAILY_POST_LIMIT",
    );
  });

  it("someone made an owner after the runs does not get them on their count", async () => {
    const ws = workspace("ws-1", {}, [owner("first")]);
    for (let p = 1; p <= 15; p += 1) await due("ws-1", `p-${p}`);
    ws.owners = [owner("first"), owner("joined-later")];
    workspace("ws-own", {}, [owner("joined-later")]);
    await expect(crossWorkspacePostRefusal({ workspaceId: "ws-own", workspace: {}, day: NOW, mode: "now" })).resolves.toBeNull();
  });

  it("a deleted workspace's runs keep counting toward its owners", async () => {
    workspace("ws-gone", {}, [owner("owner-1")]);
    workspace("ws-1", {}, [owner("owner-1")]);
    for (let p = 1; p <= 15; p += 1) await due("ws-gone", `g-${p}`);
    await copyUsageBeforeDeletion((await import("@/lib/db")).prisma as never, {
      workspaceIds: ["ws-gone"],
      userId: "owner-1",
      now: NOW,
    });
    store.workspaces = store.workspaces.filter((w) => w.id !== "ws-gone");
    expect((await crossWorkspacePostRefusal({ workspaceId: "ws-1", workspace: {}, day: NOW, mode: "now" }))?.code).toBe(
      "OWNER_DAILY_POST_LIMIT",
    );
  });

  it("an unconfirmed or new owner gets 5, and is told how it rises", async () => {
    workspace("ws-1", {}, [owner("owner-1", { emailVerifiedAt: null })]);
    scheduled("ws-1", 5);
    // Second look, point 1: the owner reads "you"; anyone else reads the owner's name.
    expect(
      (await crossWorkspacePostRefusal({ workspaceId: "ws-1", workspace: {}, day: NOW, mode: "now", viewerUserId: "owner-1" }))?.error,
    ).toBe(
      "This workspace's owner has reached the limit of 5 posts a day across all the workspaces they own, and retries count toward it. Schedule this post for another day, or try again tomorrow. The limit is 15 once you confirm your email address.",
    );
    expect(
      (await crossWorkspacePostRefusal({ workspaceId: "ws-1", workspace: {}, day: NOW, mode: "now", viewerUserId: "a-member" }))?.error,
    ).toBe(
      "This workspace's owner has reached the limit of 5 posts a day across all the workspaces they own, and retries count toward it. Schedule this post for another day, or try again tomorrow. The limit is 15 once owner-1@example.com confirms their email address.",
    );
  });

  // R7 review, point 5: the lower number holds only the UTC day the account was made.
  it("a confirmed account gets 5 on the UTC day it was made and 15 from the next day, said so", async () => {
    workspace("ws-1", {}, [fresh("owner-1")]);
    const tomorrow = new Date("2026-11-15T09:00:00Z");
    scheduled("ws-1", 5, NOW);
    scheduled("ws-1", 5, tomorrow);
    expect((await crossWorkspacePostRefusal({ workspaceId: "ws-1", workspace: {}, day: NOW, mode: "schedule" }))?.error).toBe(
      "That day already has 5 posts across all the workspaces this workspace's owner owns, which is the daily limit for one person (retries count toward it). Pick another day. The limit is 15 from 00:00 UTC tomorrow.",
    );
    // Signed up at 14:00 on the 14th: under a day old on the 15th's morning, but it is a new day.
    await expect(crossWorkspacePostRefusal({ workspaceId: "ws-1", workspace: {}, day: tomorrow, mode: "schedule" })).resolves.toBeNull();
  });

  // R7 review, point 6: a workspace held to 5 by a new co-owner names them.
  it("a confirmed co-owner reads the unconfirmed co-owner's name, twice", async () => {
    workspace("ws-team", {}, [owner("lead"), owner("jane", { name: "Jane", emailVerifiedAt: null })]);
    scheduled("ws-team", 5, NOW);
    expect(
      (await crossWorkspacePostRefusal({ workspaceId: "ws-team", workspace: {}, day: NOW, mode: "now", viewerUserId: "lead" }))?.error,
    ).toBe(
      "Jane, an owner of this workspace, has reached the limit of 5 posts a day across all the workspaces they own, and retries count toward it. Schedule this post for another day, or try again tomorrow. The limit is 15 once Jane confirms their email address.",
    );
  });

  it("a workspace held to 5 by a new or unconfirmed co-owner names that owner", async () => {
    workspace("ws-team", {}, [owner("lead"), owner("maria", { name: "Maria", createdAt: new Date(NOW.getTime() - 3_600_000), emailVerifiedAt: NOW })]);
    scheduled("ws-team", 5, NOW);
    expect((await crossWorkspacePostRefusal({ workspaceId: "ws-team", workspace: {}, day: NOW, mode: "now" }))?.error).toBe(
      "Maria, an owner of this workspace, has reached the limit of 5 posts a day across all the workspaces they own, and retries count toward it. Schedule this post for another day, or try again tomorrow. Their limit is 15 from 00:00 UTC tomorrow.",
    );
  });

  it("an unconfirmed account keeps 5 on every day until it confirms", async () => {
    workspace("ws-1", {}, [owner("owner-1", { emailVerifiedAt: null })]);
    const later = new Date("2026-11-20T09:00:00Z");
    scheduled("ws-1", 5, later);
    expect((await crossWorkspacePostRefusal({ workspaceId: "ws-1", workspace: {}, day: later, mode: "schedule" }))?.code).toBe(
      "OWNER_DAILY_POST_LIMIT",
    );
  });

  it("with billing on, counts a workspace made while billing was off, never a paying one", async () => {
    vi.stubEnv("BILLING_ENABLED", "true");
    workspace("ws-old-free", {}, [owner("owner-1")]);
    workspace("ws-paid", PAID, [owner("owner-1")]);
    scheduled("ws-old-free", 15);
    for (let p = 1; p <= 40; p += 1) await due("ws-paid", `paid-${p}`);
    expect(
      (await crossWorkspacePostRefusal({ workspaceId: "ws-old-free", workspace: { billingExempt: false }, day: NOW, mode: "now" }))?.code,
    ).toBe("OWNER_DAILY_POST_LIMIT");
    await expect(crossWorkspacePostRefusal({ workspaceId: "ws-paid", workspace: PAID, day: NOW, mode: "now" })).resolves.toBeNull();
    // The paying workspace's runs are on nobody's count and in no pool.
    const paid = store.events.filter((event) => event.workspaceId === "ws-paid");
    expect(paid.every((event) => event.pool === "none" && (event.ownerIds as string[]).length === 0)).toBe(true);
  });

  it("never refuses the operator's workspaces", async () => {
    workspace("ws-ops", {}, [OPS]);
    scheduled("ws-ops", 100);
    await sentElsewhere(40, NOW);
    await expect(crossWorkspacePostRefusal({ workspaceId: "ws-ops", workspace: {}, day: NOW, mode: "now" })).resolves.toBeNull();
  });
});

describe("the main pool counts one row per run", () => {
  it("posts due 23:51-23:59 that go out in the 00:00 run count on the new day, each before the next is checked", async () => {
    workspace("ws-1");
    await sentElsewhere(20, new Date("2026-11-13T10:00:00Z"));
    const run = new Date("2026-11-14T00:00:30Z");
    for (let p = 1; p <= 3; p += 1) await due("ws-1", `early-${p}`, run);
    await sentElsewhere(14, run);
    const outcomes = [];
    for (const id of ["due-51", "due-53", "due-55", "due-57", "due-59"]) outcomes.push(await due("ws-1", id, run));
    // Day 1's 20 do not count on day 2; 17 + 3 fill it, and the last two meet the cap.
    expect(outcomes).toEqual([null, null, null, FULL_AT_SEND, FULL_AT_SEND]);
    expect(sendsOf("due-51")[0]?.sourceId).toBe("send:due-51:2026-11-14");
  });

  it("deleting workspaces does not lower the day's count", async () => {
    workspace("ws-gone", {}, [owner("owner-1")]);
    workspace("ws-gone-2", {}, [owner("owner-2")]);
    workspace("ws-1");
    for (let p = 1; p <= 15; p += 1) await due("ws-gone", `gone-${p}`);
    for (let p = 1; p <= 2; p += 1) await due("ws-gone-2", `gone2-${p}`);
    for (let p = 1; p <= 3; p += 1) await due("ws-1", `one-${p}`);
    await copyUsageBeforeDeletion((await import("@/lib/db")).prisma as never, {
      workspaceIds: ["ws-gone", "ws-gone-2"],
      userId: "owner-1",
      now: NOW,
    });
    store.workspaces = store.workspaces.filter((w) => !w.id.startsWith("ws-gone"));
    await expect(due("ws-1", "next")).resolves.toBe(FULL_AT_SEND);
  });

  it("a paying workspace's or the operator's runs are never counted, and they are never refused", async () => {
    vi.stubEnv("BILLING_ENABLED", "true");
    workspace("ws-paid", PAID);
    workspace("ws-ops", {}, [OPS]);
    for (let i = 0; i < 50; i += 1) {
      await due("ws-paid", `paid-${i}`);
      await due("ws-ops", `ops-${i}`);
    }
    expect(runsIn("main")).toBe(0);
    await sentElsewhere(20, NOW);
    await expect(due("ws-paid", "p")).resolves.toBeNull();
    await expect(due("ws-ops", "o")).resolves.toBeNull();
  });

  it("18 sent: the pair goes; 19: one place left, neither half", async () => {
    workspace("ws-1");
    for (let p = 1; p <= 3; p += 1) await due("ws-1", `one-${p}`);
    await sentElsewhere(15, NOW);
    await expect(atSendCheck("ws-1", ["feed", "story"])).resolves.toBeNull();
    await sentElsewhere(1, NOW);
    expect((await atSendCheck("ws-1", ["feed", "story"]))?.errorMessage).toBe(
      FULL_AT_SEND,
    );
  });

  it("Post now of a pair (alsoOnDay 1) meets the same rule", async () => {
    workspace("ws-1");
    for (let p = 1; p <= 3; p += 1) await due("ws-1", `one-${p}`);
    await sentElsewhere(16, NOW);
    expect(
      (await crossWorkspacePostRefusal({
        workspaceId: "ws-1",
        workspace: {},
        day: NOW,
        mode: "now",
        excludePostJobId: ["feed", "story"],
        alsoOnDay: 1,
      }))?.code,
    ).toBe("SERVICE_DAILY_POST_LIMIT");
    await expect(
      crossWorkspacePostRefusal({ workspaceId: "ws-1", workspace: {}, day: NOW, mode: "now", excludePostJobId: "feed" }),
    ).resolves.toBeNull();
  });

  it("a half already reserved by its pair's send counts once, not against itself", async () => {
    workspace("ws-1");
    for (let p = 1; p <= 3; p += 1) await due("ws-1", `one-${p}`);
    await sentElsewhere(15, NOW);
    await recordSend({ workspaceId: "ws-1", postJobIds: ["feed", "story"], at: NOW });
    await expect(atSendCheck("ws-1", ["story"])).resolves.toBeNull();
  });

  // Rows written before this change carry no pool: they count by the old rule.
  it("a run recorded before pools existed counts in the main pool and toward the workspace's owners", async () => {
    workspace("ws-1", {}, [owner("owner-1")]);
    for (let p = 1; p <= 15; p += 1) {
      store.events.push({ kind: "send", workspaceId: "ws-1", sourceId: `send:legacy-${p}:2026-11-14`, at: NOW, pool: null, ownerIds: [] });
    }
    await sentElsewhere(2, NOW);
    expect((await crossWorkspacePostRefusal({ workspaceId: "ws-1", workspace: {}, day: NOW, mode: "now" }))?.code).toBe(
      "OWNER_DAILY_POST_LIMIT",
    );
    workspace("ws-2", {}, [owner("owner-2")]);
    for (let p = 1; p <= 3; p += 1) await due("ws-2", `two-${p}`);
    await expect(due("ws-2", "two-4")).resolves.toBe(FULL_AT_SEND);
  });
});

// R7-security L1: runs, not posts.
describe("retries", () => {
  it("a retry counts one run, toward the pool and the owners, even of a post sent today", async () => {
    workspace("ws-1", {}, [owner("owner-1")]);
    await due("ws-1", "post-a");
    await recordRetry({ workspaceId: "ws-1", postJobId: "post-a", requestId: "r1", at: NOW });
    await recordRetry({ workspaceId: "ws-1", postJobId: "post-a", requestId: "r2", at: NOW });
    expect(sendsOf("post-a").map((event) => event.sourceId)).toEqual([
      "send:post-a:2026-11-14",
      "send:post-a:retry:r1",
      "send:post-a:retry:r2",
    ]);
    expect(sendsOf("post-a").every((event) => event.pool === "main")).toBe(true);
    expect(sendsOf("post-a").every((event) => (event.ownerIds as string[]).includes("owner-1"))).toBe(true);
  });

  it("4 failed platforms retried together are one run", async () => {
    workspace("ws-1", {}, [owner("owner-1")]);
    await expect(retryRefusal({ workspaceId: "ws-1", postJobId: "post-a", now: NOW })).resolves.toBeNull();
    await recordRetry({ workspaceId: "ws-1", postJobId: "post-a", requestId: "r1", at: NOW });
    expect(store.events).toHaveLength(1);
  });

  it("the 4th retry run of a post in a day is refused with the sentence, whatever the platforms", async () => {
    workspace("ws-1", {}, [owner("owner-1")]);
    for (const requestId of ["r1", "r2", "r3"]) {
      await expect(retryRefusal({ workspaceId: "ws-1", postJobId: "post-a", now: NOW })).resolves.toBeNull();
      await recordRetry({ workspaceId: "ws-1", postJobId: "post-a", requestId, at: NOW });
    }
    await expect(retryRefusal({ workspaceId: "ws-1", postJobId: "post-a", now: NOW })).resolves.toEqual({
      code: "POST_RETRY_LIMIT",
      error: "This post has been retried 3 times today, the most for one day. Try again tomorrow.",
    });
    // Another post is not affected.
    await expect(retryRefusal({ workspaceId: "ws-1", postJobId: "post-b", now: NOW })).resolves.toBeNull();
  });

  // R8-publishing L3 with R8-pages L6: the sentence points to Retry all failed
  // only when the card shows it: the shared rule covers 2 or more platforms.
  it("points to Retry all failed only when it covers 2 or more of the post's failed platforms", async () => {
    workspace("ws-1", {}, [owner("owner-1")]);
    for (const requestId of ["r1", "r2", "r3"]) {
      await recordRetry({ workspaceId: "ws-1", postJobId: "post-a", requestId, at: NOW });
    }
    const failed = (platform: string, errorCode: string | null = "PLATFORM_ERROR") => ({ platform, status: "failed", errorCode });
    const WITH_POINTER =
      "This post has been retried 3 times today, the most for one day. Try again tomorrow. Retry all failed retries every failed platform of a post at once and counts as one retry.";
    const WITHOUT = "This post has been retried 3 times today, the most for one day. Try again tomorrow.";
    store.results["post-a"] = [failed("x"), failed("youtube"), { platform: "linkedin", status: "success", errorCode: null }];
    expect((await retryRefusal({ workspaceId: "ws-1", postJobId: "post-a", now: NOW }))?.error).toBe(WITH_POINTER);
    // X may already be live: Retry all would cover only YouTube, so the card has no such button.
    store.results["post-a"] = [failed("x", "PUBLISH_UNCONFIRMED"), failed("youtube")];
    expect((await reserveRetry({ workspaceId: "ws-1", postJobId: "post-a", requestId: "r4", now: NOW }))?.error).toBe(WITHOUT);
    store.results["post-a"] = [failed("x"), failed("youtube")];
    store.deadPlatforms = ["x"];
    expect((await retryRefusal({ workspaceId: "ws-1", postJobId: "post-a", now: NOW }))?.error).toBe(WITHOUT);
    store.results["post-a"] = [failed("youtube")];
    store.deadPlatforms = [];
    expect((await retryRefusal({ workspaceId: "ws-1", postJobId: "post-a", now: NOW }))?.error).toBe(WITHOUT);
  });

  it("retries recorded per platform before this change count once per request", async () => {
    workspace("ws-1", {}, [owner("owner-1")]);
    for (const platform of ["x", "instagram", "linkedin"]) {
      store.events.push({ kind: "retry", workspaceId: "ws-1", platform, sourceId: `retry:post-a:${platform}:old-1`, at: NOW });
    }
    await recordRetry({ workspaceId: "ws-1", postJobId: "post-a", requestId: "r2", at: NOW });
    await expect(retryRefusal({ workspaceId: "ws-1", postJobId: "post-a", now: NOW })).resolves.toBeNull();
    await recordRetry({ workspaceId: "ws-1", postJobId: "post-a", requestId: "r3", at: NOW });
    expect((await retryRefusal({ workspaceId: "ws-1", postJobId: "post-a", now: NOW }))?.code).toBe("POST_RETRY_LIMIT");
  });

  it("the guard counts per UTC day: yesterday's retries leave today's three", async () => {
    workspace("ws-1", {}, [owner("owner-1")]);
    for (const requestId of ["r1", "r2", "r3"]) {
      await recordRetry({ workspaceId: "ws-1", postJobId: "post-a", requestId, at: DAY_1 });
    }
    await expect(retryRefusal({ workspaceId: "ws-1", postJobId: "post-a", now: NOW })).resolves.toBeNull();
  });

  it("a retry run is refused by the per-person number and the pools like a post", async () => {
    workspace("ws-1", {}, [owner("owner-1")]);
    for (let p = 1; p <= 15; p += 1) await due("ws-1", `p-${p}`);
    expect((await retryRefusal({ workspaceId: "ws-1", postJobId: "p-1", now: NOW }))?.error).toBe(
      "This workspace's owner has reached the limit of 15 posts a day across the workspaces they own, and retries count toward it. Retry tomorrow, or schedule the post again for another day.",
    );
    workspace("ws-2", {}, [owner("owner-2")]);
    for (let p = 1; p <= 3; p += 1) await due("ws-2", `q-${p}`);
    await sentElsewhere(2, NOW);
    expect((await retryRefusal({ workspaceId: "ws-2", postJobId: "q-1", now: NOW }))?.error).toBe(
      "Vibe Socials has reached its daily limit of posts for the whole service, and retries count toward it. Retry tomorrow.",
    );
  });

  it("a paying workspace at the free caps may retry; the 3-a-day guard still applies to it", async () => {
    vi.stubEnv("BILLING_ENABLED", "true");
    workspace("ws-paid", PAID, [owner("owner-1")]);
    workspace("ws-free", { trialEndsAt: new Date(NOW.getTime() + 5 * DAY) }, [owner("owner-1")]);
    for (let p = 1; p <= 15; p += 1) await due("ws-free", `f-${p}`);
    await sentElsewhere(20, NOW);
    for (const requestId of ["r1", "r2", "r3"]) {
      await expect(retryRefusal({ workspaceId: "ws-paid", postJobId: "p", now: NOW })).resolves.toBeNull();
      await recordRetry({ workspaceId: "ws-paid", postJobId: "p", requestId, at: NOW });
    }
    expect((await retryRefusal({ workspaceId: "ws-paid", postJobId: "p", now: NOW }))?.code).toBe("POST_RETRY_LIMIT");
  });

  it("never refuses the operator's retries", async () => {
    workspace("ws-ops", {}, [OPS]);
    for (const requestId of ["r1", "r2", "r3", "r4"]) {
      await recordRetry({ workspaceId: "ws-ops", postJobId: "p", requestId, at: NOW });
    }
    await expect(retryRefusal({ workspaceId: "ws-ops", postJobId: "p", now: NOW })).resolves.toBeNull();
  });

  it("a retry whose hand-over failed is taken back, and only that one", async () => {
    workspace("ws-1", {}, [owner("owner-1")]);
    await recordRetry({ workspaceId: "ws-1", postJobId: "post-a", requestId: "r1", at: NOW });
    await recordRetry({ workspaceId: "ws-1", postJobId: "post-a", requestId: "r2", at: NOW });
    await withdrawRetry({ postJobId: "post-a", requestId: "r2" });
    expect(sendsOf("post-a").map((event) => event.sourceId)).toEqual(["send:post-a:retry:r1"]);
  });
});

describe("a read error, and the operator is who the list says once verified", () => {
  // Review of T1, item 1: the ceiling is hard, so a free run whose limits
  // cannot be counted is not reserved; the soft pre-check still allows.
  it("a read error reserves nothing for a free run: the scanner's throws, a retry is told to try again", async () => {
    workspace("ws-1");
    store.down = true;
    await expect(reserveFreeRuns({ workspaceId: "ws-1", postJobIds: ["a"], at: NOW, check: "atSend" })).rejects.toThrow();
    await expect(reserveRetry({ workspaceId: "ws-1", postJobId: "a", requestId: "r1", now: NOW })).resolves.toEqual({
      code: "LIMIT_CHECK_FAILED",
      error: "We couldn't check today's limits. Try again in a minute.",
    });
    await expect(retryRefusal({ workspaceId: "ws-1", postJobId: "a", now: NOW })).resolves.toBeNull();
    store.down = false;
    expect(store.events).toHaveLength(0);
  });

  it("an unverified address on the operator list is not the operator: it is a new account", async () => {
    workspace("ws-1", {}, [owner("x-1", { email: "ops@example.com", emailVerifiedAt: null, createdAt: LONG_AGO })]);
    workspace("ws-fresh", {}, [fresh("fresh-1")]);
    for (let p = 1; p <= 5; p += 1) await due("ws-fresh", `f-${p}`);
    expect((await atSendCheck("ws-1", ["a"]))?.errorMessage).toBe(
      SMALL_POOL_AT_SEND,
    );
  });
});

// Second review of K2, point 2: a send exists only for a post handed to publishing.
describe("withdrawing a send that was not handed to publishing", () => {
  it("recordSend says which sends it wrote, so a later attempt knows a real one was already there", async () => {
    workspace("ws-1");
    await expect(recordSend({ workspaceId: "ws-1", postJobIds: ["a", "b"], at: NOW })).resolves.toEqual(["a", "b"]);
    await expect(recordSend({ workspaceId: "ws-1", postJobIds: ["a", "c"], at: NOW })).resolves.toEqual(["c"]);
  });

  it("a send whose dispatch failed is removed; the person's Retry later writes its own run", async () => {
    workspace("ws-1");
    await recordSend({ workspaceId: "ws-1", postJobIds: ["a"], at: NOW });
    await withdrawSend({ postJobIds: ["a"], day: NOW });
    expect(sendsOf("a")).toHaveLength(0);
    await recordRetry({ workspaceId: "ws-1", postJobId: "a", requestId: "r1", at: NOW });
    expect(sendsOf("a")).toHaveLength(1);
  });

  it("removes only that post's send for that day", async () => {
    workspace("ws-1");
    await recordSend({ workspaceId: "ws-1", postJobIds: ["feed", "story"], at: NOW });
    await recordSend({ workspaceId: "ws-1", postJobIds: ["story"], at: DAY_1 });
    await withdrawSend({ postJobIds: ["story"], day: NOW });
    expect(sendsOf("feed")).toHaveLength(1);
    expect(sendsOf("story").map((event) => event.sourceId)).toEqual(["send:story:2026-11-13"]);
  });

  it("a send still writes its row when the owners cannot be read, then counted by the old rule", async () => {
    workspace("ws-1");
    const { prisma } = await import("@/lib/db");
    vi.spyOn(prisma.workspaceMember, "findMany").mockRejectedValueOnce(new Error("blip"));
    await expect(recordSend({ workspaceId: "ws-1", postJobIds: ["a"], at: NOW })).resolves.toEqual(["a"]);
    expect(sendsOf("a")[0]).toMatchObject({ pool: null, ownerIds: [] });
  });
});

// R7 review, point 7, and review of T1, item 1: a retry counts and records
// under the post's lock and then the service-wide lock.

describe("two at once", () => {
  const reserve = (requestId: string) => reserveRetry({ workspaceId: "ws-1", postJobId: "post-a", requestId, now: NOW });
  const THREE_TIMES = "This post has been retried 3 times today, the most for one day. Try again tomorrow.";

  // Third look: the count and the record for one post run under a per-post
  // transaction lock, so two clicks run one after the other.
  // Review of T1, item 1: the post's lock first, then the service-wide one, always in that order.
  it("takes the post's transaction lock, then the service-wide lock, before counting", async () => {
    workspace("ws-1", {}, [owner("owner-1")]);
    await reserve("r1");
    expect(store.locks).toEqual([
      { sql: "SELECT pg_advisory_xact_lock(hashtext(?))", key: "post-a" },
      { sql: "SELECT pg_advisory_xact_lock(7311, 1)", key: "service" },
    ]);
  });

  it("two clicks at once with 2 used: one runs, the other reads the 3-times sentence", async () => {
    workspace("ws-1", {}, [owner("owner-1")]);
    await reserve("r1");
    await reserve("r2");
    const outcomes = await Promise.all([reserve("r3"), reserve("r4")]);
    expect(outcomes.filter((outcome) => outcome === null)).toHaveLength(1);
    expect(outcomes.find((outcome) => outcome !== null)).toEqual({ code: "POST_RETRY_LIMIT", error: THREE_TIMES });
    expect(sendsOf("post-a")).toHaveLength(3);
  });

  it("a real 4th retry reads the 3-times sentence and records nothing", async () => {
    workspace("ws-1", {}, [owner("owner-1")]);
    for (const requestId of ["r1", "r2", "r3"]) await expect(reserve(requestId)).resolves.toBeNull();
    await expect(reserve("r4")).resolves.toEqual({ code: "POST_RETRY_LIMIT", error: THREE_TIMES });
    expect(sendsOf("post-a").map((event) => event.sourceId)).toEqual([
      "send:post-a:retry:r1",
      "send:post-a:retry:r2",
      "send:post-a:retry:r3",
    ]);
  });

  it("the first click's hand-over fails and is taken back: a later click runs", async () => {
    workspace("ws-1", {}, [owner("owner-1")]);
    await reserve("r1");
    await reserve("r2");
    await reserve("r3");
    await withdrawRetry({ postJobId: "post-a", requestId: "r3" });
    await expect(reserve("r4")).resolves.toBeNull();
    expect(sendsOf("post-a")).toHaveLength(3);
  });

  it("a post's lock is its own; both retries then take the service-wide lock, and both run", async () => {
    workspace("ws-1", {}, [owner("owner-1")]);
    const outcomes = await Promise.all([
      reserve("r1"),
      reserveRetry({ workspaceId: "ws-1", postJobId: "post-b", requestId: "s1", now: NOW }),
    ]);
    expect(outcomes).toEqual([null, null]);
    expect(store.locks.map((lock) => lock.key).sort()).toEqual(["post-a", "post-b", "service", "service"]);
  });

  it("a reserved retry past the pool is refused and removed; within it, it stays", async () => {
    workspace("ws-1", {}, [owner("owner-1")]);
    for (let p = 1; p <= 3; p += 1) await due("ws-1", `one-${p}`);
    await sentElsewhere(16, NOW);
    await expect(reserveRetry({ workspaceId: "ws-1", postJobId: "one-1", requestId: "r1", now: NOW })).resolves.toBeNull();
    expect((await reserveRetry({ workspaceId: "ws-1", postJobId: "one-2", requestId: "r2", now: NOW }))?.code).toBe(
      "SERVICE_DAILY_POST_LIMIT",
    );
    expect(runsIn("main")).toBe(20);
  });

  it("the scanner's reservation counts and writes at once: the 20th goes, the 21st does not and writes nothing", async () => {
    workspace("ws-1");
    for (let p = 1; p <= 3; p += 1) await due("ws-1", `one-${p}`);
    await sentElsewhere(16, NOW);
    await expect(due("ws-1", "p-20")).resolves.toBeNull();
    await expect(due("ws-1", "p-21")).resolves.toBe(FULL_AT_SEND);
    expect(sendsOf("p-20")).toHaveLength(1);
    expect(sendsOf("p-21")).toHaveLength(0);
  });
});

// R8-security M1: one hard ceiling of free runs a UTC day, all pools and guaranteed runs together.
describe("one ceiling over every free run of the day", () => {
  const SERVICE_NOW =
    "Vibe Socials has reached its daily limit of posts for the whole service. Schedule this post for another day, or try again tomorrow.";
  const freeRuns = () => store.events.filter((event) => event.kind === "send" && (event.pool === "main" || event.pool === "new")).length;

  it("30 throwaway confirmed, day-old accounts posting 3 each: 30 runs go and the rest are refused", async () => {
    const outcomes: Array<string | null> = [];
    for (let a = 1; a <= 30; a += 1) {
      workspace(`ws-t-${a}`, {}, [owner(`t-${a}`)]);
      for (let p = 1; p <= 3; p += 1) outcomes.push(await due(`ws-t-${a}`, `t-${a}-${p}`));
    }
    expect(outcomes.filter((outcome) => outcome === null)).toHaveLength(30);
    expect(outcomes.filter((outcome) => outcome === FULL_AT_SEND)).toHaveLength(60);
    expect(freeRuns()).toBe(30);
    // A real customer's first run of the day, Post now or a retry: refused too, with the service sentence.
    workspace("ws-customer", {}, [owner("customer")]);
    expect((await crossWorkspacePostRefusal({ workspaceId: "ws-customer", workspace: {}, day: NOW, mode: "now" }))?.error).toBe(SERVICE_NOW);
    expect((await retryRefusal({ workspaceId: "ws-customer", postJobId: "c-1", now: NOW }))?.code).toBe("SERVICE_DAILY_POST_LIMIT");
    expect(freeRuns()).toBe(30);
  });

  it("below it the pools and the guarantee apply as before; the new-account pool counts toward it too", async () => {
    workspace("ws-fresh", {}, [fresh("fresh-1")]);
    workspace("ws-fresh-2", {}, [fresh("fresh-2")]);
    for (let p = 1; p <= 2; p += 1) await expect(due("ws-fresh", `f-${p}`)).resolves.toBeNull();
    await sentElsewhere(20, NOW);
    for (const name of ["a", "b"]) {
      workspace(`ws-${name}`, {}, [owner(name)]);
      for (let p = 1; p <= 3; p += 1) await expect(due(`ws-${name}`, `${name}-${p}`)).resolves.toBeNull();
    }
    workspace("ws-c", {}, [owner("c")]);
    await expect(due("ws-c", "c-1")).resolves.toBeNull();
    await expect(due("ws-c", "c-2")).resolves.toBeNull();
    expect(freeRuns()).toBe(30);
    // The new-account pool still has 3 places, but the day's ceiling is reached: the service sentence.
    await expect(due("ws-fresh-2", "f2-1")).resolves.toBe(FULL_AT_SEND);
    await expect(due("ws-c", "c-3")).resolves.toBe(FULL_AT_SEND);
  });

  it("a pair needs both places under it", async () => {
    workspace("ws-1", {}, [owner("owner-1")]);
    await sentElsewhere(20, NOW);
    for (const name of ["a", "b", "c"]) {
      workspace(`ws-${name}`, {}, [owner(name)]);
      for (let p = 1; p <= 3; p += 1) await due(`ws-${name}`, `${name}-${p}`);
    }
    expect(freeRuns()).toBe(29);
    expect((await atSendCheck("ws-1", ["feed", "story"]))?.errorMessage).toBe(
      FULL_AT_SEND,
    );
    await expect(atSendCheck("ws-1", ["feed"])).resolves.toBeNull();
  });

  it("paying and operator workspaces are never refused or counted at it", async () => {
    vi.stubEnv("BILLING_ENABLED", "true");
    for (let a = 1; a <= 12; a += 1) {
      workspace(`ws-t-${a}`, {}, [owner(`t-${a}`)]);
      for (let p = 1; p <= 3; p += 1) await due(`ws-t-${a}`, `t-${a}-${p}`);
    }
    expect(freeRuns()).toBe(30);
    workspace("ws-paid", PAID, [owner("payer")]);
    workspace("ws-ops", {}, [OPS]);
    for (let p = 1; p <= 5; p += 1) {
      await expect(due("ws-paid", `paid-${p}`)).resolves.toBeNull();
      await expect(due("ws-ops", `ops-${p}`)).resolves.toBeNull();
    }
    await expect(crossWorkspacePostRefusal({ workspaceId: "ws-paid", workspace: PAID, day: NOW, mode: "now" })).resolves.toBeNull();
    await expect(retryRefusal({ workspaceId: "ws-ops", postJobId: "ops-1", now: NOW })).resolves.toBeNull();
    expect(freeRuns()).toBe(30);
  });

  it("starts again at 00:00 UTC", async () => {
    for (let a = 1; a <= 12; a += 1) {
      workspace(`ws-t-${a}`, {}, [owner(`t-${a}`)]);
      for (let p = 1; p <= 3; p += 1) await due(`ws-t-${a}`, `t-${a}-${p}`, DAY_1);
    }
    workspace("ws-customer", {}, [owner("customer")]);
    await expect(due("ws-customer", "c-1", DAY_1)).resolves.toBe(FULL_AT_SEND);
    await expect(due("ws-customer", "c-2", NOW)).resolves.toBeNull();
  });

  describe("the operator's email", () => {
    const utcDay = (at: Date) => at.toISOString().slice(0, 10);
    /** The 20 others (15 + 5), then a, b and c with 3 each and d with 1: 30 runs that day. */
    async function fillToCeiling(at: Date = NOW) {
      await sentElsewhere(20, at);
      for (const [name, n] of [["a", 3], ["b", 3], ["c", 3], ["d", 1]] as const) {
        if (!store.workspaces.some((w) => w.id === `ws-${name}`)) workspace(`ws-${name}`, {}, [owner(name)]);
        for (let p = 1; p <= n; p += 1) await due(`ws-${name}`, `${name}-${p}-${at.getTime()}`, at);
      }
      expect(store.events.filter((e) => e.kind === "send" && utcDay(e.at as Date) === utcDay(at))).toHaveLength(30);
    }

    it("goes once a day, to the operator, with the day's count and the top 5 owners by runs", async () => {
      const logs = [vi.spyOn(console, "log"), vi.spyOn(console, "info"), vi.spyOn(console, "warn")];
      for (const spy of logs) spy.mockImplementation(() => {});
      await fillToCeiling();
      expect(sendEmailMock).not.toHaveBeenCalled();

      await expect(due("ws-d", "d-2")).resolves.toBe(FULL_AT_SEND);
      await expect(due("ws-a", "a-4")).resolves.toBe(FULL_AT_SEND);
      await crossWorkspacePostRefusal({ workspaceId: "ws-b", workspace: {}, day: NOW, mode: "now" });
      await retryRefusal({ workspaceId: "ws-c", postJobId: "c-1", now: NOW });

      expect(sendEmailMock).toHaveBeenCalledTimes(1);
      const [message] = sendEmailMock.mock.calls[0];
      expect(message.to).toBe("ops@example.com");
      expect(message.subject).toBe("Vibe Socials reached its daily ceiling of 30 free posts (2026-11-14, UTC)");
      expect(message.html).toContain("Free workspaces reached today's ceiling of 30 posts (UTC).");
      const top = ["owner-of-ws-others-1@example.com", "owner-of-ws-others-2@example.com", "a@example.com", "b@example.com", "c@example.com"];
      for (const email of top) expect(message.html).toContain(email);
      expect(message.html.indexOf(top[0])).toBeLessThan(message.html.indexOf(top[1]));
      expect(message.html).toContain("<td>15</td>");
      expect(message.html).not.toContain("d@example.com");
      // Operator-only: no address reaches the logs.
      const logged = [...logs, vi.mocked(console.error)].flatMap((spy) => spy.mock.calls).map((call) => JSON.stringify(call));
      expect(logged.some((line) => line.includes("@example.com"))).toBe(false);
    });

    it("goes again on the next UTC day the ceiling is reached, and not on a day it is not", async () => {
      await fillToCeiling(DAY_1);
      await due("ws-d", "d-late", DAY_1);
      expect(sendEmailMock).toHaveBeenCalledTimes(1);
      expect(sendEmailMock.mock.calls[0][0].subject).toContain("2026-11-13");
      await fillToCeiling(NOW);
      expect(sendEmailMock).toHaveBeenCalledTimes(1);
      await due("ws-d", "d-late-2", NOW);
      expect(sendEmailMock).toHaveBeenCalledTimes(2);
      expect(sendEmailMock.mock.calls[1][0].subject).toContain("2026-11-14");
    });

    // Review of T1, item 2: a failed email lets the day's key go, so a later refusal tries again.
    it("a failing email never changes the refusal, and the next refusal tries again", async () => {
      await fillToCeiling();
      sendEmailMock.mockRejectedValueOnce(new Error("mail down"));
      await expect(due("ws-d", "d-2")).resolves.toBe(FULL_AT_SEND);
      await expect(due("ws-d", "d-3")).resolves.toBe(FULL_AT_SEND);
      expect(sendEmailMock).toHaveBeenCalledTimes(2);
      await expect(due("ws-d", "d-4")).resolves.toBe(FULL_AT_SEND);
      expect(sendEmailMock).toHaveBeenCalledTimes(2);
    });
  });
});

// R8-new-customer M1: one definition of a new account, for the pools and the per-person number.
describe("a new account, day by day", () => {
  const MONDAY_8PM = new Date("2026-11-16T20:00:00Z");
  const at = (iso: string) => new Date(iso);
  const scheduledFor = (workspaceId: string, id: string, when: Date) =>
    store.posts.push({ id, workspaceId, status: "scheduled", scheduledFor: when, createdAt: MONDAY_8PM });
  const nowCheck = (when: Date, viewerUserId?: string) => {
    vi.setSystemTime(when);
    return crossWorkspacePostRefusal({ workspaceId: "ws-maria", workspace: {}, day: when, mode: "now", viewerUserId });
  };

  it("registers and confirms 20:00 UTC Monday: Monday 5 and the new pool; Tuesday 15 and the main pool", async () => {
    workspace("ws-maria", {}, [owner("maria", { createdAt: MONDAY_8PM, emailVerifiedAt: MONDAY_8PM })]);
    store.timeZones.maria = "America/New_York";

    // Monday: 5, from the new-account pool.
    for (let p = 1; p <= 5; p += 1) {
      await expect(nowCheck(at("2026-11-16T21:00:00Z"))).resolves.toBeNull();
      await recordSend({ workspaceId: "ws-maria", postJobIds: [`mon-${p}`], at: at("2026-11-16T21:00:00Z") });
    }
    expect(store.events.map((event) => event.pool)).toEqual(["new", "new", "new", "new", "new"]);
    expect((await nowCheck(at("2026-11-16T21:30:00Z"), "maria"))?.error).toBe(
      "This workspace's owner has reached the limit of 5 posts a day across all the workspaces they own, and retries count toward it. Schedule this post for another day, or try again tomorrow. The limit is 15 from 00:00 UTC tomorrow (Monday, 7:00 PM EST).",
    );

    // Monday evening she schedules 10 for Tuesday 08:00 to 17:00: Tuesday's number is 15.
    for (let h = 8; h <= 17; h += 1) {
      const when = at(`2026-11-17T${String(h).padStart(2, "0")}:00:00Z`);
      await expect(
        crossWorkspacePostRefusal({ workspaceId: "ws-maria", workspace: {}, day: when, mode: "schedule" }),
      ).resolves.toBeNull();
      scheduledFor("ws-maria", `tue-${h}`, when);
    }

    // Tuesday: someone else's fresh accounts fill the new-account pool; it is not hers any more.
    workspace("ws-fresh", {}, [owner("fresh", { createdAt: at("2026-11-17T01:00:00Z"), emailVerifiedAt: null })]);
    for (let p = 1; p <= 5; p += 1) await due("ws-fresh", `fresh-${p}`, at("2026-11-17T02:00:00Z"));
    // The scanner sends all 10, from the main pool.
    for (let h = 8; h <= 17; h += 1) {
      const when = at(`2026-11-17T${String(h).padStart(2, "0")}:00:00Z`);
      vi.setSystemTime(when);
      const post = store.posts.find((row) => row.id === `tue-${h}`)!;
      post.status = "in_progress";
      await expect(due("ws-maria", `tue-${h}`, when)).resolves.toBeNull();
    }
    const tuesday = store.events.filter((event) => event.workspaceId === "ws-maria" && String(event.sourceId).endsWith("2026-11-17"));
    expect(tuesday.map((event) => event.pool)).toEqual(Array(10).fill("main"));
    // Post now on Tuesday: 5 more go (15), the 16th is refused at 15.
    for (let p = 1; p <= 5; p += 1) {
      await expect(nowCheck(at("2026-11-17T19:00:00Z"))).resolves.toBeNull();
      await recordSend({ workspaceId: "ws-maria", postJobIds: [`now-${p}`], at: at("2026-11-17T19:00:00Z") });
    }
    expect((await nowCheck(at("2026-11-17T19:30:00Z")))?.error).toBe(
      "This workspace's owner has reached the limit of 15 posts a day across all the workspaces they own, and retries count toward it. Schedule this post for another day, or try again tomorrow.",
    );
  });

  it("unconfirmed: 5 and the new pool on every day; once confirmed, 15 and the main pool that same day", async () => {
    const ws = workspace("ws-maria", {}, [owner("maria", { createdAt: at("2026-11-10T09:00:00Z"), emailVerifiedAt: null })]);
    const wed = at("2026-11-18T10:00:00Z");
    vi.setSystemTime(wed);
    for (let p = 1; p <= 5; p += 1) await expect(due("ws-maria", `w-${p}`, wed)).resolves.toBeNull();
    expect((await nowCheck(wed, "maria"))?.error).toBe(
      "This workspace's owner has reached the limit of 5 posts a day across all the workspaces they own, and retries count toward it. Schedule this post for another day, or try again tomorrow. The limit is 15 once you confirm your email address.",
    );
    expect(store.events.every((event) => event.pool === "new")).toBe(true);

    // On an account's first day, unconfirmed: both conditions.
    ws.owners = [owner("maria", { createdAt: at("2026-11-18T08:00:00Z"), emailVerifiedAt: null })];
    expect((await nowCheck(wed, "maria"))?.error).toBe(
      "This workspace's owner has reached the limit of 5 posts a day across all the workspaces they own, and retries count toward it. Schedule this post for another day, or try again tomorrow. The limit is 15 from 00:00 UTC tomorrow, once you confirm your email address.",
    );

    // She confirms at noon on a later day: the main pool and 15 from then on.
    ws.owners = [owner("maria", { createdAt: at("2026-11-10T09:00:00Z"), emailVerifiedAt: at("2026-11-18T12:00:00Z") })];
    const afternoon = at("2026-11-18T13:00:00Z");
    await expect(nowCheck(afternoon)).resolves.toBeNull();
    await expect(due("ws-maria", "w-6", afternoon)).resolves.toBeNull();
    expect(store.events.at(-1)).toMatchObject({ pool: "main" });
  });
});

// R8-publishing L1: a half whose run its partner recorded (and which passed) is not checked again.
describe("whether a post's run for the day is already recorded", () => {
  it("is true for both halves once the pair's send is recorded, and false for another day", async () => {
    workspace("ws-1");
    await recordSend({ workspaceId: "ws-1", postJobIds: ["feed", "story"], at: NOW });
    await expect(sendRecorded("story", NOW)).resolves.toBe(true);
    await expect(sendRecorded("story", new Date(NOW.getTime() + DAY))).resolves.toBe(false);
    await expect(sendRecorded("other", NOW)).resolves.toBe(false);
    store.down = true;
    await expect(sendRecorded("story", NOW)).resolves.toBe(false);
  });
});

// R8-pages M1: Settings, Usage shows each owner's per-person count, counted as the limit counts it.
describe("the per-person usage for Settings", () => {
  it("counts runs today (retries too) and posts still to go today, across the owner's free workspaces", async () => {
    workspace("ws-1", {}, [owner("owner-1", { name: "Jane" })]);
    workspace("ws-2", {}, [owner("owner-1", { name: "Jane" })]);
    for (let p = 1; p <= 3; p += 1) await due("ws-2", `b-${p}`);
    await recordRetry({ workspaceId: "ws-2", postJobId: "b-1", requestId: "r1", at: NOW });
    store.posts.push({ id: "later-today", workspaceId: "ws-1", status: "scheduled", scheduledFor: new Date("2026-11-14T20:00:00Z"), createdAt: LONG_AGO });
    store.posts.push({ id: "tomorrow", workspaceId: "ws-1", status: "scheduled", scheduledFor: new Date("2026-11-15T09:00:00Z"), createdAt: LONG_AGO });

    await expect(ownersPersonalUsage("ws-1", NOW, "owner-1")).resolves.toEqual([
      { userId: "owner-1", name: "Jane", isViewer: true, used: 5, limit: 15, reduced: null },
    ]);
    // The workspace's own line would read 1 here: the binding number is the person's.
  });

  it("a new or unconfirmed owner reads 5 with its reason, one line per owner of a co-owned workspace", async () => {
    workspace("ws-team", {}, [owner("lead"), owner("maria", { name: "Maria", createdAt: new Date(NOW.getTime() - 3_600_000), emailVerifiedAt: null })]);
    const lines = await ownersPersonalUsage("ws-team", NOW, "lead");
    expect(lines.map(({ name, isViewer, limit, reduced }) => ({ name, isViewer, limit, reduced }))).toEqual([
      { name: "lead@example.com", isViewer: true, limit: 15, reduced: null },
      { name: "Maria", isViewer: false, limit: 5, reduced: "first_day_unconfirmed" },
    ]);
  });

  it("is empty where the per-person limit does not apply: a paying or the operator's workspace", async () => {
    vi.stubEnv("BILLING_ENABLED", "true");
    workspace("ws-paid", PAID, [owner("payer")]);
    workspace("ws-ops", {}, [OPS]);
    await expect(ownersPersonalUsage("ws-paid", NOW)).resolves.toEqual([]);
    await expect(ownersPersonalUsage("ws-ops", NOW)).resolves.toEqual([]);
  });
});

// R9-security M1: paying only once Stripe has been paid; a card trial keeps its features but is counted.
describe("a plan in its card trial counts like a free workspace", () => {
  const TRIAL_END = new Date("2026-11-26T00:00:00Z");
  const TRIALING_PRO = { billingExempt: false, plan: "pro", planStatus: "trialing", trialEndsAt: TRIAL_END, currentPeriodEnd: TRIAL_END };
  /** The renewal on 10 Nov failed after a paid month (the trial ended 10 Oct). */
  const PAST_DUE_PAID = {
    billingExempt: false,
    plan: "pro",
    planStatus: "past_due",
    trialEndsAt: new Date("2026-10-10T00:00:00Z"),
    currentPeriodEnd: new Date("2026-11-10T00:00:00Z"),
  };
  /** The first charge at the trial's end on 10 Nov failed: never paid. */
  const PAST_DUE_UNPAID = { ...PAST_DUE_PAID, trialEndsAt: new Date("2026-11-10T00:00:00Z") };
  const reserveNow = (workspaceId: string, postJobIds: string[]) => reserveFreeRuns({ workspaceId, postJobIds, at: NOW, check: "now" });
  const freeRuns = () => store.events.filter((event) => event.kind === "send" && (event.pool === "main" || event.pool === "new")).length;

  /** 10 free workspaces of confirmed people, 3 runs each: the day's ceiling. */
  async function fillToCeiling() {
    for (let a = 1; a <= 10; a += 1) {
      workspace(`ws-t-${a}`, {}, [owner(`t-${a}`)]);
      for (let p = 1; p <= 3; p += 1) await due(`ws-t-${a}`, `t-${a}-${p}`);
    }
  }

  beforeEach(() => {
    vi.stubEnv("BILLING_ENABLED", "true");
  });

  it("a trialing Pro workspace past the ceiling is refused, and the operator is emailed", async () => {
    await fillToCeiling();
    expect(freeRuns()).toBe(30);
    workspace("ws-trial", TRIALING_PRO, [owner("trialer")]);
    store.locks = [];
    await expect(due("ws-trial", "trial-1")).resolves.toBe(FULL_AT_SEND);
    expect(store.locks.map((lock) => lock.key)).toEqual(["service"]);
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    expect(sendEmailMock.mock.calls[0][0].to).toBe("ops@example.com");
    expect(sendsOf("trial-1")).toHaveLength(0);
  });

  it("its runs are in the pools and on its owner's per-person number: one account's 30 trials get 15 runs", async () => {
    for (let w = 1; w <= 30; w += 1) workspace(`ws-trial-${w}`, TRIALING_PRO, [owner("one-person")]);
    const outcomes = [];
    for (let w = 1; w <= 30; w += 1) outcomes.push(await reserveNow(`ws-trial-${w}`, [`trial-${w}`]));
    expect(outcomes.filter((outcome) => outcome.ok)).toHaveLength(15);
    expect(outcomes.filter((outcome) => !outcome.ok && outcome.refusal.code === "OWNER_DAILY_POST_LIMIT")).toHaveLength(15);
    expect(sendsOf("trial-1")[0]).toMatchObject({ pool: "main", ownerIds: ["one-person"] });
    await expect(ownersPersonalUsage("ws-trial-1", NOW, "one-person")).resolves.toMatchObject([
      { userId: "one-person", used: 15, limit: 15 },
    ]);
  });

  it("an active paid plan at the ceiling is never refused and takes no lock", async () => {
    await fillToCeiling();
    workspace("ws-paid", { ...TRIALING_PRO, planStatus: "active", currentPeriodEnd: new Date("2026-12-26T00:00:00Z") }, [owner("payer")]);
    store.locks = [];
    await expect(reserveNow("ws-paid", ["paid-1"])).resolves.toEqual({ ok: true, written: ["paid-1"] });
    await expect(due("ws-paid", "paid-2")).resolves.toBeNull();
    expect(store.locks).toEqual([]);
    expect(sendsOf("paid-1")[0]).toMatchObject({ pool: "none", ownerIds: [] });
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it("past_due after a paid period counts as paid", async () => {
    await fillToCeiling();
    workspace("ws-late", PAST_DUE_PAID, [owner("late-payer")]);
    store.locks = [];
    await expect(due("ws-late", "late-1")).resolves.toBeNull();
    expect(store.locks).toEqual([]);
    expect(sendsOf("late-1")[0]).toMatchObject({ pool: "none", ownerIds: [] });
  });

  it("past_due with no paid period is counted, and refused at the ceiling", async () => {
    workspace("ws-unpaid", PAST_DUE_UNPAID, [owner("never-paid")]);
    await expect(due("ws-unpaid", "unpaid-1")).resolves.toBeNull();
    expect(sendsOf("unpaid-1")[0]).toMatchObject({ pool: "main", ownerIds: ["never-paid"] });
    await fillToCeiling();
    await expect(due("ws-unpaid", "unpaid-2")).resolves.toBe(FULL_AT_SEND);
  });
});

// Review of T1, item 1: every free run is counted, checked and written under one service-wide lock.
describe("one reservation under one lock", () => {
  const reserveNow = (workspaceId: string, postJobIds: string[], at: Date = NOW) =>
    reserveFreeRuns({ workspaceId, postJobIds, at, check: "now" });
  const freeRuns = () => store.events.filter((event) => event.kind === "send" && (event.pool === "main" || event.pool === "new")).length;

  /** 29 free runs today: the 20 others, then 9 guaranteed runs past the full main pool. */
  async function fillTo29() {
    await sentElsewhere(20, NOW);
    for (const name of ["a", "b", "c"]) {
      workspace(`ws-${name}`, {}, [owner(name)]);
      for (let p = 1; p <= 3; p += 1) await due(`ws-${name}`, `${name}-${p}`);
    }
    expect(freeRuns()).toBe(29);
  }

  it("50 Post now presses at once at 29 used: exactly 1 goes, and the ceiling is never passed", async () => {
    await fillTo29();
    for (let i = 0; i < 50; i += 1) workspace(`ws-p-${i}`, {}, [owner(`p-${i}`)]);
    store.locks = [];
    const outcomes = await Promise.all(Array.from({ length: 50 }, (_, i) => reserveNow(`ws-p-${i}`, [`now-${i}`])));
    expect(outcomes.filter((outcome) => outcome.ok)).toHaveLength(1);
    expect(outcomes.filter((outcome) => !outcome.ok && outcome.refusal.code === "SERVICE_DAILY_POST_LIMIT")).toHaveLength(49);
    expect(freeRuns()).toBe(30);
    expect(store.locks.every((lock) => lock.key === "service")).toBe(true);
    expect(store.locks).toHaveLength(50);
  });

  it("a pair at 29: refused whole, with the service sentence, and nothing written", async () => {
    await fillTo29();
    workspace("ws-pair", {}, [owner("pair-owner")]);
    const outcome = await reserveNow("ws-pair", ["feed", "story"]);
    expect(outcome).toEqual({
      ok: false,
      ceiling: true,
      refusal: {
        code: "SERVICE_DAILY_POST_LIMIT",
        error: "Vibe Socials has reached its daily limit of posts for the whole service. Schedule this post for another day, or try again tomorrow.",
      },
    });
    expect(sendsOf("feed")).toHaveLength(0);
    expect(sendsOf("story")).toHaveLength(0);
    expect(freeRuns()).toBe(29);
  });

  it("the hand-over fails: the caller takes back the rows it wrote, and the count is back where it was", async () => {
    workspace("ws-1", {}, [owner("owner-1")]);
    await sentElsewhere(5, NOW);
    const outcome = await reserveNow("ws-1", ["feed", "story"]);
    expect(outcome).toEqual({ ok: true, written: ["feed", "story"] });
    expect(freeRuns()).toBe(7);
    if (outcome.ok) await withdrawSend({ postJobIds: outcome.written, day: NOW });
    expect(freeRuns()).toBe(5);
  });

  it("a paying workspace at the ceiling goes, takes no lock and is in no pool", async () => {
    vi.stubEnv("BILLING_ENABLED", "true");
    await fillTo29();
    await due("ws-a", "a-extra-for-30");
    workspace("ws-paid", PAID, [owner("payer")]);
    store.locks = [];
    await expect(reserveNow("ws-paid", ["paid-1"])).resolves.toEqual({ ok: true, written: ["paid-1"] });
    expect(store.locks).toEqual([]);
    expect(sendsOf("paid-1")[0]).toMatchObject({ pool: "none" });
  });

  it("Post now checks the per-person number in the same reservation, with its sentence", async () => {
    workspace("ws-1", {}, [owner("owner-1")]);
    for (let p = 1; p <= 15; p += 1) await expect(reserveNow("ws-1", [`p-${p}`])).resolves.toMatchObject({ ok: true });
    await expect(reserveNow("ws-1", ["p-16"])).resolves.toMatchObject({
      ok: false,
      ceiling: false,
      refusal: { code: "OWNER_DAILY_POST_LIMIT" },
    });
    // The scanner's post was counted when it was given its day: no per-person check at send.
    await expect(due("ws-1", "scheduled-16")).resolves.toBeNull();
  });

  it("a half its other half reserved is not written or counted twice", async () => {
    workspace("ws-1", {}, [owner("owner-1")]);
    await reserveNow("ws-1", ["feed", "story"]);
    await expect(reserveNow("ws-1", ["story"])).resolves.toEqual({ ok: true, written: [] });
    expect(sendsOf("story")).toHaveLength(1);
  });
});
