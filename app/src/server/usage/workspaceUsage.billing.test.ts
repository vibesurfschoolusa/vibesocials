import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({ workspaceFindUnique: vi.fn() }));
vi.mock("@/lib/db", () => ({ prisma: { workspace: { findUnique: db.workspaceFindUnique } } }));
vi.mock("@/lib/rateLimit", () => ({ consumeFixedWindow: vi.fn() }));
vi.mock("@/server/notifications/email", () => ({ sendEmail: vi.fn() }));

import { PLANS } from "@/lib/plans";

import { getWorkspaceLimits } from "./workspaceUsage";

/** 21a: the usage checks read the plan columns in the same query, only with billing on. */

const LIMIT_SELECT = {
  name: true,
  limitPostsPerDay: true,
  limitXPostsPerMonth: true,
  limitYoutubeUploadsPerDay: true,
  limitStorageMb: true,
};
const ROW = {
  name: "Surf Co",
  limitPostsPerDay: null,
  limitXPostsPerMonth: null,
  limitYoutubeUploadsPerDay: null,
  limitStorageMb: null,
};

beforeEach(() => {
  db.workspaceFindUnique.mockReset();
  for (const name of ["LIMIT_POSTS_PER_DAY", "LIMIT_X_POSTS_PER_MONTH", "LIMIT_YOUTUBE_UPLOADS_PER_DAY", "LIMIT_STORAGE_MB"]) {
    vi.stubEnv(name, "");
  }
  vi.stubEnv("BILLING_ENABLED", "");
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("getWorkspaceLimits", () => {
  it("with billing off, makes today's query", async () => {
    db.workspaceFindUnique.mockResolvedValue(ROW);
    await getWorkspaceLimits("ws-1");
    expect(db.workspaceFindUnique).toHaveBeenCalledWith({ where: { id: "ws-1" }, select: LIMIT_SELECT });
  });

  it("with billing on, reads the plan columns too and resolves the plan's limits", async () => {
    vi.stubEnv("BILLING_ENABLED", "true");
    db.workspaceFindUnique.mockResolvedValue({
      ...ROW,
      billingExempt: false,
      plan: "growth",
      planStatus: "active",
      trialEndsAt: null,
      currentPeriodEnd: null,
    });

    const limits = await getWorkspaceLimits("ws-1");

    expect(db.workspaceFindUnique).toHaveBeenCalledWith({
      where: { id: "ws-1" },
      select: {
        ...LIMIT_SELECT,
        billingExempt: true,
        plan: true,
        planStatus: true,
        trialEndsAt: true,
        currentPeriodEnd: true,
      },
    });
    expect(limits.postsPerDay).toBe(PLANS.growth.limits.postsPerDay);
    expect(limits.storageBytes).toBe(PLANS.growth.limits.storageMb * 1024 * 1024);
  });
});
