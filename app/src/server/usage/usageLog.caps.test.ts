import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The daily caps across workspaces, against an in-memory copy of the tables
 * they read (R6 review of K2), so a sequence of sends, retries and deletions
 * is counted the way the database would count it.
 */

type Row = Record<string, unknown>;
type Owner = { userId: string; user: { email: string; emailVerifiedAt: Date | null; createdAt: Date } };
type Workspace = Row & { id: string; owners: Owner[] };

const store = vi.hoisted(() => ({
  /** Every usage read throws while set: the checks must fail open. */
  down: false,
  events: [] as Record<string, unknown>[],
  posts: [] as Record<string, unknown>[],
  workspaces: [] as Array<Record<string, unknown> & { id: string; owners: Array<{ userId: string; user: unknown }> }>,
}));

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
  return {
    prisma: {
      usageEvent,
      postJob: {
        findMany: async ({ where }: { where: Row }) => store.posts.filter((post) => matches(post, where)),
      },
      postJobResult: { findMany: async () => [] },
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
    },
  };
});


import {
  copyUsageBeforeDeletion,
  crossWorkspacePostRefusal,
  recordRetry,
  recordSend,
  retryRefusal,
  serviceCapRefusalAtSend,
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

/** `n` more runs of free workspaces that other confirmed people sent on `at`'s day, 15 each. */
async function sentElsewhere(n: number, at: Date) {
  for (let i = 0; i < n; i += 1) {
    othersSent += 1;
    const id = `ws-others-${Math.ceil(othersSent / 15)}`;
    if (!store.workspaces.some((w) => w.id === id)) workspace(id);
    await recordSend({ workspaceId: id, postJobIds: [`other-${othersSent}`], at });
  }
}

/** One post due in `workspaceId` at `at`: checked as the scanner does, and sent when allowed. */
async function due(workspaceId: string, postJobId: string, at: Date = NOW): Promise<string | null> {
  const refusal = await serviceCapRefusalAtSend({ workspaceId, postJobIds: [postJobId], now: at });
  if (!refusal) await recordSend({ workspaceId, postJobIds: [postJobId], at });
  return refusal?.errorMessage ?? null;
}

const runsIn = (pool: string | null) => store.events.filter((event) => event.kind === "send" && event.pool === pool).length;
const sendsOf = (postJobId: string) =>
  store.events.filter((event) => event.kind === "send" && String(event.sourceId).startsWith(`send:${postJobId}:`));

const LEAVE_SMALL_POOL = "It stops applying once the owner has confirmed their email address and the account is a day old.";
const FULL_AT_SEND =
  "Not sent: Vibe Socials had reached its daily limit of posts for the whole service when this post was due. Retry it tomorrow, or schedule it again.";
const SMALL_POOL_AT_SEND = `Not sent: Vibe Socials had reached the day's limit of 10 posts shared by accounts under a day old or with an unconfirmed email address when this post was due. Retry it tomorrow, or schedule it again. ${LEAVE_SMALL_POOL}`;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  store.events = [];
  store.posts = [];
  store.workspaces = [];
  store.down = false;
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
  it("8 fresh accounts at 5 each: 10 runs go, the main pool is untouched, and a 9th fresh account is refused", async () => {
    const outcomes: Array<string | null> = [];
    for (let a = 1; a <= 8; a += 1) {
      workspace(`ws-fresh-${a}`, {}, [a % 2 ? fresh(`fresh-${a}`) : owner(`unconfirmed-${a}`, { emailVerifiedAt: null })]);
      for (let p = 1; p <= 5; p += 1) outcomes.push(await due(`ws-fresh-${a}`, `fresh-${a}-${p}`));
    }
    expect(outcomes.filter((outcome) => outcome === null)).toHaveLength(10);
    expect(outcomes.filter((outcome) => outcome === SMALL_POOL_AT_SEND)).toHaveLength(30);
    expect(runsIn("new")).toBe(10);
    expect(runsIn("main")).toBe(0);

    workspace("ws-fresh-9", {}, [fresh("fresh-9")]);
    await expect(due("ws-fresh-9", "fresh-9-1")).resolves.toBe(SMALL_POOL_AT_SEND);

    // Confirmed customers still have the whole main pool: all 30 go today.
    await sentElsewhere(29, NOW);
    workspace("ws-customer", {}, [owner("customer")]);
    await expect(due("ws-customer", "c-1")).resolves.toBeNull();
    expect(runsIn("main")).toBe(30);
  });

  it("a full main pool never refuses a new account, and a full small pool never refuses a confirmed one", async () => {
    workspace("ws-fresh", {}, [fresh("fresh-1")]);
    workspace("ws-fresh-2", {}, [fresh("fresh-2")]);
    workspace("ws-customer", {}, [owner("customer")]);
    await sentElsewhere(30, NOW);
    for (let p = 1; p <= 5; p += 1) await expect(due("ws-fresh", `f-${p}`)).resolves.toBeNull();
    for (let p = 1; p <= 5; p += 1) await expect(due("ws-fresh-2", `g-${p}`)).resolves.toBeNull();
    expect(runsIn("new")).toBe(10);
    // The customer's first run of the day goes on their guaranteed share.
    await expect(due("ws-customer", "c-1")).resolves.toBeNull();
  });

  it("a workspace with one confirmed, day-old owner uses the main pool even with a new co-owner", async () => {
    workspace("ws-team", {}, [owner("lead"), fresh("new-hire")]);
    await due("ws-team", "t-1");
    expect(store.events[0]).toMatchObject({ pool: "main", ownerIds: ["lead", "new-hire"] });
  });

  it("the account turns a day old during the day: from then its runs use the main pool", async () => {
    const signup = new Date("2026-11-13T18:00:00Z");
    workspace("ws-a", {}, [owner("a", { createdAt: signup, emailVerifiedAt: signup })]);
    await due("ws-a", "a-1", new Date("2026-11-14T10:00:00Z"));
    await due("ws-a", "a-2", new Date("2026-11-14T19:00:00Z"));
    expect(store.events.map((event) => event.pool)).toEqual(["new", "main"]);
  });

  it("Post now and scheduling for today meet the small pool too, with their own sentences", async () => {
    workspace("ws-fresh", {}, [fresh("fresh-1")]);
    workspace("ws-fresh-2", {}, [fresh("fresh-2")]);
    workspace("ws-fresh-3", {}, [fresh("fresh-3")]);
    for (let p = 1; p <= 5; p += 1) await due("ws-fresh", `f-${p}`);
    for (let p = 1; p <= 5; p += 1) await due("ws-fresh-2", `g-${p}`);
    expect((await crossWorkspacePostRefusal({ workspaceId: "ws-fresh-3", workspace: {}, day: NOW, mode: "now" }))?.error).toBe(
      `Vibe Socials has reached today's limit of 10 posts shared by accounts under a day old or with an unconfirmed email address. Schedule this post for another day, or try again tomorrow. ${LEAVE_SMALL_POOL}`,
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
    await sentElsewhere(30, NOW);
    const outcomes = [];
    for (let p = 1; p <= 4; p += 1) outcomes.push(await due("ws-customer", `c-${p}`));
    expect(outcomes).toEqual([null, null, null, FULL_AT_SEND]);
    // They still count in the pool.
    expect(runsIn("main")).toBe(33);
  });

  it("a customer who used 3 earlier in the day, while the pool had room, gets no more once it is full", async () => {
    workspace("ws-customer", {}, [owner("customer")]);
    for (let p = 1; p <= 3; p += 1) await due("ws-customer", `c-${p}`);
    await sentElsewhere(27, NOW);
    await expect(due("ws-customer", "c-4")).resolves.toBe(FULL_AT_SEND);
  });

  it("a pair needs both places inside the share: 2 used, the pair is refused once the pool is full", async () => {
    workspace("ws-customer", {}, [owner("customer")]);
    await sentElsewhere(30, NOW);
    await due("ws-customer", "c-1");
    await expect(
      serviceCapRefusalAtSend({ workspaceId: "ws-customer", postJobIds: ["feed", "story"], now: NOW }),
    ).resolves.toBeNull();
    await due("ws-customer", "c-2");
    expect(
      (await serviceCapRefusalAtSend({ workspaceId: "ws-customer", postJobIds: ["feed", "story"], now: NOW }))?.errorMessage,
    ).toBe(FULL_AT_SEND);
  });

  it("a co-owned workspace goes while any of its confirmed owners has a guaranteed run left", async () => {
    workspace("ws-busy", {}, [owner("busy")]);
    workspace("ws-shared", {}, [owner("busy"), owner("quiet")]);
    for (let p = 1; p <= 3; p += 1) await due("ws-busy", `b-${p}`);
    await sentElsewhere(27, NOW);
    await expect(due("ws-busy", "b-4")).resolves.toBe(FULL_AT_SEND);
    await expect(due("ws-shared", "s-1")).resolves.toBeNull();
  });

  it("the share starts again on the next UTC day", async () => {
    workspace("ws-customer", {}, [owner("customer")]);
    for (let p = 1; p <= 3; p += 1) await due("ws-customer", `c-${p}`, DAY_1);
    await sentElsewhere(30, NOW);
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
        "This workspace's owner has reached the limit of 15 posts a day across all the workspaces they own. Schedule this post for another day, or try again tomorrow.",
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
        "That day already has 15 posts across all the workspaces this workspace's owner owns, which is the daily limit for one person. Pick another day.",
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
    expect((await crossWorkspacePostRefusal({ workspaceId: "ws-1", workspace: {}, day: NOW, mode: "now" }))?.error).toBe(
      "This workspace's owner has reached the limit of 5 posts a day across all the workspaces they own. Schedule this post for another day, or try again tomorrow. The limit is 15 once the owner has confirmed their email address and the account is a day old.",
    );
  });

  // Unconfirmed in R7-new-customer: the reduced number is for the days before the account is a day old.
  it("a confirmed account on its first day gets 5 for today and tomorrow, 15 for the days after", async () => {
    workspace("ws-1", {}, [fresh("owner-1")]);
    const tomorrow = new Date("2026-11-15T09:00:00Z");
    const later = new Date("2026-11-20T09:00:00Z");
    scheduled("ws-1", 5, NOW);
    scheduled("ws-1", 5, tomorrow);
    scheduled("ws-1", 5, later);
    expect((await crossWorkspacePostRefusal({ workspaceId: "ws-1", workspace: {}, day: NOW, mode: "schedule" }))?.code).toBe(
      "OWNER_DAILY_POST_LIMIT",
    );
    // Signed up at 14:00 on the 14th: still under a day old when the 15th starts.
    expect((await crossWorkspacePostRefusal({ workspaceId: "ws-1", workspace: {}, day: tomorrow, mode: "schedule" }))?.code).toBe(
      "OWNER_DAILY_POST_LIMIT",
    );
    await expect(crossWorkspacePostRefusal({ workspaceId: "ws-1", workspace: {}, day: later, mode: "schedule" })).resolves.toBeNull();
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
    await sentElsewhere(30, new Date("2026-11-13T10:00:00Z"));
    const run = new Date("2026-11-14T00:00:30Z");
    for (let p = 1; p <= 3; p += 1) await due("ws-1", `early-${p}`, run);
    await sentElsewhere(24, run);
    const outcomes = [];
    for (const id of ["due-51", "due-53", "due-55", "due-57", "due-59"]) outcomes.push(await due("ws-1", id, run));
    // Day 1's 30 do not count on day 2; 27 + 3 fill it, and the last two meet the cap.
    expect(outcomes).toEqual([null, null, null, FULL_AT_SEND, FULL_AT_SEND]);
    expect(sendsOf("due-51")[0]?.sourceId).toBe("send:due-51:2026-11-14");
  });

  it("deleting workspaces does not lower the day's count", async () => {
    workspace("ws-gone", {}, [owner("owner-1")]);
    workspace("ws-gone-2", {}, [owner("owner-2")]);
    workspace("ws-1");
    for (let p = 1; p <= 15; p += 1) await due("ws-gone", `gone-${p}`);
    for (let p = 1; p <= 12; p += 1) await due("ws-gone-2", `gone2-${p}`);
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
    await sentElsewhere(30, NOW);
    await expect(due("ws-paid", "p")).resolves.toBeNull();
    await expect(due("ws-ops", "o")).resolves.toBeNull();
  });

  it("28 sent: the pair goes; 29: one place left, neither half", async () => {
    workspace("ws-1");
    for (let p = 1; p <= 3; p += 1) await due("ws-1", `one-${p}`);
    await sentElsewhere(25, NOW);
    await expect(serviceCapRefusalAtSend({ workspaceId: "ws-1", postJobIds: ["feed", "story"], now: NOW })).resolves.toBeNull();
    await sentElsewhere(1, NOW);
    expect((await serviceCapRefusalAtSend({ workspaceId: "ws-1", postJobIds: ["feed", "story"], now: NOW }))?.errorMessage).toBe(
      FULL_AT_SEND,
    );
  });

  it("Post now of a pair (alsoOnDay 1) meets the same rule", async () => {
    workspace("ws-1");
    for (let p = 1; p <= 3; p += 1) await due("ws-1", `one-${p}`);
    await sentElsewhere(26, NOW);
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
    await sentElsewhere(25, NOW);
    await recordSend({ workspaceId: "ws-1", postJobIds: ["feed", "story"], at: NOW });
    await expect(serviceCapRefusalAtSend({ workspaceId: "ws-1", postJobIds: ["story"], now: NOW })).resolves.toBeNull();
  });

  // Rows written before this change carry no pool: they count by the old rule.
  it("a run recorded before pools existed counts in the main pool and toward the workspace's owners", async () => {
    workspace("ws-1", {}, [owner("owner-1")]);
    for (let p = 1; p <= 15; p += 1) {
      store.events.push({ kind: "send", workspaceId: "ws-1", sourceId: `send:legacy-${p}:2026-11-14`, at: NOW, pool: null, ownerIds: [] });
    }
    await sentElsewhere(12, NOW);
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
      error:
        "This post has been retried 3 times today, the most for one day. Try again tomorrow. Retry all failed retries every failed platform of a post at once and counts as one retry.",
    });
    // Another post is not affected.
    await expect(retryRefusal({ workspaceId: "ws-1", postJobId: "post-b", now: NOW })).resolves.toBeNull();
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
    await sentElsewhere(12, NOW);
    expect((await retryRefusal({ workspaceId: "ws-2", postJobId: "q-1", now: NOW }))?.error).toBe(
      "Vibe Socials has reached its daily limit of posts for the whole service, and retries count toward it. Retry tomorrow.",
    );
  });

  it("a paying workspace at the free caps may retry; the 3-a-day guard still applies to it", async () => {
    vi.stubEnv("BILLING_ENABLED", "true");
    workspace("ws-paid", PAID, [owner("owner-1")]);
    workspace("ws-free", { trialEndsAt: new Date(NOW.getTime() + 5 * DAY) }, [owner("owner-1")]);
    for (let p = 1; p <= 15; p += 1) await due("ws-free", `f-${p}`);
    await sentElsewhere(30, NOW);
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

describe("the checks fail open, and the operator is who the list says once verified", () => {
  it("a read error logs and allows, at send and for a retry", async () => {
    workspace("ws-1");
    store.down = true;
    await expect(serviceCapRefusalAtSend({ workspaceId: "ws-1", postJobIds: ["a"], now: NOW })).resolves.toBeNull();
    await expect(retryRefusal({ workspaceId: "ws-1", postJobId: "a", now: NOW })).resolves.toBeNull();
  });

  it("an unverified address on the operator list is not the operator: it is a new account", async () => {
    workspace("ws-1", {}, [owner("x-1", { email: "ops@example.com", emailVerifiedAt: null, createdAt: LONG_AGO })]);
    workspace("ws-fresh", {}, [fresh("fresh-1")]);
    workspace("ws-fresh-2", {}, [fresh("fresh-2")]);
    for (let p = 1; p <= 5; p += 1) await due("ws-fresh", `f-${p}`);
    for (let p = 1; p <= 5; p += 1) await due("ws-fresh-2", `g-${p}`);
    expect((await serviceCapRefusalAtSend({ workspaceId: "ws-1", postJobIds: ["a"], now: NOW }))?.errorMessage).toBe(
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
