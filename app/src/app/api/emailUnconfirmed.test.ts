import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { makeWorkspaceContext } from "./__test-helpers__/workspaceContextMock";

/**
 * 23: with billing on, every route that creates or moves work refuses a person
 * whose email address is not confirmed, in a workspace on a trial or a plan,
 * with 403 EMAIL_UNCONFIRMED before it reads or writes anything. The routes and
 * the stand-ins are the pause test's (pausedWorkspace.test.ts); the last test
 * here checks this list is every route that makes the check.
 */

const { calls, getWorkspaceContextMock, getCurrentUserMock, checkRateLimitMock, inngestSendMock } =
  vi.hoisted(() => ({
    calls: [] as string[],
    getWorkspaceContextMock: vi.fn(),
    getCurrentUserMock: vi.fn(),
    checkRateLimitMock: vi.fn(),
    inngestSendMock: vi.fn(),
  }));

vi.mock("@/lib/db", () => {
  const model = (name: string) =>
    new Proxy(
      {},
      {
        get: (_target, method) => () => {
          calls.push(`${name}.${String(method)}`);
          return Promise.resolve(null);
        },
      },
    );
  const prisma: Record<string, unknown> = new Proxy(
    {},
    {
      get: (_target, key) => {
        if (key === "then") return undefined;
        if (key === "$transaction") {
          return (arg: unknown) => {
            calls.push("$transaction");
            return typeof arg === "function" ? arg(prisma) : Promise.all(arg as unknown[]);
          };
        }
        if (typeof key === "string" && key.startsWith("$")) {
          return () => {
            calls.push(key);
            return Promise.resolve([]);
          };
        }
        return model(String(key));
      },
    },
  );
  return { prisma };
});

vi.mock("@/lib/workspace", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/workspace")>()),
  getWorkspaceContext: getWorkspaceContextMock,
  getWorkspaceMemberCount: async () => 1,
}));
vi.mock("@/lib/auth", () => ({ getCurrentUser: getCurrentUserMock }));
vi.mock("@/lib/rateLimit", () => ({
  checkRateLimit: checkRateLimitMock,
  consumeFixedWindow: checkRateLimitMock,
  exhaustFixedWindow: vi.fn(),
}));
vi.mock("@/lib/inngest", () => ({ inngest: { send: inngestSendMock } }));
vi.mock("@/server/notifications/email", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/notifications/email")>()),
  sendEmail: vi.fn(),
}));

type Handler = (request: Request, context: { params: Promise<Record<string, string>> }) => Promise<Response>;

type RouteCase = {
  /** The route file, from src/app/api. */
  file: string;
  name: string;
  load: () => Promise<Record<string, unknown>>;
  method: "POST";
  params?: Record<string, string>;
  body?: unknown;
};

const GATED: RouteCase[] = [
  { file: "posts/route.ts", name: "POST /api/posts (create, any intent)", load: () => import("./posts/route"), method: "POST", body: { intent: "draft" } },
  { file: "posts/[postJobId]/publish/route.ts", name: "POST /api/posts/[id]/publish (schedule or publish a draft)", load: () => import("./posts/[postJobId]/publish/route"), method: "POST", params: { postJobId: "job-1" }, body: {} },
  { file: "posts/[postJobId]/approval/route.ts", name: "POST /api/posts/[id]/approval", load: () => import("./posts/[postJobId]/approval/route"), method: "POST", params: { postJobId: "job-1" }, body: { decision: "approve" } },
  { file: "posts/[postJobId]/retry/route.ts", name: "POST /api/posts/[id]/retry", load: () => import("./posts/[postJobId]/retry/route"), method: "POST", params: { postJobId: "job-1" }, body: {} },
  { file: "upload/route.ts", name: "POST /api/upload (upload token)", load: () => import("./upload/route"), method: "POST", body: { type: "blob.generate-client-token" } },
  { file: "media/route.ts", name: "POST /api/media (register an upload)", load: () => import("./media/route"), method: "POST", body: {} },
  { file: "posts/auto-caption/route.ts", name: "POST /api/posts/auto-caption", load: () => import("./posts/auto-caption/route"), method: "POST", body: {} },
  { file: "posts/enhance-caption/route.ts", name: "POST /api/posts/enhance-caption", load: () => import("./posts/enhance-caption/route"), method: "POST", body: {} },
  { file: "reviews/draft-response/route.ts", name: "POST /api/reviews/draft-response", load: () => import("./reviews/draft-response/route"), method: "POST", body: {} },
  { file: "reviews/[reviewId]/reply/route.ts", name: "POST /api/reviews/[id]/reply", load: () => import("./reviews/[reviewId]/reply/route"), method: "POST", params: { reviewId: "r-1" }, body: { comment: "Thanks", reviewName: "accounts/1/locations/2/reviews/3" } },
];

const NOW = new Date("2026-12-10T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;

type Person = { emailVerifiedAt: Date | null; googleLinkedAt: Date | null };

const UNCONFIRMED: Person = { emailVerifiedAt: null, googleLinkedAt: null };

/** A person in a workspace on a free trial, as one created with billing on is. */
function trialContext(person: Person, workspace: Record<string, unknown> = {}) {
  const base = makeWorkspaceContext({ email: "new@example.com" });
  return {
    ...base,
    user: { ...base.user, ...person },
    workspace: {
      ...base.workspace,
      billingExempt: false,
      plan: null,
      planStatus: null,
      trialEndsAt: new Date(NOW.getTime() + 5 * DAY),
      currentPeriodEnd: null,
      ...workspace,
    },
  };
}

type Result = { status: number; body: unknown } | { threw: unknown };

async function call(route: RouteCase): Promise<Result> {
  const mod = await route.load();
  const handler = mod[route.method] as Handler;
  const request = new Request("http://localhost/api/test", {
    method: route.method,
    headers: { "content-type": "application/json" },
    ...(route.body !== undefined ? { body: JSON.stringify(route.body) } : {}),
  });
  try {
    const response = await handler(request, { params: Promise.resolve(route.params ?? {}) });
    return { status: response.status, body: await response.json().catch(() => null) };
  } catch (threw) {
    // The stand-in database answers null everywhere; a route that got this far went past the check.
    return { threw };
  }
}

function codeOf(result: Result): string | undefined {
  return "status" in result ? (result.body as { code?: string } | null)?.code : undefined;
}

beforeEach(() => {
  calls.length = 0;
  getWorkspaceContextMock.mockReset();
  getCurrentUserMock.mockReset();
  checkRateLimitMock.mockReset();
  inngestSendMock.mockReset();
  checkRateLimitMock.mockResolvedValue({ allowed: true });
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.stubEnv("BILLING_ENABLED", "true");
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("routes that create or move work, billing on, an unconfirmed address", () => {
  it.each(GATED)("$name answers 403 EMAIL_UNCONFIRMED before reading or writing anything", async (route) => {
    getWorkspaceContextMock.mockResolvedValue(trialContext(UNCONFIRMED));

    const result = await call(route);

    expect(result).toEqual({
      status: 403,
      body: {
        error: "Confirm your email address to start posting. We sent a link to new@example.com.",
        code: "EMAIL_UNCONFIRMED",
      },
    });
    expect(calls).toEqual([]);
    expect(checkRateLimitMock).not.toHaveBeenCalled();
    expect(inngestSendMock).not.toHaveBeenCalled();
  });

  it.each(GATED)("$name answers 403 EMAIL_UNCONFIRMED in a workspace on a paid plan", async (route) => {
    getWorkspaceContextMock.mockResolvedValue(
      trialContext(UNCONFIRMED, { trialEndsAt: null, plan: "starter", planStatus: "active", currentPeriodEnd: new Date(NOW.getTime() + 20 * DAY) }),
    );
    expect(codeOf(await call(route))).toBe("EMAIL_UNCONFIRMED");
  });

  it.each(GATED)("$name lets a pause win, as it read before", async (route) => {
    getWorkspaceContextMock.mockResolvedValue(
      trialContext(UNCONFIRMED, { pausedAt: new Date("2026-12-09T00:00:00Z"), pausedReason: "Unpaid invoice." }),
    );
    expect(await call(route)).toEqual({
      status: 403,
      body: { error: expect.stringMatching(/^This workspace is paused: Unpaid invoice\. Contact .+\.$/), code: "WORKSPACE_PAUSED" },
    });
  });

  it.each(GATED)("$name lets an ended trial win, as it read before", async (route) => {
    getWorkspaceContextMock.mockResolvedValue(trialContext(UNCONFIRMED, { trialEndsAt: new Date(NOW.getTime() - DAY) }));
    expect(await call(route)).toEqual({
      status: 403,
      body: { error: expect.stringMatching(/^Your free trial has ended\. /), code: "PLAN_ENDED" },
    });
  });

  it.each(GATED)("$name is not refused for a confirmed address, a Google sign-in, or an exempt workspace", async (route) => {
    // The route's own throttle refusing is the cheapest proof it went past the check.
    checkRateLimitMock.mockResolvedValue({ allowed: false, retryAfterSeconds: 5 });
    for (const context of [
      trialContext({ emailVerifiedAt: new Date("2026-12-01T00:00:00Z"), googleLinkedAt: null }),
      trialContext({ emailVerifiedAt: null, googleLinkedAt: new Date("2026-12-01T00:00:00Z") }),
      trialContext(UNCONFIRMED, { trialEndsAt: null }),
      trialContext(UNCONFIRMED, { billingExempt: true }),
    ]) {
      getWorkspaceContextMock.mockResolvedValue(context);
      expect(codeOf(await call(route))).toBeUndefined();
    }
  });
});

describe("routes that create or move work, billing off", () => {
  it.each(GATED)("$name does not refuse an unconfirmed address", async (route) => {
    vi.stubEnv("BILLING_ENABLED", undefined);
    checkRateLimitMock.mockResolvedValue({ allowed: false, retryAfterSeconds: 5 });
    // With billing off getWorkspaceContext reads no billing columns.
    getWorkspaceContextMock.mockResolvedValue({ ...trialContext(UNCONFIRMED), workspace: makeWorkspaceContext().workspace });
    expect(codeOf(await call(route))).toBeUndefined();
  });
});

describe("the list above", () => {
  it("is every route that checks access, and no route checks the workspace alone any more", () => {
    const apiDir = fileURLToPath(new URL(".", import.meta.url));
    const routeFiles = (readdirSync(apiDir, { recursive: true }) as string[])
      .map((file) => file.replace(/\\/g, "/"))
      .filter((file) => /(^|\/)route\.ts$/.test(file));
    const source = (file: string) => readFileSync(join(apiDir, file), "utf8");
    expect(routeFiles.filter((file) => source(file).includes("accessBlockResponse(")).sort()).toEqual(
      GATED.map((route) => route.file).sort(),
    );
    expect(routeFiles.filter((file) => source(file).includes("workspaceBlockResponse("))).toEqual([]);
  });
});
