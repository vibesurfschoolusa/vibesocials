import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  workspaceFindUnique: vi.fn(),
  postJobCount: vi.fn(),
  resultCount: vi.fn(),
  queryRaw: vi.fn(),
  memberFindMany: vi.fn(),
  releaseKey: vi.fn(),
}));
const { consumeFixedWindowMock, sendEmailMock, crossWorkspaceMock, xPostsMock, canSendMock, personalMock } = vi.hoisted(() => ({
  canSendMock: vi.fn(),
  personalMock: vi.fn(),
  consumeFixedWindowMock: vi.fn(),
  sendEmailMock: vi.fn(),
  crossWorkspaceMock: vi.fn(),
  xPostsMock: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    workspace: { findUnique: db.workspaceFindUnique },
    postJob: { count: db.postJobCount },
    postJobResult: { count: db.resultCount },
    workspaceMember: { findMany: db.memberFindMany },
    $queryRaw: db.queryRaw,
    rateLimitEntry: { deleteMany: db.releaseKey },
  },
}));
vi.mock("@/lib/rateLimit", () => ({ consumeFixedWindow: consumeFixedWindowMock }));
// R8-publishing L2: posting's fan-out rule has its own suite (deferredDispatch.test.ts).
vi.mock("@/server/jobs/posting", () => ({ deferredPostCanSend: canSendMock }));
vi.mock("@/server/notifications/email", () => ({ sendEmail: sendEmailMock }));
// R5-security M1: the counts across workspaces have their own suite (usageLog.test.ts).
vi.mock("./usageLog", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./usageLog")>()),
  crossWorkspacePostRefusal: crossWorkspaceMock,
  xPostsThisMonth: xPostsMock,
  ownersPersonalUsage: personalMock,
}));

import {
  checkDailyPostLimit,
  getWorkspaceUsageOrNull,
  checkStorageLimit,
  checkXMonthlyLimit,
  checkYoutubeDailyLimit,
  getWorkspaceLimits,
  getWorkspaceUsage,
  planChangeRaisesEveryLimit,
  planChangeRaisesLimit,
} from "./workspaceUsage";

const MB = 1024 * 1024;
const NOW = new Date("2026-11-10T15:00:00.000Z");

function workspaceRow(overrides: Record<string, number | null> = {}) {
  return {
    name: "Surf Co",
    limitPostsPerDay: null,
    limitXPostsPerMonth: null,
    limitYoutubeUploadsPerDay: null,
    limitStorageMb: null,
    ...overrides,
  };
}

beforeEach(() => {
  for (const mock of Object.values(db)) mock.mockReset();
  consumeFixedWindowMock.mockReset();
  sendEmailMock.mockReset();
  crossWorkspaceMock.mockReset();
  crossWorkspaceMock.mockResolvedValue(null);
  canSendMock.mockReset();
  canSendMock.mockResolvedValue(true);
  personalMock.mockReset();
  personalMock.mockResolvedValue([]);
  xPostsMock.mockReset();
  xPostsMock.mockResolvedValue(0);
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  db.workspaceFindUnique.mockResolvedValue(workspaceRow());
  db.postJobCount.mockResolvedValue(0);
  db.resultCount.mockResolvedValue(0);
  db.queryRaw.mockResolvedValue([{ total: BigInt(0) }]);
  db.memberFindMany.mockResolvedValue([
    { user: { id: "owner-1", email: "one@example.com" } },
    { user: { id: "owner-2", email: "two@example.com" } },
  ]);
  consumeFixedWindowMock.mockResolvedValue({ allowed: true });
  sendEmailMock.mockResolvedValue(true);
  db.releaseKey.mockResolvedValue({ count: 1 });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("getWorkspaceLimits", () => {
  it("reads the workspace's columns and resolves them over the environment", async () => {
    vi.stubEnv("LIMIT_POSTS_PER_DAY", "40");
    vi.stubEnv("LIMIT_X_POSTS_PER_MONTH", "");
    vi.stubEnv("LIMIT_YOUTUBE_UPLOADS_PER_DAY", "");
    vi.stubEnv("LIMIT_STORAGE_MB", "");
    db.workspaceFindUnique.mockResolvedValue(workspaceRow({ limitXPostsPerMonth: 5 }));

    await expect(getWorkspaceLimits("ws-1")).resolves.toEqual({
      postsPerDay: 40,
      xPostsPerMonth: 5,
      youtubeUploadsPerDay: 10,
      storageBytes: 5120 * MB,
    });
    expect(db.workspaceFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "ws-1" } }),
    );
  });
});

describe("checkDailyPostLimit", () => {
  it("allows a post while the day is under the limit, and emails no one", async () => {
    db.postJobCount.mockResolvedValue(19);

    await expect(
      checkDailyPostLimit({ workspaceId: "ws-1", day: NOW, mode: "now" }),
    ).resolves.toBeNull();
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it("counts the workspace's non-draft, non-cancelled posts by scheduledFor, else createdAt, in the UTC day", async () => {
    await checkDailyPostLimit({ workspaceId: "ws-1", day: new Date("2026-11-12T22:00:00Z"), mode: "schedule" });

    const start = new Date("2026-11-12T00:00:00.000Z");
    const end = new Date("2026-11-13T00:00:00.000Z");
    // Review of R3: a post that failed at creation still counts (R3-publishing L3
    // is accepted as a low), so Retry can never send past the day's limit.
    expect(db.postJobCount).toHaveBeenCalledWith({
      where: {
        workspaceId: "ws-1",
        status: { notIn: ["draft", "cancelled"] },
        OR: [
          { scheduledFor: { gte: start, lt: end } },
          { scheduledFor: null, createdAt: { gte: start, lt: end } },
        ],
      },
    });
  });

  it("leaves out the post being moved", async () => {
    await checkDailyPostLimit({
      workspaceId: "ws-1",
      day: NOW,
      mode: "schedule",
      excludePostJobId: "job-9",
    });

    expect(db.postJobCount.mock.calls[0][0].where.id).toEqual({ not: "job-9" });
  });

  // R3-client-journey M1: a Feed and Story card commits both halves at once.
  it("leaves out both halves of a pair being moved", async () => {
    await checkDailyPostLimit({
      workspaceId: "ws-1",
      day: NOW,
      mode: "schedule",
      excludePostJobId: ["feed-1", "story-1"],
    });

    expect(db.postJobCount.mock.calls[0][0].where.id).toEqual({ notIn: ["feed-1", "story-1"] });
  });

  it("refuses at the limit with the publish-now sentence and code", async () => {
    db.postJobCount.mockResolvedValue(20);
    // R46 pages-a L2: the sentence names the wait to 00:00 UTC, read at NOW.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);

    await expect(
      checkDailyPostLimit({ workspaceId: "ws-1", day: NOW, mode: "now" }),
    ).resolves.toEqual({
      code: "WORKSPACE_DAILY_POST_LIMIT",
      error:
        "This workspace has reached its limit of 20 posts for today. Schedule this post for another day, or try again in 9 hours.",
    });
    vi.useRealTimers();
  });

  it("refuses at the limit with the scheduling sentence", async () => {
    db.postJobCount.mockResolvedValue(25);

    const refusal = await checkDailyPostLimit({ workspaceId: "ws-1", day: NOW, mode: "schedule" });
    expect(refusal?.error).toBe(
      "That day already has 20 posts, which is this workspace's daily limit. Pick another day.",
    );
  });

  it("refuses everything when the limit is zero", async () => {
    db.workspaceFindUnique.mockResolvedValue(workspaceRow({ limitPostsPerDay: 0 }));
    db.postJobCount.mockResolvedValue(0);

    const refusal = await checkDailyPostLimit({ workspaceId: "ws-1", day: NOW, mode: "now" });
    expect(refusal?.code).toBe("WORKSPACE_DAILY_POST_LIMIT");
  });

  it("fails open when the count cannot be read", async () => {
    db.postJobCount.mockRejectedValue(new Error("db down"));

    await expect(
      checkDailyPostLimit({ workspaceId: "ws-1", day: NOW, mode: "now" }),
    ).resolves.toBeNull();
  });

  // 11 polish: a series counts its own earlier posts on the same day too.
  it("counts the request's own earlier posts on that day as well", async () => {
    db.postJobCount.mockResolvedValue(19);

    expect(
      await checkDailyPostLimit({ workspaceId: "ws-1", day: NOW, mode: "schedule", alsoOnDay: 1 }),
    ).toMatchObject({ code: "WORKSPACE_DAILY_POST_LIMIT" });
    expect(
      await checkDailyPostLimit({ workspaceId: "ws-1", day: NOW, mode: "schedule", alsoOnDay: 0 }),
    ).toBeNull();
  });
});

// R5-security M1: after the workspace's own limit, the limits across workspaces.
describe("checkDailyPostLimit - across workspaces", () => {
  it("asks for the per-person and service limits with the workspace's billing columns and the same exclusions", async () => {
    vi.stubEnv("BILLING_ENABLED", "true");
    const billing = {
      billingExempt: false,
      plan: null,
      planStatus: null,
      trialEndsAt: new Date(Date.now() + 10 * 24 * 60 * 60 * 1000),
      currentPeriodEnd: null,
    };
    db.workspaceFindUnique.mockResolvedValue({ ...workspaceRow(), ...billing });

    await checkDailyPostLimit({
      workspaceId: "ws-1",
      day: NOW,
      mode: "schedule",
      excludePostJobId: "job-9",
      alsoOnDay: 2,
      viewerUserId: "user-7",
    });

    expect(crossWorkspaceMock).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      workspace: expect.objectContaining(billing),
      day: NOW,
      mode: "schedule",
      excludePostJobId: "job-9",
      alsoOnDay: 2,
      // Second look, point 1: who reads the refusal.
      viewerUserId: "user-7",
    });
  });

  it("returns their refusal as it is, and emails nobody about it", async () => {
    const refusal = { error: "service full", code: "SERVICE_DAILY_POST_LIMIT" };
    crossWorkspaceMock.mockResolvedValue(refusal);

    await expect(checkDailyPostLimit({ workspaceId: "ws-1", day: NOW, mode: "now" })).resolves.toEqual(refusal);
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it("is not asked once the workspace's own limit refuses", async () => {
    db.postJobCount.mockResolvedValue(20);
    await checkDailyPostLimit({ workspaceId: "ws-1", day: NOW, mode: "now" });
    expect(crossWorkspaceMock).not.toHaveBeenCalled();
  });

  it("fails open when they cannot be read", async () => {
    crossWorkspaceMock.mockRejectedValue(new Error("db down"));
    await expect(checkDailyPostLimit({ workspaceId: "ws-1", day: NOW, mode: "now" })).resolves.toBeNull();
  });

  // R8-publishing L2: the limits across workspaces count runs; a half with nothing to send makes none.
  it("a pair going out now: its other half is a run only when it has something to send", async () => {
    const pair = { workspaceId: "ws-1", day: NOW, mode: "now" as const, excludePostJobId: ["job-1", "story-1"], alsoOnDay: 1 };
    canSendMock.mockResolvedValue(false);
    await checkDailyPostLimit(pair);
    expect(canSendMock).toHaveBeenCalledWith("story-1");
    expect(crossWorkspaceMock).toHaveBeenLastCalledWith(expect.objectContaining({ alsoOnDay: 0 }));

    canSendMock.mockResolvedValue(true);
    await checkDailyPostLimit(pair);
    expect(crossWorkspaceMock).toHaveBeenLastCalledWith(expect.objectContaining({ alsoOnDay: 1 }));
  });

  it("the half still counts as a post toward the workspace's own daily limit (its failed results are a post that day)", async () => {
    canSendMock.mockResolvedValue(false);
    db.postJobCount.mockResolvedValue(19);
    const refusal = await checkDailyPostLimit({
      workspaceId: "ws-1",
      day: NOW,
      mode: "now",
      excludePostJobId: ["job-1", "story-1"],
      alsoOnDay: 1,
    });
    expect(refusal?.code).toBe("WORKSPACE_DAILY_POST_LIMIT");
  });

  it("scheduling a pair counts both, whatever can send now", async () => {
    await checkDailyPostLimit({ workspaceId: "ws-1", day: NOW, mode: "schedule", excludePostJobId: ["job-1", "story-1"], alsoOnDay: 1 });
    expect(canSendMock).not.toHaveBeenCalled();
    expect(crossWorkspaceMock).toHaveBeenLastCalledWith(expect.objectContaining({ alsoOnDay: 1 }));
  });

  it("Post now says itself how many of its extra posts make a run (runsAlsoOnDay)", async () => {
    await checkDailyPostLimit({ workspaceId: "ws-1", day: NOW, mode: "now", alsoOnDay: 1, runsAlsoOnDay: 0 });
    expect(crossWorkspaceMock).toHaveBeenLastCalledWith(expect.objectContaining({ alsoOnDay: 0 }));
    expect(canSendMock).not.toHaveBeenCalled();
  });
});

describe("the limit-reached email", () => {
  it("emails every owner once per window, through a limit-1 counter that resets at the window's end", async () => {
    db.postJobCount.mockResolvedValue(20);

    await checkDailyPostLimit({ workspaceId: "ws-1", day: NOW, mode: "now" });

    expect(consumeFixedWindowMock).toHaveBeenCalledWith({
      key: "usage-limit-email:ws-1:postsPerDay:2026-11-10",
      limit: 1,
      resetAt: new Date("2026-11-11T00:00:00.000Z"),
      failClosed: true,
    });
    expect(db.memberFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { workspaceId: "ws-1", role: "owner" } }),
    );
    expect(sendEmailMock).toHaveBeenCalledTimes(2);
    expect(sendEmailMock).toHaveBeenCalledWith(
      expect.objectContaining({ to: "one@example.com", subject: "Surf Co reached a Vibe Socials limit" }),
      { idempotencyKey: "usage-limit/ws-1/postsPerDay/2026-11-10/owner-1", throwOnRetryable: true },
    );
    expect(sendEmailMock).toHaveBeenCalledWith(
      expect.objectContaining({ to: "two@example.com" }),
      { idempotencyKey: "usage-limit/ws-1/postsPerDay/2026-11-10/owner-2", throwOnRetryable: true },
    );
    expect(db.releaseKey).not.toHaveBeenCalled();
  });

  // R39 client-journey L2 + L3: the window is let go when no email went, and one
  // owner's retryable failure never stops the email to the next.
  it("the first owner fails retryably: the second is still sent and the day is let go", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    try {
      db.postJobCount.mockResolvedValue(20);
      sendEmailMock.mockRejectedValueOnce(new Error("resend 429")).mockResolvedValueOnce(true);

      await checkDailyPostLimit({ workspaceId: "ws-1", day: NOW, mode: "now" });
      expect(sendEmailMock.mock.calls.map(([params]) => params.to)).toEqual(["one@example.com", "two@example.com"]);
      expect(db.releaseKey).toHaveBeenCalledWith({ where: { key: "usage-limit-email:ws-1:postsPerDay:2026-11-10" } });
    } finally {
      vi.useRealTimers();
    }
  });

  it("the owners can't be read: the day is let go", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    try {
      db.postJobCount.mockResolvedValue(20);
      db.memberFindMany.mockRejectedValue(new Error("db blip"));

      await checkDailyPostLimit({ workspaceId: "ws-1", day: NOW, mode: "now" });
      expect(sendEmailMock).not.toHaveBeenCalled();
      expect(db.releaseKey).toHaveBeenCalledWith({ where: { key: "usage-limit-email:ws-1:postsPerDay:2026-11-10" } });
    } finally {
      vi.useRealTimers();
    }
  });

  // R39 lead review L1+L2: a future day's window is long, but a failed read sent nothing.
  it("a future day's window: the owners can't be read, so the claim is let go", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    try {
      db.postJobCount.mockResolvedValue(20);
      db.memberFindMany.mockRejectedValue(new Error("db blip"));

      await checkDailyPostLimit({ workspaceId: "ws-1", day: new Date("2026-11-14T18:00:00Z"), mode: "schedule" });
      expect(sendEmailMock).not.toHaveBeenCalled();
      expect(db.releaseKey).toHaveBeenCalledWith({ where: { key: "usage-limit-email:ws-1:postsPerDay:2026-11-14" } });
    } finally {
      vi.useRealTimers();
    }
  });

  // R39 lead review L3 + R40 security L1: a store blip sends with the keys only when the
  // window's key could not have been used more than 24 hours ago.
  describe("a counter store that can't answer", () => {
    beforeEach(() => {
      vi.useFakeTimers();
      consumeFixedWindowMock.mockResolvedValue({ allowed: false, retryAfterSeconds: 60, unavailable: true });
    });
    afterEach(() => vi.useRealTimers());

    it("storage and YouTube (today's window, claimed only today): sent with the keys", async () => {
      vi.setSystemTime(NOW);
      db.queryRaw.mockResolvedValue([{ total: BigInt(5120 * MB) }]);
      await checkStorageLimit("ws-1", NOW);
      expect(sendEmailMock.mock.calls.map(([, options]) => options.idempotencyKey)).toEqual([
        "usage-limit/ws-1/storage/2026-11-10/owner-1",
        "usage-limit/ws-1/storage/2026-11-10/owner-2",
      ]);
    });

    it("X posts on the last day of the month: nothing sent", async () => {
      const lastDay = new Date("2026-11-30T15:00:00.000Z");
      vi.setSystemTime(lastDay);
      xPostsMock.mockResolvedValue(30);
      const refusal = await checkXMonthlyLimit("ws-1", lastDay);
      await refusal!.notifyOwners();
      expect(sendEmailMock).not.toHaveBeenCalled();
      expect(db.releaseKey).not.toHaveBeenCalled();
    });

    it("X posts early in the month: nothing sent", async () => {
      vi.setSystemTime(NOW);
      xPostsMock.mockResolvedValue(30);
      const refusal = await checkXMonthlyLimit("ws-1", NOW);
      await refusal!.notifyOwners();
      expect(sendEmailMock).not.toHaveBeenCalled();
    });

    it("posts per day, on a day that could have been filled days ahead: nothing sent on that day", async () => {
      vi.setSystemTime(NOW);
      db.postJobCount.mockResolvedValue(20);
      await checkDailyPostLimit({ workspaceId: "ws-1", day: NOW, mode: "now" });
      expect(sendEmailMock).not.toHaveBeenCalled();
      expect(db.releaseKey).not.toHaveBeenCalled();
    });
  });

  // Resend keeps an idempotency key 24 hours; past that a lost reply could become a second copy.
  it("a month's window: a failed send keeps the claim, so no owner can get a second copy that month", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    try {
      xPostsMock.mockResolvedValue(30);
      sendEmailMock.mockRejectedValueOnce(new Error("network error")).mockResolvedValueOnce(true);

      const refusal = await checkXMonthlyLimit("ws-1", NOW);
      await refusal!.notifyOwners();
      expect(sendEmailMock).toHaveBeenCalledTimes(2);
      expect(db.releaseKey).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("is not sent again once the window's counter is used", async () => {
    db.postJobCount.mockResolvedValue(20);
    consumeFixedWindowMock.mockResolvedValue({ allowed: false, retryAfterSeconds: 10 });

    const refusal = await checkDailyPostLimit({ workspaceId: "ws-1", day: NOW, mode: "now" });

    expect(refusal).not.toBeNull();
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it("a send failure does not fail the caller", async () => {
    db.postJobCount.mockResolvedValue(20);
    sendEmailMock.mockRejectedValue(new Error("resend down"));

    const refusal = await checkDailyPostLimit({ workspaceId: "ws-1", day: NOW, mode: "now" });
    expect(refusal?.code).toBe("WORKSPACE_DAILY_POST_LIMIT");
  });

  it("names a future full day in the email and says other days are not affected", async () => {
    db.postJobCount.mockResolvedValue(20);

    await checkDailyPostLimit({ workspaceId: "ws-1", day: new Date("2026-11-12T18:00:00Z"), mode: "schedule" });

    expect(consumeFixedWindowMock).toHaveBeenCalledWith(
      expect.objectContaining({ key: "usage-limit-email:ws-1:postsPerDay:2026-11-12" }),
    );
    const html = (sendEmailMock.mock.calls[0][0] as { html: string }).html;
    expect(html).toContain(
      "<strong>Surf Co</strong> reached its limit of 20 posts for November 12, 2026 (UTC). Posts on other days are not affected.",
    );
    expect(html).not.toContain("possible again");
  });

  it("gives up waiting after 5 seconds: the caller gets its refusal, and the delay is logged", async () => {
    vi.useFakeTimers();
    try {
      db.postJobCount.mockResolvedValue(20);
      sendEmailMock.mockReturnValue(new Promise(() => {}));

      let settled = false;
      const pending = checkDailyPostLimit({ workspaceId: "ws-1", day: NOW, mode: "now" }).then((r) => {
        settled = true;
        return r;
      });
      await vi.advanceTimersByTimeAsync(4_900);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(200);
      await expect(pending).resolves.toMatchObject({ code: "WORKSPACE_DAILY_POST_LIMIT" });
      expect(console.error).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("an owner lookup that hangs is cut off after 5 seconds too", async () => {
    vi.useFakeTimers();
    try {
      xPostsMock.mockResolvedValue(30);
      db.memberFindMany.mockReturnValue(new Promise(() => {}));

      const refusal = await checkXMonthlyLimit("ws-1", NOW);
      const notified = refusal!.notifyOwners();
      await vi.advanceTimersByTimeAsync(5_000);
      await expect(notified).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("a failure to find the owners does not fail the caller", async () => {
    db.postJobCount.mockResolvedValue(20);
    db.memberFindMany.mockRejectedValue(new Error("db down"));

    const refusal = await checkDailyPostLimit({ workspaceId: "ws-1", day: NOW, mode: "now" });
    expect(refusal?.code).toBe("WORKSPACE_DAILY_POST_LIMIT");
  });

  it("X: the check sends nothing itself; notifyOwners does, with the UTC month as the window", async () => {
    xPostsMock.mockResolvedValue(30);

    const refusal = await checkXMonthlyLimit("ws-1", NOW);
    expect(consumeFixedWindowMock).not.toHaveBeenCalled();
    expect(sendEmailMock).not.toHaveBeenCalled();

    await refusal!.notifyOwners();
    expect(sendEmailMock).toHaveBeenCalledTimes(2);
    expect(consumeFixedWindowMock).toHaveBeenCalledWith({
      key: "usage-limit-email:ws-1:xPostsPerMonth:2026-11",
      limit: 1,
      resetAt: new Date("2026-12-01T00:00:00.000Z"),
      failClosed: true,
    });
  });

  it("YouTube: the check sends nothing itself; notifyOwners does, with the Pacific day as the window", async () => {
    db.resultCount.mockResolvedValue(10);

    const refusal = await checkYoutubeDailyLimit("ws-1", NOW);
    expect(consumeFixedWindowMock).not.toHaveBeenCalled();

    await refusal!.notifyOwners();
    expect(consumeFixedWindowMock).toHaveBeenCalledWith({
      key: "usage-limit-email:ws-1:youtubeUploadsPerDay:2026-11-10",
      limit: 1,
      resetAt: new Date("2026-11-11T08:00:00.000Z"),
      failClosed: true,
    });
  });

  it("uses the UTC day as the storage window", async () => {
    db.queryRaw.mockResolvedValue([{ total: BigInt(5120 * MB) }]);

    await checkStorageLimit("ws-1", NOW);

    expect(consumeFixedWindowMock).toHaveBeenCalledWith({
      key: "usage-limit-email:ws-1:storage:2026-11-10",
      limit: 1,
      resetAt: new Date("2026-11-11T00:00:00.000Z"),
      failClosed: true,
    });
  });
});

describe("checkXMonthlyLimit", () => {
  // R5-security M1: the X account's posts across workspaces, copied into the
  // log so a deletion or a disconnect does not start them again.
  it("counts the X account's posts this month across workspaces, copying the workspace's into the log", async () => {
    xPostsMock.mockResolvedValue(29);

    await expect(checkXMonthlyLimit("ws-1", NOW)).resolves.toBeNull();
    expect(xPostsMock).toHaveBeenCalledWith("ws-1", NOW);
  });

  it("refuses at the workspace's limit with X_MONTHLY_LIMIT and the month sentence", async () => {
    xPostsMock.mockResolvedValue(30);

    await expect(checkXMonthlyLimit("ws-1", NOW)).resolves.toEqual({
      errorCode: "X_MONTHLY_LIMIT",
      errorMessage:
        "This X account has used its 30 X posts for November, counted across every workspace it posts from. X posts start again on December 1, 2026.",
      notifyOwners: expect.any(Function),
    });
  });

  it("fails open when the count cannot be read", async () => {
    xPostsMock.mockRejectedValue(new Error("db down"));
    await expect(checkXMonthlyLimit("ws-1", NOW)).resolves.toBeNull();
  });
});

describe("checkYoutubeDailyLimit", () => {
  it("counts the workspace's successful YouTube results within the Pacific day", async () => {
    db.resultCount.mockResolvedValue(9);

    await expect(checkYoutubeDailyLimit("ws-1", NOW)).resolves.toBeNull();
    expect(db.resultCount).toHaveBeenCalledWith({
      where: {
        workspaceId: "ws-1",
        platform: "youtube",
        status: "success",
        updatedAt: {
          gte: new Date("2026-11-10T08:00:00.000Z"),
          lt: new Date("2026-11-11T08:00:00.000Z"),
        },
      },
    });
  });

  it("refuses at the limit with YOUTUBE_WORKSPACE_DAILY_LIMIT and its sentence", async () => {
    db.resultCount.mockResolvedValue(10);

    await expect(checkYoutubeDailyLimit("ws-1", NOW)).resolves.toEqual({
      errorCode: "YOUTUBE_WORKSPACE_DAILY_LIMIT",
      errorMessage:
        "This workspace has reached its limit of 10 YouTube uploads for today. Retry this upload tomorrow.",
      notifyOwners: expect.any(Function),
    });
  });
});

describe("checkStorageLimit", () => {
  it("sums the sizes of the workspace's live media as a bigint, with the workspace id as a parameter", async () => {
    db.queryRaw.mockResolvedValue([{ total: BigInt(100) }]);

    await expect(checkStorageLimit("ws-1", NOW)).resolves.toBeNull();
    const [strings, ...values] = db.queryRaw.mock.calls[0] as [TemplateStringsArray, ...unknown[]];
    expect(strings.join("$").replace(/\s+/g, " ").trim()).toBe(
      'SELECT COALESCE(SUM("sizeBytes"), 0)::bigint AS "total" FROM "MediaItem" WHERE "workspaceId" = $ AND "deletedAt" IS NULL',
    );
    expect(values).toEqual(["ws-1"]);
  });

  it("reads a total above 2^31 bytes correctly", async () => {
    const threeGb = 3 * 1024 * MB;
    expect(threeGb).toBeGreaterThan(2 ** 31);
    db.queryRaw.mockResolvedValue([{ total: BigInt(threeGb) }]);

    await expect(checkStorageLimit("ws-1", NOW)).resolves.toBeNull();
    expect((await getWorkspaceUsage("ws-1", NOW)).storage.used).toBe(threeGb);

    db.workspaceFindUnique.mockResolvedValue(workspaceRow({ limitStorageMb: 2048 }));
    await expect(checkStorageLimit("ws-1", NOW)).resolves.toMatchObject({ code: "WORKSPACE_STORAGE_FULL" });
  });

  it("refuses at or over the limit with the storage sentence", async () => {
    db.queryRaw.mockResolvedValue([{ total: BigInt(5120 * MB) }]);

    await expect(checkStorageLimit("ws-1", NOW)).resolves.toEqual({
      code: "WORKSPACE_STORAGE_FULL",
      error:
        "This workspace's media storage is full (5.0 GB). Delete media you no longer need on the Media page, then upload again.",
    });
  });

  it("allows just under the limit", async () => {
    db.queryRaw.mockResolvedValue([{ total: BigInt(5120 * MB - 1) }]);
    await expect(checkStorageLimit("ws-1", NOW)).resolves.toBeNull();
  });
});

describe("getWorkspaceUsage", () => {
  it("returns used and limit for all four, with when each starts again", async () => {
    db.postJobCount.mockResolvedValue(3);
    db.resultCount.mockResolvedValue(1);
    xPostsMock.mockResolvedValue(4);
    db.queryRaw.mockResolvedValue([{ total: BigInt(5 * MB) }]);

    await expect(getWorkspaceUsage("ws-1", NOW)).resolves.toEqual({
      postsToday: { used: 3, limit: 20, resetsAt: new Date("2026-11-11T00:00:00.000Z") },
      xPostsThisMonth: { used: 4, limit: 30, resetsAt: new Date("2026-12-01T00:00:00.000Z") },
      youtubeUploadsToday: { used: 1, limit: 10, resetsAt: new Date("2026-11-11T08:00:00.000Z") },
      storage: { used: 5 * MB, limit: 5120 * MB, resetsAt: null },
    });
    // Settings reads the X count the publish check refuses by, without writing.
    expect(xPostsMock).toHaveBeenCalledWith("ws-1", NOW);
  });

  // R8-pages M1 and review of T1, item 4: an owner sees their own line and their co-owners'.
  it("an owner reading it: every owner's count across their workspaces, theirs marked", async () => {
    const mine = { userId: "owner-1", name: "Jane", isViewer: true, used: 6, limit: 15, reduced: null };
    const theirs = { userId: "owner-2", name: "Lee", isViewer: false, used: 2, limit: 15, reduced: null };
    personalMock.mockResolvedValue([mine, theirs]);
    const usage = await getWorkspaceUsage("ws-1", NOW, "owner-1");
    expect(personalMock).toHaveBeenCalledWith("ws-1", NOW, "owner-1");
    expect(usage.people).toEqual([mine, theirs]);
    expect(usage).not.toHaveProperty("stillToday");
    await expect(getWorkspaceUsageOrNull("ws-1", NOW, "owner-1")).resolves.toMatchObject({ people: [mine, theirs] });
  });

  // Review of T1, item 4: a member sees no owner's details, only what the workspace can still send today.
  it("a member reading it: only how many posts the workspace can still send today and which limit decides", async () => {
    db.postJobCount.mockResolvedValue(3);
    personalMock.mockResolvedValue([
      { userId: "owner-1", name: "jane@example.com", isViewer: false, used: 12, limit: 15, reduced: null },
      { userId: "owner-2", name: "Lee", isViewer: false, used: 2, limit: 15, reduced: null },
    ]);
    const usage = await getWorkspaceUsage("ws-1", NOW, "member-1");
    expect(usage).not.toHaveProperty("people");
    expect(usage.stillToday).toEqual({ remaining: 3, decidedBy: "owner", coOwned: true });
    expect(JSON.stringify(usage)).not.toContain("jane@example.com");

    // The workspace's own limit is the closer one: 20 - 19 = 1 left.
    db.postJobCount.mockResolvedValue(19);
    personalMock.mockResolvedValue([{ userId: "owner-1", name: "Jane", isViewer: false, used: 4, limit: 15, reduced: null }]);
    await expect(getWorkspaceUsage("ws-1", NOW)).resolves.toMatchObject({
      stillToday: { remaining: 1, decidedBy: "workspace", coOwned: false },
    });
  });

});

describe("getWorkspaceUsageOrNull", () => {
  it("returns the usage when it can be read", async () => {
    await expect(getWorkspaceUsageOrNull("ws-1", NOW)).resolves.toMatchObject({
      postsToday: { used: 0, limit: 20 },
    });
  });

  it("returns null (and logs) when any count cannot be read, so Settings still renders", async () => {
    db.queryRaw.mockRejectedValue(new Error("db down"));

    await expect(getWorkspaceUsageOrNull("ws-1", NOW)).resolves.toBeNull();
    expect(console.error).toHaveBeenCalled();
  });
});

// F4: with billing on, a workspace with a plan to change is pointed to Settings, Plan.
describe("the limit-reached email - where a higher limit comes from (F4)", () => {
  it("billing off: the support address, and no extra query", async () => {
    vi.stubEnv("BILLING_ENABLED", "");
    db.postJobCount.mockResolvedValue(20);

    await checkDailyPostLimit({ workspaceId: "ws-1", day: NOW, mode: "now" });

    const html = (sendEmailMock.mock.calls[0][0] as { html: string }).html;
    expect(html).toContain("If you need a higher limit, write to");
    expect(db.workspaceFindUnique).toHaveBeenCalledTimes(1);
  });

  it("billing on, a workspace in its trial or on a plan: Settings, Plan through /go", async () => {
    vi.stubEnv("BILLING_ENABLED", "true");
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_example");
    // R43 security L2: a higher plan is on offer.
    vi.stubEnv("STRIPE_PRICE_GROWTH", "price_example_growth");
    vi.stubEnv("NEXTAUTH_URL", "https://vibesocials.wtf");
    db.workspaceFindUnique.mockResolvedValue({
      ...workspaceRow(),
      billingExempt: false,
      plan: "starter",
      planStatus: "active",
      trialEndsAt: null,
      currentPeriodEnd: new Date("2026-12-01T00:00:00Z"),
    });
    db.postJobCount.mockResolvedValue(1000);

    await checkDailyPostLimit({ workspaceId: "ws-1", day: NOW, mode: "now" });

    const html = (sendEmailMock.mock.calls[0][0] as { html: string }).html;
    expect(html).toContain('href="https://vibesocials.wtf/go?w=ws-1&amp;to=%2Fsettings%23plan"');
    expect(html).not.toContain("write to");
  });

  it("billing on, an exempt workspace: the support address", async () => {
    vi.stubEnv("BILLING_ENABLED", "true");
    db.workspaceFindUnique.mockResolvedValue({ ...workspaceRow(), billingExempt: true });
    db.postJobCount.mockResolvedValue(1000);

    await checkDailyPostLimit({ workspaceId: "ws-1", day: NOW, mode: "now" });

    const html = (sendEmailMock.mock.calls[0][0] as { html: string }).html;
    expect(html).toContain("If you need a higher limit, write to");
  });

  // R2-pages L3: the email points to a plan change exactly where Settings does
  // (planSectionActions), so it never sends an owner to a section with no button.
  it("billing on, a plan but no Stripe key (Settings shows no plan action): the support address", async () => {
    vi.stubEnv("BILLING_ENABLED", "true");
    vi.stubEnv("STRIPE_SECRET_KEY", "");
    db.workspaceFindUnique.mockResolvedValue({
      ...workspaceRow(),
      billingExempt: false,
      plan: "starter",
      planStatus: "active",
      trialEndsAt: null,
      currentPeriodEnd: new Date("2026-12-01T00:00:00Z"),
      stripeCustomerId: "cus_example",
    });
    db.postJobCount.mockResolvedValue(1000);

    await checkDailyPostLimit({ workspaceId: "ws-1", day: NOW, mode: "now" });

    const html = (sendEmailMock.mock.calls[0][0] as { html: string }).html;
    expect(html).toContain("If you need a higher limit, write to");
  });

  it("billing on, a trial with no plan offered (no prices set): the support address", async () => {
    vi.stubEnv("BILLING_ENABLED", "true");
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_example");
    vi.stubEnv("STRIPE_WEBHOOK_SECRET", "whsec_example");
    vi.stubEnv("STRIPE_PRICE_STARTER", "");
    vi.stubEnv("STRIPE_PRICE_PRO", "");
    vi.stubEnv("STRIPE_PRICE_GROWTH", "");
    db.workspaceFindUnique.mockResolvedValue({
      ...workspaceRow(),
      billingExempt: false,
      plan: null,
      planStatus: null,
      trialEndsAt: new Date(Date.now() + 10 * 24 * 60 * 60 * 1000),
      currentPeriodEnd: null,
      stripeCustomerId: null,
    });
    db.postJobCount.mockResolvedValue(1000);

    await checkDailyPostLimit({ workspaceId: "ws-1", day: NOW, mode: "now" });

    const html = (sendEmailMock.mock.calls[0][0] as { html: string }).html;
    expect(html).toContain("If you need a higher limit, write to");
  });

  it("billing on, a trial with a plan to choose: Settings, Plan, and the Stripe customer column is read", async () => {
    vi.stubEnv("BILLING_ENABLED", "true");
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_example");
    vi.stubEnv("STRIPE_WEBHOOK_SECRET", "whsec_example");
    vi.stubEnv("STRIPE_PRICE_STARTER", "price_example_starter");
    // R43 security L2: a trial has Starter's limits, so a higher plan must be on offer.
    vi.stubEnv("STRIPE_PRICE_GROWTH", "price_example_growth");
    db.workspaceFindUnique.mockResolvedValue({
      ...workspaceRow(),
      billingExempt: false,
      plan: null,
      planStatus: null,
      trialEndsAt: new Date(Date.now() + 10 * 24 * 60 * 60 * 1000),
      currentPeriodEnd: null,
      stripeCustomerId: null,
    });
    db.postJobCount.mockResolvedValue(1000);

    await checkDailyPostLimit({ workspaceId: "ws-1", day: NOW, mode: "now" });

    const html = (sendEmailMock.mock.calls[0][0] as { html: string }).html;
    expect(html).toContain("change this workspace's plan");
    const selects = db.workspaceFindUnique.mock.calls.map((call) => (call[0] as { select: Record<string, boolean> }).select);
    expect(selects.some((select) => select.stripeCustomerId === true)).toBe(true);
  });
});

// R43 security L2: a plan change is offered for a higher limit only where one
// gives it: a plan on offer with a higher number for that limit, and no
// operator override fixing it. Otherwise the owner writes in.
describe("planChangeRaisesLimit (R43 security L2)", () => {
  const ENV = {
    BILLING_ENABLED: "true",
    STRIPE_SECRET_KEY: "sk_test_example",
    STRIPE_WEBHOOK_SECRET: "whsec_example",
    STRIPE_PRICE_STARTER: "price_example_starter",
    STRIPE_PRICE_GROWTH: "price_example_growth",
    STRIPE_PRICE_PRO: "price_example_pro",
  };
  const onPlan = (plan: string, overrides: Record<string, number | null> = {}) => ({
    ...workspaceRow(overrides),
    billingExempt: false,
    plan,
    planStatus: "active",
    trialEndsAt: null,
    currentPeriodEnd: new Date("2026-12-01T00:00:00Z"),
    stripeCustomerId: "cus_example",
  });
  const KINDS = ["postsPerDay", "xPostsPerMonth", "youtubeUploadsPerDay", "storage"] as const;

  it("a Pro owner: no plan has a higher number, so never", () => {
    for (const kind of KINDS) expect(planChangeRaisesLimit(onPlan("pro"), kind, NOW, ENV)).toBe(false);
    expect(planChangeRaisesEveryLimit(onPlan("pro"), NOW, ENV)).toBe(false);
  });

  it("a Starter owner with no override: every limit", () => {
    for (const kind of KINDS) expect(planChangeRaisesLimit(onPlan("starter"), kind, NOW, ENV)).toBe(true);
    expect(planChangeRaisesEveryLimit(onPlan("starter"), NOW, ENV)).toBe(true);
  });

  it("a Starter owner with limitPostsPerDay set: not that limit, and not every limit", () => {
    const workspace = onPlan("starter", { limitPostsPerDay: 50 });
    expect(planChangeRaisesLimit(workspace, "postsPerDay", NOW, ENV)).toBe(false);
    expect(planChangeRaisesLimit(workspace, "xPostsPerMonth", NOW, ENV)).toBe(true);
    expect(planChangeRaisesEveryLimit(workspace, NOW, ENV)).toBe(false);
  });

  it("an override set to a low number still fixes the limit: an operator chose it", () => {
    expect(planChangeRaisesLimit(onPlan("starter", { limitStorageMb: 10 }), "storage", NOW, ENV)).toBe(false);
  });

  it("only offered plans count: Growth unpriced leaves Pro as the higher one", () => {
    const env = { ...ENV, STRIPE_PRICE_PRO: "", STRIPE_PRICE_GROWTH: "" };
    expect(planChangeRaisesLimit(onPlan("starter"), "postsPerDay", NOW, env)).toBe(false);
  });

  it("billing off or no plan action: never", () => {
    expect(planChangeRaisesLimit(onPlan("starter"), "postsPerDay", NOW, { ...ENV, BILLING_ENABLED: "" })).toBe(false);
    expect(planChangeRaisesLimit(onPlan("starter"), "postsPerDay", NOW, { ...ENV, STRIPE_SECRET_KEY: "" })).toBe(false);
  });

  describe("the limit-reached email uses it", () => {
    beforeEach(() => {
      for (const [name, value] of Object.entries(ENV)) vi.stubEnv(name, value);
      db.postJobCount.mockResolvedValue(1000);
    });

    it("a Pro owner: the support line", async () => {
      db.workspaceFindUnique.mockResolvedValue(onPlan("pro"));
      await checkDailyPostLimit({ workspaceId: "ws-1", day: NOW, mode: "now" });
      const html = (sendEmailMock.mock.calls[0][0] as { html: string }).html;
      expect(html).toContain("If you need a higher limit, write to hello@vibesocials.wtf");
      expect(html).not.toContain("change this workspace's plan");
    });

    it("a Starter owner with limitPostsPerDay set: the support line", async () => {
      db.workspaceFindUnique.mockResolvedValue(onPlan("starter", { limitPostsPerDay: 3 }));
      await checkDailyPostLimit({ workspaceId: "ws-1", day: NOW, mode: "now" });
      const html = (sendEmailMock.mock.calls[0][0] as { html: string }).html;
      expect(html).toContain("If you need a higher limit, write to hello@vibesocials.wtf");
    });

    it("a Starter owner with no override: the plan line, and the override columns are read", async () => {
      db.workspaceFindUnique.mockResolvedValue(onPlan("starter"));
      await checkDailyPostLimit({ workspaceId: "ws-1", day: NOW, mode: "now" });
      const html = (sendEmailMock.mock.calls[0][0] as { html: string }).html;
      expect(html).toContain("change this workspace's plan");
      const selects = db.workspaceFindUnique.mock.calls.map((call) => (call[0] as { select: Record<string, boolean> }).select);
      expect(selects.some((select) => select.stripeCustomerId === true && select.limitPostsPerDay === true)).toBe(true);
    });
  });
});

// R2-pages L4: each owner reads the dates in their own zone.
describe("the limit-reached email - dates in each owner's zone", () => {
  it("builds the email per owner with that owner's User.timeZone", async () => {
    db.workspaceFindUnique.mockResolvedValue(workspaceRow({ limitXPostsPerMonth: 30 }));
    db.memberFindMany.mockResolvedValue([
      { user: { id: "owner-1", email: "one@example.com", timeZone: "America/New_York" } },
      { user: { id: "owner-2", email: "two@example.com", timeZone: null } },
    ]);
    xPostsMock.mockResolvedValue(30);

    const refusal = await checkXMonthlyLimit("ws-1", NOW);
    await refusal?.notifyOwners();

    expect(db.memberFindMany).toHaveBeenCalledWith({
      where: { workspaceId: "ws-1", role: "owner" },
      select: { user: { select: { id: true, email: true, timeZone: true } } },
    });
    const [first, second] = sendEmailMock.mock.calls.map((call) => call[0] as { to: string; html: string });
    expect(first.to).toBe("one@example.com");
    expect(first.html).toContain("X posts start again on Mon, Nov 30, 2026, 7:00 PM EST.");
    expect(second.html).toContain("X posts start again on Tue, Dec 1, 2026, 12:00 AM UTC.");
  });
});
