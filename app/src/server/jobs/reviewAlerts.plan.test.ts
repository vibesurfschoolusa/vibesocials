import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * P1: the new-review email goes only to workspaces whose plan includes it. A
 * Starter listing's new reviews are still marked as seen, so choosing Growth
 * later does not send a backlog of old reviews.
 */

const db = vi.hoisted(() => ({
  connectionFindUnique: vi.fn(),
  connectionUpdate: vi.fn(),
  memberFindMany: vi.fn(),
  sendEmail: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    socialConnection: { findUnique: db.connectionFindUnique, update: db.connectionUpdate },
    workspaceMember: { findMany: db.memberFindMany },
  },
}));
vi.mock("@/server/notifications/email", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/notifications/email")>()),
  sendEmail: db.sendEmail,
}));
vi.mock("@/server/googleReviews", () => ({ fetchReviews: vi.fn(async () => []), refreshAccessToken: vi.fn() }));
vi.mock("@/lib/logger", () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { sendReviewAlerts, type ReviewAlert } from "./reviewAlerts";

const NOW = new Date("2026-12-10T13:00:00.000Z");
const LATER = new Date("2026-12-30T00:00:00Z");
const LOCATION = "accounts/1/locations/22";
const STARTER = { plan: "starter", planStatus: "active", currentPeriodEnd: LATER };

const WORKSPACES: Record<string, Record<string, unknown>> = {
  "ws-starter": STARTER,
  "ws-growth": { ...STARTER, plan: "growth" },
  "ws-trial": { trialEndsAt: LATER },
  "ws-exempt": { ...STARTER, billingExempt: true },
};

const alert = (workspaceId: string): ReviewAlert => ({
  connectionId: `conn-${workspaceId}`,
  workspaceId,
  locationName: LOCATION,
  seenThrough: "2026-12-10T10:00:00Z",
  count: 1,
  reviewIds: [],
});

beforeEach(() => {
  for (const fn of Object.values(db)) fn.mockReset();
  db.connectionFindUnique.mockImplementation(async ({ where }: { where: { id: string } }) => {
    const workspaceId = where.id.replace("conn-", "");
    return {
      id: where.id,
      workspaceId,
      accessToken: "test-token",
      expiresAt: null,
      metadata: { locationName: LOCATION, locationTitle: "Surf Co" },
      workspace: { name: "Surf Co", ...WORKSPACES[workspaceId] },
    };
  });
  db.memberFindMany.mockImplementation(async ({ where }: { where: { workspaceId: string } }) => [
    { userId: `owner-${where.workspaceId}`, user: { email: `owner@${where.workspaceId}.example.com` } },
  ]);
  db.sendEmail.mockResolvedValue(undefined);
  db.connectionUpdate.mockResolvedValue({});
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

const sentTo = () => db.sendEmail.mock.calls.map((call) => (call[0] as { to: string }).to);
const markedIds = () => db.connectionUpdate.mock.calls.map((call) => (call[0] as { where: { id: string } }).where.id);

describe("the new-review email by plan", () => {
  it("with billing on, skips Starter (marker still moves) and emails Growth, a trial and an exempt workspace", async () => {
    vi.stubEnv("BILLING_ENABLED", "true");
    const alerts = Object.keys(WORKSPACES).map(alert);
    const result = await sendReviewAlerts(alerts, NOW, () => 0);

    expect(sentTo()).toEqual([
      "owner@ws-growth.example.com",
      "owner@ws-trial.example.com",
      "owner@ws-exempt.example.com",
    ]);
    expect(result).toMatchObject({ sent: 3, failed: 0 });
    expect(markedIds()).toEqual(alerts.map((a) => a.connectionId));
    expect(db.connectionFindUnique.mock.calls[0][0]).toMatchObject({
      include: { workspace: { select: { name: true, billingExempt: true, plan: true } } },
    });
  });

  it("with billing off, emails every workspace and reads only the name", async () => {
    vi.stubEnv("BILLING_ENABLED", "");
    await sendReviewAlerts(Object.keys(WORKSPACES).map(alert), NOW, () => 0);
    expect(sentTo()).toHaveLength(4);
    expect(db.connectionFindUnique.mock.calls[0][0]).toEqual({
      where: { id: "conn-ws-starter" },
      include: { workspace: { select: { name: true } } },
    });
  });
});
