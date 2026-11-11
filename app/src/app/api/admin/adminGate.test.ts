import { readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Every admin page and route answers the plain 404 to anyone who is not an
 * operator, and works for an operator. The files are discovered from disk, so a
 * page or route added later without the gate fails here; one added without an
 * operator case below fails too.
 */

const h = vi.hoisted(() => ({
  calls: [] as string[],
  getCurrentUser: vi.fn(),
  checkRateLimit: vi.fn(),
  after: vi.fn(),
  listAdminWorkspaces: vi.fn(),
  getAdminWorkspaceDetail: vi.fn(),
  setWorkspaceLimits: vi.fn(),
  pauseWorkspace: vi.fn(),
  resumeWorkspace: vi.fn(),
  exemptWorkspace: vi.fn(),
  startTrial: vi.fn(),
  endTrialNow: vi.fn(),
  NOT_FOUND: "NEXT_NOT_FOUND (test)",
}));

vi.mock("@/lib/auth", () => ({ getCurrentUser: h.getCurrentUser }));
vi.mock("@/lib/rateLimit", () => ({ checkRateLimit: h.checkRateLimit }));
vi.mock("@/lib/db", () => ({
  prisma: new Proxy(
    {},
    {
      get: (_t, model) =>
        new Proxy(
          {},
          {
            get: (_u, method) => () => {
              h.calls.push(`${String(model)}.${String(method)}`);
              return Promise.resolve(null);
            },
          },
        ),
    },
  ),
}));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error(h.NOT_FOUND);
  },
  redirect: (to: string) => {
    throw new Error(`redirect ${to}`);
  },
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: h.after,
}));
vi.mock("@/server/admin/queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/admin/queries")>()),
  listAdminWorkspaces: h.listAdminWorkspaces,
  getAdminWorkspaceDetail: h.getAdminWorkspaceDetail,
}));
vi.mock("@/server/admin/actions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/admin/actions")>()),
  setWorkspaceLimits: h.setWorkspaceLimits,
  pauseWorkspace: h.pauseWorkspace,
  resumeWorkspace: h.resumeWorkspace,
  exemptWorkspace: h.exemptWorkspace,
  startTrial: h.startTrial,
  endTrialNow: h.endTrialNow,
}));

import { adminOtherMethods } from "@/lib/operator";

const SRC = fileURLToPath(new URL("../../..", import.meta.url));
const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] as const;

function walk(dir: string, fileName: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return walk(full, fileName);
    return entry === fileName ? [full] : [];
  });
}

const key = (file: string) => relative(SRC, file).split(sep).join("/");
const PAGE_FILES = walk(join(SRC, "app", "admin"), "page.tsx");
const ROUTE_FILES = walk(join(SRC, "app", "api", "admin"), "route.ts");

type AnyHandler = (...args: unknown[]) => Promise<unknown>;

/** The trial route takes a date after today (UTC). */
const TOMORROW = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

/** What each real page or handler is called with, and what an operator should get. */
const OPERATOR_CASES: Record<string, { body?: unknown; expectStatus?: number }> = {
  "app/admin/page.tsx default": {},
  "app/admin/workspaces/[id]/page.tsx default": {},
  "app/api/admin/workspaces/[id]/limits/route.ts POST": { body: { limitPostsPerDay: 5 }, expectStatus: 200 },
  "app/api/admin/workspaces/[id]/pause/route.ts POST": { body: { reason: "Unpaid invoice." }, expectStatus: 200 },
  "app/api/admin/workspaces/[id]/resume/route.ts POST": { body: {}, expectStatus: 200 },
  "app/api/admin/workspaces/[id]/exempt/route.ts POST": { body: {}, expectStatus: 200 },
  "app/api/admin/workspaces/[id]/trial/route.ts POST": { body: { trialEndsAt: TOMORROW }, expectStatus: 200 },
  "app/api/admin/workspaces/[id]/end-trial/route.ts POST": { body: {}, expectStatus: 200 },
};

const ARGS = { params: Promise.resolve({ id: "ws-1" }), searchParams: Promise.resolve({}) };

function request(method: string, body?: unknown) {
  return new Request("http://localhost/api/admin/x", {
    method,
    headers: { "content-type": "application/json" },
    ...(body !== undefined && method !== "GET" ? { body: JSON.stringify(body) } : {}),
  });
}

type Entry = { name: string; call: (body?: unknown) => Promise<unknown>; real: boolean; kind: "page" | "route" };

async function entries(): Promise<Entry[]> {
  const list: Entry[] = [];
  for (const file of PAGE_FILES) {
    const mod = (await import(file)) as { default: AnyHandler };
    list.push({ name: `${key(file)} default`, call: () => mod.default(ARGS), real: true, kind: "page" });
  }
  for (const file of ROUTE_FILES) {
    const mod = (await import(file)) as Record<string, AnyHandler>;
    for (const method of METHODS) {
      const handler = mod[method];
      if (!handler) continue;
      list.push({
        name: `${key(file)} ${method}`,
        call: (body) => handler(request(method, body), { params: Promise.resolve({ id: "ws-1" }) }),
        real: handler !== adminOtherMethods[method],
        kind: "route",
      });
    }
  }
  return list;
}

const OPERATOR = { id: "op-1", email: "ops@example.com", emailVerifiedAt: new Date("2026-11-01T00:00:00Z") };

const NON_OPERATORS: Array<[string, () => void]> = [
  ["signed out", () => h.getCurrentUser.mockResolvedValue(null)],
  [
    "a normal user",
    () => h.getCurrentUser.mockResolvedValue({ id: "u-1", email: "someone@example.com", emailVerifiedAt: new Date() }),
  ],
  [
    "a listed user whose email is not verified",
    () => h.getCurrentUser.mockResolvedValue({ ...OPERATOR, emailVerifiedAt: null }),
  ],
  [
    "anyone, with no operators configured",
    () => {
      delete process.env.ADMIN_EMAILS;
      h.getCurrentUser.mockResolvedValue(OPERATOR);
    },
  ],
];

beforeEach(() => {
  h.calls.length = 0;
  for (const mock of [
    h.getCurrentUser,
    h.checkRateLimit,
    h.after,
    h.listAdminWorkspaces,
    h.getAdminWorkspaceDetail,
    h.setWorkspaceLimits,
    h.pauseWorkspace,
    h.resumeWorkspace,
    h.exemptWorkspace,
    h.startTrial,
    h.endTrialNow,
  ]) {
    mock.mockReset();
  }
  process.env.ADMIN_EMAILS = "ops@example.com";
  h.checkRateLimit.mockResolvedValue({ allowed: true });
  h.listAdminWorkspaces.mockResolvedValue({ rows: [], hasNextPage: false });
  h.getAdminWorkspaceDetail.mockResolvedValue({
    workspace: {
      id: "ws-1",
      name: "Surf Co",
      createdAt: new Date("2026-11-01T00:00:00Z"),
      ownerEmails: ["owner@example.com"],
      memberCount: 1,
      platforms: [],
      reconnectCount: 0,
      published30d: 0,
      failed30d: 0,
      storageBytes: 0,
      pausedAt: null,
      planState: "exempt",
    },
    pausedReason: null,
    billing: {
      enabled: false,
      state: "exempt",
      billingExempt: true,
      plan: null,
      planStatus: null,
      trialEndsAt: null,
      currentPeriodEnd: null,
    },
    overrides: { limitPostsPerDay: null, limitXPostsPerMonth: null, limitYoutubeUploadsPerDay: null, limitStorageMb: null },
    effectiveLimits: { postsPerDay: 20, xPostsPerMonth: 30, youtubeUploadsPerDay: 10, storageBytes: 1 },
    defaultLimits: { postsPerDay: 20, xPostsPerMonth: 30, youtubeUploadsPerDay: 10, storageBytes: 1 },
    usage: null,
    actions: [],
  });
  h.setWorkspaceLimits.mockResolvedValue({ status: "changed" });
  h.pauseWorkspace.mockResolvedValue({ status: "changed", actionId: "act-1", workspaceName: "Surf Co" });
  h.resumeWorkspace.mockResolvedValue({ status: "changed", actionId: "act-2", workspaceName: "Surf Co" });
  h.exemptWorkspace.mockResolvedValue({ status: "changed" });
  h.startTrial.mockResolvedValue({ status: "changed" });
  h.endTrialNow.mockResolvedValue({ status: "changed" });
});

describe("the admin files", () => {
  it("are the two pages and the six routes, each with an operator case", async () => {
    expect(PAGE_FILES.map(key).sort()).toEqual(["app/admin/page.tsx", "app/admin/workspaces/[id]/page.tsx"]);
    const real = (await entries()).filter((entry) => entry.real).map((entry) => entry.name);
    expect(real.sort()).toEqual(Object.keys(OPERATOR_CASES).sort());
  });
});

describe.each(NON_OPERATORS)("for %s", (_label, arrange) => {
  it("every admin page answers the app's 404 and every admin route a plain 404, touching nothing", async () => {
    const all = await entries();
    expect(all.length).toBeGreaterThan(0);
    for (const entry of all) {
      arrange();
      const outcome = await entry.call(OPERATOR_CASES[entry.name]?.body).then(
        (value) => ({ value }),
        (error: Error) => ({ error }),
      );
      if (entry.kind === "page") {
        expect(outcome, entry.name).toEqual({ error: new Error(h.NOT_FOUND) });
      } else {
        const response = (outcome as { value: Response }).value;
        expect(response.status, entry.name).toBe(404);
        expect(await response.json(), entry.name).toEqual({ error: "Not found" });
        expect(response.headers.get("allow"), entry.name).toBeNull();
      }
    }
    expect(h.calls).toEqual([]);
    expect(h.checkRateLimit).not.toHaveBeenCalled();
    for (const mock of [
      h.listAdminWorkspaces,
      h.getAdminWorkspaceDetail,
      h.setWorkspaceLimits,
      h.pauseWorkspace,
      h.resumeWorkspace,
      h.exemptWorkspace,
      h.startTrial,
      h.endTrialNow,
      h.after,
    ]) {
      expect(mock).not.toHaveBeenCalled();
    }
  });
});

describe("for an operator", () => {
  it("every admin page renders and every admin route does its work", async () => {
    for (const entry of (await entries()).filter((e) => e.real)) {
      h.getCurrentUser.mockResolvedValue(OPERATOR);
      const testCase = OPERATOR_CASES[entry.name];
      const result = await entry.call(testCase.body);
      if (entry.kind === "page") {
        expect(result, entry.name).toBeTruthy();
      } else {
        expect((result as Response).status, entry.name).toBe(testCase.expectStatus);
      }
    }
    expect(h.checkRateLimit).toHaveBeenCalled();
  });

  it("the other methods of each route still answer 404, so none reveals the route", async () => {
    h.getCurrentUser.mockResolvedValue(OPERATOR);
    for (const entry of (await entries()).filter((e) => !e.real)) {
      const response = (await entry.call()) as Response;
      expect(response.status, entry.name).toBe(404);
    }
  });
});
