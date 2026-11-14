import { beforeEach, describe, expect, it, vi } from "vitest";

import { makeWorkspaceContext } from "../../__test-helpers__/workspaceContextMock";

/**
 * GET /api/dashboard/summary. The database is a small in-memory stand-in that
 * evaluates the Prisma `where` clauses the route sends against a list of rows,
 * so each test states which posts exist and checks what is counted.
 */

type Row = Record<string, unknown>;

const { state, getWorkspaceContextMock, checkRateLimitMock } = vi.hoisted(() => ({
  state: { jobs: [] as Row[], connections: [] as Row[], calls: [] as string[] },
  getWorkspaceContextMock: vi.fn(),
  checkRateLimitMock: vi.fn(),
}));

function matchValue(value: unknown, cond: unknown): boolean {
  if (cond === null) return value === null || value === undefined;
  if (cond instanceof Date) return value instanceof Date && value.getTime() === cond.getTime();
  if (typeof cond !== "object") return value === cond;
  const ops = cond as Record<string, unknown>;
  for (const [op, arg] of Object.entries(ops)) {
    const ok = (() => {
      switch (op) {
        case "in":
          return (arg as unknown[]).includes(value);
        case "notIn":
          return !(arg as unknown[]).includes(value);
        case "not":
          return !matchValue(value, arg);
        case "gt":
          return value instanceof Date && value.getTime() > (arg as Date).getTime();
        case "gte":
          return value instanceof Date && value.getTime() >= (arg as Date).getTime();
        case "lt":
          return value instanceof Date && value.getTime() < (arg as Date).getTime();
        case "lte":
          return value instanceof Date && value.getTime() <= (arg as Date).getTime();
        case "equals":
          return matchValue(value, arg);
        case "some":
          return Array.isArray(value) && value.some((item) => matches(item as Row, arg as Row));
        case "none":
          return Array.isArray(value) && !value.some((item) => matches(item as Row, arg as Row));
        default:
          throw new Error(`stand-in does not know the operator ${op}`);
      }
    })();
    if (!ok) return false;
  }
  return true;
}

function matches(row: Row, where: Row | undefined): boolean {
  if (!where) return true;
  return Object.entries(where).every(([key, cond]) => {
    if (key === "AND") return (cond as Row[]).every((w) => matches(row, w));
    if (key === "OR") return (cond as Row[]).some((w) => matches(row, w));
    if (key === "NOT") {
      const list = Array.isArray(cond) ? (cond as Row[]) : [cond as Row];
      return list.every((w) => !matches(row, w));
    }
    return matchValue(row[key], cond);
  });
}

vi.mock("@/lib/db", () => ({
  prisma: {
    postJob: {
      count: async ({ where }: { where: Row }) => {
        state.calls.push("postJob.count");
        return state.jobs.filter((job) => matches(job, where)).length;
      },
      findFirst: async ({ where, orderBy }: { where: Row; orderBy: Row }) => {
        state.calls.push("postJob.findFirst");
        expect(orderBy).toEqual({ scheduledFor: "asc" });
        const hits = state.jobs
          .filter((job) => matches(job, where))
          .sort((a, b) => (a.scheduledFor as Date).getTime() - (b.scheduledFor as Date).getTime());
        return hits[0] ?? null;
      },
      findMany: async () => {
        throw new Error("the summary must not load every job");
      },
    },
    socialConnection: {
      count: async ({ where }: { where: Row }) => {
        state.calls.push("socialConnection.count");
        return state.connections.filter((c) => matches(c, where)).length;
      },
      findFirst: async ({ where, select }: { where: Row; select: Row }) => {
        state.calls.push("socialConnection.findFirst");
        expect(select).toEqual({ metadata: true });
        return state.connections.find((c) => matches(c, where)) ?? null;
      },
    },
  },
}));
vi.mock("@/lib/workspace", () => ({ getWorkspaceContext: getWorkspaceContextMock }));
vi.mock("@/lib/rateLimit", () => ({ checkRateLimit: checkRateLimitMock }));

import { GET } from "./route";

const NOW = new Date("2026-11-14T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const ago = (days: number) => new Date(NOW.getTime() - days * DAY);
const ahead = (hours: number) => new Date(NOW.getTime() + hours * 60 * 60 * 1000);

let nextId = 0;
function job(fields: Row): Row {
  nextId += 1;
  return {
    id: `job-${nextId}`,
    workspaceId: "ws-1",
    status: "completed",
    createdAt: ago(1),
    updatedAt: ago(1),
    scheduledFor: null,
    submittedForApprovalAt: null,
    approvedAt: null,
    clientChangeRequestedAt: null,
    publishMetadata: null,
    baseCaption: "secret caption",
    results: [],
    ...fields,
  };
}

async function summary() {
  const response = await GET();
  return { status: response.status, body: await response.json() };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  state.jobs = [];
  state.connections = [];
  state.calls = [];
  getWorkspaceContextMock.mockReset();
  getWorkspaceContextMock.mockResolvedValue(makeWorkspaceContext());
  checkRateLimitMock.mockReset();
  checkRateLimitMock.mockResolvedValue({ allowed: true });
});

describe("GET /api/dashboard/summary", () => {
  it("401s when signed out and reads nothing", async () => {
    getWorkspaceContextMock.mockResolvedValue(null);
    const { status } = await summary();
    expect(status).toBe(401);
    expect(state.calls).toEqual([]);
  });

  it("429s when rate-limited, keyed on the user", async () => {
    checkRateLimitMock.mockResolvedValue({ allowed: false, retryAfterSeconds: 7 });
    const response = await GET();
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("7");
    expect(checkRateLimitMock).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "user-1", route: "dashboard/summary" }),
    );
    expect(state.calls).toEqual([]);
  });

  it("answers zeros and no next post for an empty workspace", async () => {
    const { status, body } = await summary();
    expect(status).toBe(200);
    expect(body).toEqual({
      problemsLast7Days: 0,
      awaitingYourApproval: 0,
      clientChangesRequested: 0,
      nextScheduled: null,
      chooseGoogleLocation: null,
    });
  });

  // F4 (R1 M4): a Google listing connected without a location fails every Google post.
  describe("chooseGoogleLocation", () => {
    const google = (metadata: unknown, workspaceId = "ws-1") => ({
      workspaceId,
      platform: "google_business_profile",
      metadata,
    });

    it("names the workspace when its Google connection has no location chosen", async () => {
      state.connections = [google({ locationName: null })];
      expect((await summary()).body.chooseGoogleLocation).toBe("Acme");
    });

    it("also for a connection with no metadata at all, or an empty location", async () => {
      state.connections = [google(null)];
      expect((await summary()).body.chooseGoogleLocation).toBe("Acme");
      state.connections = [google({ locationName: "  " })];
      expect((await summary()).body.chooseGoogleLocation).toBe("Acme");
    });

    it("is null once a location is chosen", async () => {
      state.connections = [google({ locationName: "locations/123", locationTitle: "Surf Co" })];
      expect((await summary()).body.chooseGoogleLocation).toBeNull();
    });

    it("is null without a Google connection, or for another workspace's", async () => {
      state.connections = [{ workspaceId: "ws-1", platform: "x", metadata: null }, google(null, "ws-2")];
      expect((await summary()).body.chooseGoogleLocation).toBeNull();
    });

    it("is null for a member, and nothing is read: only an owner chooses the location", async () => {
      getWorkspaceContextMock.mockResolvedValue(makeWorkspaceContext({ role: "member" }));
      state.connections = [google(null)];
      expect((await summary()).body.chooseGoogleLocation).toBeNull();
      expect(state.calls).not.toContain("socialConnection.findFirst");
    });
  });

  describe("problemsLast7Days", () => {
    it("counts a failed job 6 days old but not one 8 days old", async () => {
      state.jobs = [
        job({ status: "failed", createdAt: ago(6), updatedAt: ago(6) }),
        job({ status: "failed", createdAt: ago(8), updatedAt: ago(8) }),
      ];
      expect((await summary()).body.problemsLast7Days).toBe(1);
    });

    it("counts a completed job with one failed result", async () => {
      state.jobs = [
        job({ status: "completed", results: [{ status: "success" }, { status: "failed" }] }),
        job({ status: "completed", results: [{ status: "success" }] }),
      ];
      expect((await summary()).body.problemsLast7Days).toBe(1);
    });

    it("never counts a cancelled job, even with a failed result", async () => {
      state.jobs = [job({ status: "cancelled", results: [{ status: "failed" }] })];
      expect((await summary()).body.problemsLast7Days).toBe(0);
    });

    it("never counts another workspace's failed posts", async () => {
      state.jobs = [
        job({ workspaceId: "ws-other", status: "failed" }),
        job({ workspaceId: "ws-other", status: "completed", results: [{ status: "failed" }] }),
      ];
      expect((await summary()).body.problemsLast7Days).toBe(0);
    });
  });

  describe("awaitingYourApproval", () => {
    const pending = { submittedForApprovalAt: ago(1), approvedAt: null };

    it("counts held drafts and undecided scheduled rows for an owner", async () => {
      state.jobs = [
        job({ status: "draft", ...pending }),
        job({ status: "scheduled", scheduledFor: ahead(5), ...pending }),
        job({ status: "draft", submittedForApprovalAt: ago(1), approvedAt: ago(1) }),
        job({ status: "cancelled", ...pending }),
        job({ status: "completed", ...pending }),
        job({ status: "draft" }),
        job({ workspaceId: "ws-other", status: "draft", ...pending }),
      ];
      expect((await summary()).body.awaitingYourApproval).toBe(2);
    });

    it("is null for a member", async () => {
      getWorkspaceContextMock.mockResolvedValue(makeWorkspaceContext({ role: "member" }));
      state.jobs = [job({ status: "draft", ...pending })];
      expect((await summary()).body.awaitingYourApproval).toBeNull();
    });
  });

  describe("clientChangesRequested", () => {
    it("counts drafts and scheduled posts a client asked to change, in this workspace only", async () => {
      state.jobs = [
        job({ status: "draft", clientChangeRequestedAt: ago(1) }),
        job({ status: "scheduled", scheduledFor: ahead(3), clientChangeRequestedAt: ago(1) }),
        job({ status: "cancelled", clientChangeRequestedAt: ago(1) }),
        job({ status: "completed", clientChangeRequestedAt: ago(1) }),
        job({ status: "draft" }),
        job({ workspaceId: "ws-other", status: "draft", clientChangeRequestedAt: ago(1) }),
      ];
      expect((await summary()).body.clientChangesRequested).toBe(2);
    });
  });

  describe("nextScheduled", () => {
    it("is the earliest future scheduled post, skipping drafts, past times, cancelled and awaiting approval", async () => {
      state.jobs = [
        job({ status: "draft", scheduledFor: ahead(1) }),
        job({ status: "scheduled", scheduledFor: new Date(NOW.getTime() - 60_000) }),
        job({ status: "cancelled", scheduledFor: ahead(2) }),
        job({ status: "scheduled", scheduledFor: ahead(3), submittedForApprovalAt: ago(1), approvedAt: null }),
        job({ workspaceId: "ws-other", status: "scheduled", scheduledFor: ahead(4) }),
        job({
          status: "scheduled",
          scheduledFor: ahead(10),
          publishMetadata: { targetPlatforms: ["instagram", "facebook"] },
        }),
        job({
          status: "scheduled",
          scheduledFor: ahead(6),
          submittedForApprovalAt: ago(2),
          approvedAt: ago(1),
          publishMetadata: { targetPlatforms: ["instagram", "facebook", "linkedin"] },
        }),
      ];
      expect((await summary()).body.nextScheduled).toEqual({
        scheduledFor: ahead(6).toISOString(),
        platformCount: 3,
      });
    });

    it("counts the workspace's connections when the post has no chosen platforms", async () => {
      state.connections = [
        { workspaceId: "ws-1", platform: "instagram" },
        { workspaceId: "ws-1", platform: "facebook" },
        { workspaceId: "ws-other", platform: "linkedin" },
      ];
      state.jobs = [job({ status: "scheduled", scheduledFor: ahead(2) })];
      expect((await summary()).body.nextScheduled).toEqual({
        scheduledFor: ahead(2).toISOString(),
        platformCount: 2,
      });
    });

    it("sends no caption text or ids", async () => {
      state.jobs = [job({ status: "scheduled", scheduledFor: ahead(2), publishMetadata: { targetPlatforms: ["x"] } })];
      const { body } = await summary();
      const text = JSON.stringify(body);
      expect(text).not.toContain("secret caption");
      expect(text).not.toContain("job-");
      expect(text).not.toContain("ws-1");
    });
  });
});
