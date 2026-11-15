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
      store.events.push({ ...data });
      return data;
    },
    createMany: async ({ data, skipDuplicates }: { data: Row[]; skipDuplicates?: boolean }) => {
      let count = 0;
      for (const row of data) {
        if (store.events.some((event) => event.sourceId === row.sourceId)) {
          if (!skipDuplicates) throw new Error("Unique constraint failed");
          continue;
        }
        store.events.push({ ...row });
        count += 1;
      }
      return { count };
    },
    count: async ({ where }: { where: Row }) => {
      if (store.down) throw new Error("db down");
      return store.events.filter((event) => matches(event, where)).length;
    },
    findMany: async ({ where }: { where: Row }) => store.events.filter((event) => matches(event, where)),
    groupBy: async ({ where }: { where: Row }) => {
      if (store.down) throw new Error("db down");
      const counts = new Map<unknown, number>();
      for (const event of store.events.filter((e) => matches(e, where))) {
        counts.set(event.workspaceId, (counts.get(event.workspaceId) ?? 0) + 1);
      }
      return [...counts].map(([workspaceId, n]) => ({ workspaceId, _count: { _all: n } }));
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
} from "./usageLog";

const DAY_1 = new Date("2026-11-13T12:00:00.000Z");
const NOW = new Date("2026-11-14T15:00:00.000Z");
const LONG_AGO = new Date("2026-10-01T00:00:00Z");
const DAY = 24 * 60 * 60 * 1000;

const owner = (userId: string, overrides: Partial<Owner["user"]> = {}): Owner => ({
  userId,
  user: { email: `${userId}@example.com`, emailVerifiedAt: LONG_AGO, createdAt: LONG_AGO, ...overrides },
});
const OPS = owner("ops", { email: "ops@example.com" });
const PAID = { billingExempt: false, plan: "growth", planStatus: "active", currentPeriodEnd: new Date("2026-12-10T00:00:00Z") };

function workspace(id: string, fields: Row = {}, owners: Owner[] = [owner(`owner-of-${id}`)]): Workspace {
  const row = { id, billingExempt: false, ...fields, owners };
  store.workspaces.push(row);
  return row;
}

let othersSent = 0;

/** `n` more posts of a free workspace that other people sent on `at`'s day. */
async function sentElsewhere(n: number, at: Date) {
  if (!store.workspaces.some((w) => w.id === "ws-others")) workspace("ws-others");
  for (let i = 0; i < n; i += 1) {
    othersSent += 1;
    await recordSend({ workspaceId: "ws-others", postJobIds: [`other-${othersSent}`], at });
  }
}

const sendsOf = (postJobId: string) =>
  store.events.filter((event) => event.kind === "send" && String(event.sourceId).startsWith(`send:${postJobId}:`));

const FULL_AT_SEND =
  "Not sent: Vibe Socials had reached its daily limit of posts for the whole service when this post was due. Retry it tomorrow, or schedule it again.";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  store.events = [];
  store.posts = [];
  store.workspaces = [];
  store.down = false;
  vi.stubEnv("BILLING_ENABLED", "");
  vi.stubEnv("ADMIN_EMAILS", "ops@example.com");
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

// Point 1: the cap counts the send events, written as each post goes out.
describe("the service's cap counts one send per post per UTC day", () => {
  it("posts due 23:51-23:59 that go out in the 00:00 run count on the new day, each before the next is checked", async () => {
    workspace("ws-1");
    await sentElsewhere(40, new Date("2026-11-13T10:00:00Z"));
    const run = new Date("2026-11-14T00:00:30Z");
    await sentElsewhere(37, run);

    const outcomes: Array<string | null> = [];
    for (const id of ["due-51", "due-53", "due-55", "due-57", "due-59"]) {
      const refusal = await serviceCapRefusalAtSend({ workspaceId: "ws-1", postJobIds: [id], now: run });
      outcomes.push(refusal?.errorMessage ?? null);
      if (!refusal) await recordSend({ workspaceId: "ws-1", postJobIds: [id], at: run });
    }

    // Day 1's 40 do not count on day 2; 37 + 3 fill it, and the last two meet the cap.
    expect(outcomes).toEqual([null, null, null, FULL_AT_SEND, FULL_AT_SEND]);
    expect(sendsOf("due-51")[0]?.sourceId).toBe("send:due-51:2026-11-14");
  });

  it("40 sent today and a backlog of 3: all 3 are refused at send", async () => {
    workspace("ws-1");
    await sentElsewhere(40, NOW);
    for (const id of ["late-1", "late-2", "late-3"]) {
      expect((await serviceCapRefusalAtSend({ workspaceId: "ws-1", postJobIds: [id], now: NOW }))?.errorCode).toBe(
        "SERVICE_DAILY_POST_LIMIT",
      );
    }
  });

  it("a post sent, then retried twice the same day, counts once", async () => {
    workspace("ws-1");
    await recordSend({ workspaceId: "ws-1", postJobIds: ["post-a"], at: NOW });
    await recordRetry({ workspaceId: "ws-1", postJobId: "post-a", platforms: ["x"], requestId: "r1", at: NOW });
    await recordRetry({ workspaceId: "ws-1", postJobId: "post-a", platforms: ["x"], requestId: "r2", at: NOW });
    expect(sendsOf("post-a")).toHaveLength(1);
  });

  it("retried the next day, it counts once on that day", async () => {
    workspace("ws-1");
    await recordSend({ workspaceId: "ws-1", postJobIds: ["post-a"], at: DAY_1 });
    await recordRetry({ workspaceId: "ws-1", postJobId: "post-a", platforms: ["x"], requestId: "r1", at: NOW });
    await recordRetry({ workspaceId: "ws-1", postJobId: "post-a", platforms: ["x"], requestId: "r2", at: NOW });
    expect(sendsOf("post-a").map((event) => event.sourceId)).toEqual([
      "send:post-a:2026-11-13",
      "send:post-a:2026-11-14",
    ]);
  });

  it("deleting a workspace does not lower the day's count", async () => {
    workspace("ws-gone", {}, [owner("owner-1")]);
    workspace("ws-1");
    for (let i = 0; i < 40; i += 1) {
      await recordSend({ workspaceId: "ws-gone", postJobIds: [`gone-${i}`], at: NOW });
    }
    await copyUsageBeforeDeletion(
      (await import("@/lib/db")).prisma as never,
      { workspaceIds: ["ws-gone"], userId: "owner-1", now: NOW },
    );
    store.workspaces = store.workspaces.filter((w) => w.id !== "ws-gone");

    expect((await serviceCapRefusalAtSend({ workspaceId: "ws-1", postJobIds: ["next"], now: NOW }))?.errorCode).toBe(
      "SERVICE_DAILY_POST_LIMIT",
    );
  });

  it("a paying workspace's or the operator's sends are never counted, and they are never refused", async () => {
    vi.stubEnv("BILLING_ENABLED", "true");
    workspace("ws-paid", PAID);
    workspace("ws-ops", {}, [OPS]);
    workspace("ws-free", { trialEndsAt: new Date(NOW.getTime() + 5 * DAY) });
    for (let i = 0; i < 50; i += 1) {
      await recordSend({ workspaceId: "ws-paid", postJobIds: [`paid-${i}`], at: NOW });
      await recordSend({ workspaceId: "ws-ops", postJobIds: [`ops-${i}`], at: NOW });
    }
    await expect(serviceCapRefusalAtSend({ workspaceId: "ws-free", postJobIds: ["f"], now: NOW })).resolves.toBeNull();
    await sentElsewhere(40, NOW);
    await expect(serviceCapRefusalAtSend({ workspaceId: "ws-paid", postJobIds: ["p"], now: NOW })).resolves.toBeNull();
    await expect(serviceCapRefusalAtSend({ workspaceId: "ws-ops", postJobIds: ["o"], now: NOW })).resolves.toBeNull();
  });

  it("scheduling for a later day is never refused by it: nothing has been sent that day", async () => {
    workspace("ws-1");
    await sentElsewhere(40, NOW);
    await expect(
      crossWorkspacePostRefusal({
        workspaceId: "ws-1",
        workspace: {},
        day: new Date("2026-11-20T09:00:00Z"),
        mode: "schedule",
      }),
    ).resolves.toBeNull();
    expect(
      (await crossWorkspacePostRefusal({ workspaceId: "ws-1", workspace: {}, day: NOW, mode: "schedule" }))?.code,
    ).toBe("SERVICE_DAILY_POST_LIMIT");
  });
});

// Point 3: a Feed and Story pair passes or fails the cap together.
describe("a pair needs two places", () => {
  it("38 sent: the pair goes; 39 sent: neither half", async () => {
    workspace("ws-1");
    await sentElsewhere(38, NOW);
    await expect(
      serviceCapRefusalAtSend({ workspaceId: "ws-1", postJobIds: ["feed", "story"], now: NOW }),
    ).resolves.toBeNull();
    await sentElsewhere(1, NOW);
    expect(
      (await serviceCapRefusalAtSend({ workspaceId: "ws-1", postJobIds: ["feed", "story"], now: NOW }))?.errorMessage,
    ).toBe(FULL_AT_SEND);
  });

  it("Post now of a pair (alsoOnDay 1) meets the same rule", async () => {
    workspace("ws-1");
    await sentElsewhere(39, NOW);
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
    await sentElsewhere(38, NOW);
    await recordSend({ workspaceId: "ws-1", postJobIds: ["feed", "story"], at: NOW });
    await expect(serviceCapRefusalAtSend({ workspaceId: "ws-1", postJobIds: ["story"], now: NOW })).resolves.toBeNull();
  });
});

describe("the per-person total", () => {
  function livePosts(workspaceId: string, n: number, at: Date = NOW) {
    for (let i = 0; i < n; i += 1) {
      store.posts.push({ id: `${workspaceId}-live-${i}`, workspaceId, status: "scheduled", scheduledFor: at, createdAt: LONG_AGO });
    }
  }

  it("counts every owned free workspace's posts on the day and refuses the 31st", async () => {
    workspace("ws-1", {}, [owner("owner-1")]);
    workspace("ws-2", {}, [owner("owner-1")]);
    livePosts("ws-1", 15);
    livePosts("ws-2", 14);
    await expect(crossWorkspacePostRefusal({ workspaceId: "ws-1", workspace: {}, day: NOW, mode: "now" })).resolves.toBeNull();
    livePosts("ws-other-day", 0);
    store.posts.push({ id: "one-more", workspaceId: "ws-2", status: "completed", scheduledFor: null, createdAt: NOW });
    await expect(crossWorkspacePostRefusal({ workspaceId: "ws-1", workspace: {}, day: NOW, mode: "now" })).resolves.toEqual({
      code: "OWNER_DAILY_POST_LIMIT",
      error:
        "This workspace's owner has reached the limit of 30 posts a day across all the workspaces they own. Schedule this post for another day, or try again tomorrow.",
    });
  });

  it("an older post retried today counts once through its send, however many retries", async () => {
    workspace("ws-1", {}, [owner("owner-1")]);
    livePosts("ws-1", 29);
    await recordRetry({ workspaceId: "ws-1", postJobId: "old-post", platforms: ["x", "facebook_page"], requestId: "r1", at: NOW });
    await recordRetry({ workspaceId: "ws-1", postJobId: "old-post", platforms: ["x"], requestId: "r2", at: NOW });
    // 29 + the retried post = 30: one more is refused, a retry of the same post is not.
    expect((await crossWorkspacePostRefusal({ workspaceId: "ws-1", workspace: {}, day: NOW, mode: "now" }))?.code).toBe(
      "OWNER_DAILY_POST_LIMIT",
    );
    await expect(retryRefusal({ workspaceId: "ws-1", postJobId: "old-post", platforms: ["instagram"], now: NOW })).resolves.toBeNull();
  });

  it("a deleted workspace's sends keep counting toward the person who deleted it", async () => {
    workspace("ws-gone", {}, [owner("owner-1")]);
    workspace("ws-1", {}, [owner("owner-1")]);
    for (let i = 0; i < 30; i += 1) await recordSend({ workspaceId: "ws-gone", postJobIds: [`g-${i}`], at: NOW });
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
    livePosts("ws-1", 5);
    expect((await crossWorkspacePostRefusal({ workspaceId: "ws-1", workspace: {}, day: NOW, mode: "now" }))?.error).toBe(
      "This workspace's owner has reached the limit of 5 posts a day across all the workspaces they own. Schedule this post for another day, or try again tomorrow. The limit is 30 once the owner has confirmed their email address and the account is a day old.",
    );
    store.workspaces = [];
    store.posts = [];
    workspace("ws-2", {}, [owner("owner-2", { createdAt: new Date(NOW.getTime() - 3_600_000) })]);
    livePosts("ws-2", 5);
    expect((await crossWorkspacePostRefusal({ workspaceId: "ws-2", workspace: {}, day: NOW, mode: "schedule" }))?.code).toBe(
      "OWNER_DAILY_POST_LIMIT",
    );
  });

  it("with billing on, counts a workspace made while billing was off, never a paying one", async () => {
    vi.stubEnv("BILLING_ENABLED", "true");
    workspace("ws-old-free", {}, [owner("owner-1")]);
    workspace("ws-paid", PAID, [owner("owner-1")]);
    livePosts("ws-old-free", 30);
    livePosts("ws-paid", 100);
    expect(
      (await crossWorkspacePostRefusal({ workspaceId: "ws-old-free", workspace: { billingExempt: false }, day: NOW, mode: "now" }))?.code,
    ).toBe("OWNER_DAILY_POST_LIMIT");
    await expect(
      crossWorkspacePostRefusal({ workspaceId: "ws-paid", workspace: PAID, day: NOW, mode: "now" }),
    ).resolves.toBeNull();
  });

  it("never refuses the operator's workspaces", async () => {
    workspace("ws-ops", {}, [OPS]);
    livePosts("ws-ops", 100);
    await sentElsewhere(100, NOW);
    await expect(crossWorkspacePostRefusal({ workspaceId: "ws-ops", workspace: {}, day: NOW, mode: "now" })).resolves.toBeNull();
  });
});

// Point 2: retries count per platform; toward the caps through the post's send.
describe("retries", () => {
  it("4 failed platforms each retried once: all allowed, counted as one post", async () => {
    workspace("ws-1", {}, [owner("owner-1")]);
    const platforms = ["x", "facebook_page", "instagram", "linkedin"] as const;
    await expect(retryRefusal({ workspaceId: "ws-1", postJobId: "post-a", platforms: [...platforms], now: NOW })).resolves.toBeNull();
    await recordRetry({ workspaceId: "ws-1", postJobId: "post-a", platforms: [...platforms], requestId: "r1", at: NOW });
    expect(store.events.filter((event) => event.kind === "retry").map((event) => event.sourceId)).toEqual([
      "retry:post-a:x:r1",
      "retry:post-a:facebook_page:r1",
      "retry:post-a:instagram:r1",
      "retry:post-a:linkedin:r1",
    ]);
    expect(sendsOf("post-a")).toHaveLength(1);
  });

  it("one platform retried a 4th time is refused, naming it; the others are still allowed", async () => {
    workspace("ws-1", {}, [owner("owner-1")]);
    for (const requestId of ["r1", "r2", "r3"]) {
      await recordRetry({ workspaceId: "ws-1", postJobId: "post-a", platforms: ["x"], requestId, at: NOW });
    }
    await expect(retryRefusal({ workspaceId: "ws-1", postJobId: "post-a", platforms: ["x"], now: NOW })).resolves.toEqual({
      code: "POST_RETRY_LIMIT",
      error: "X on this post has been retried 3 times today, the most for one day. Try again tomorrow.",
    });
    await expect(retryRefusal({ workspaceId: "ws-1", postJobId: "post-a", platforms: ["facebook_page"], now: NOW })).resolves.toBeNull();
    // A retry of every failed platform that includes X is refused for X.
    expect((await retryRefusal({ workspaceId: "ws-1", postJobId: "post-a", platforms: ["facebook_page", "x"], now: NOW }))?.code).toBe(
      "POST_RETRY_LIMIT",
    );
  });

  it("the guard counts per UTC day: yesterday's retries leave today's three", async () => {
    workspace("ws-1", {}, [owner("owner-1")]);
    for (const requestId of ["r1", "r2", "r3"]) {
      await recordRetry({ workspaceId: "ws-1", postJobId: "post-a", platforms: ["x"], requestId, at: DAY_1 });
    }
    await expect(retryRefusal({ workspaceId: "ws-1", postJobId: "post-a", platforms: ["x"], now: NOW })).resolves.toBeNull();
  });

  it("a free post refused at send yesterday: all its platforms are retryable today", async () => {
    workspace("ws-1", {}, [owner("owner-1")]);
    await sentElsewhere(40, DAY_1);
    await expect(
      retryRefusal({ workspaceId: "ws-1", postJobId: "refused", platforms: ["x", "facebook_page", "instagram"], now: NOW }),
    ).resolves.toBeNull();
  });

  it("a paying workspace at the free cap may retry; the per-platform guard still applies to it", async () => {
    vi.stubEnv("BILLING_ENABLED", "true");
    workspace("ws-paid", PAID, [owner("owner-1")]);
    await sentElsewhere(40, NOW);
    await expect(retryRefusal({ workspaceId: "ws-paid", postJobId: "p", platforms: ["x"], now: NOW })).resolves.toBeNull();
    for (const requestId of ["r1", "r2", "r3"]) {
      await recordRetry({ workspaceId: "ws-paid", postJobId: "p", platforms: ["x"], requestId, at: NOW });
    }
    expect((await retryRefusal({ workspaceId: "ws-paid", postJobId: "p", platforms: ["x"], now: NOW }))?.code).toBe(
      "POST_RETRY_LIMIT",
    );
  });

  it("a free post not yet sent today is refused once the service's cap is full; one sent today is not", async () => {
    workspace("ws-1", {}, [owner("owner-1")]);
    await recordSend({ workspaceId: "ws-1", postJobIds: ["sent-today"], at: NOW });
    await sentElsewhere(39, NOW);
    expect((await retryRefusal({ workspaceId: "ws-1", postJobId: "from-yesterday", platforms: ["x"], now: NOW }))?.error).toBe(
      "Vibe Socials has reached its daily limit of posts for the whole service, and retries count toward it. Retry tomorrow.",
    );
    await expect(retryRefusal({ workspaceId: "ws-1", postJobId: "sent-today", platforms: ["x"], now: NOW })).resolves.toBeNull();
  });

  it("never refuses the operator's retries", async () => {
    workspace("ws-ops", {}, [OPS]);
    for (const requestId of ["r1", "r2", "r3", "r4"]) {
      await recordRetry({ workspaceId: "ws-ops", postJobId: "p", platforms: ["x"], requestId, at: NOW });
    }
    await expect(retryRefusal({ workspaceId: "ws-ops", postJobId: "p", platforms: ["x"], now: NOW })).resolves.toBeNull();
  });
});

describe("the checks fail open, and the operator is who the list says once verified", () => {
  it("a read error logs and allows, at send and for a retry", async () => {
    workspace("ws-1");
    store.down = true;
    await expect(serviceCapRefusalAtSend({ workspaceId: "ws-1", postJobIds: ["a"], now: NOW })).resolves.toBeNull();
    await expect(retryRefusal({ workspaceId: "ws-1", postJobId: "a", platforms: ["x"], now: NOW })).resolves.toBeNull();
  });

  it("an unverified address on the operator list is not the operator", async () => {
    workspace("ws-1", {}, [owner("x-1", { email: "ops@example.com", emailVerifiedAt: null, createdAt: LONG_AGO })]);
    await sentElsewhere(40, NOW);
    expect((await serviceCapRefusalAtSend({ workspaceId: "ws-1", postJobIds: ["a"], now: NOW }))?.errorCode).toBe(
      "SERVICE_DAILY_POST_LIMIT",
    );
  });
});
