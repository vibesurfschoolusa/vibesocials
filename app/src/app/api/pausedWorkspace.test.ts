import { beforeEach, describe, expect, it, vi } from "vitest";

import { makeWorkspaceContext } from "./__test-helpers__/workspaceContextMock";

/**
 * Pause (2026-11-10): every signed-in route that creates or moves work refuses a
 * paused workspace with 403 WORKSPACE_PAUSED before it reads or writes anything,
 * and the routes a paused customer needs to see their data and leave do not.
 *
 * The database is a recording stand-in: every call is logged and answers null,
 * so "nothing was read or written" is an empty log. The other side effects
 * (rate-limit counters, Inngest, email) are mocks checked the same way.
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
        get: (_target, method) => (..._args: unknown[]) => {
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
  requireOwnerContext: async () => {
    const context = await getWorkspaceContextMock();
    if (!context) {
      const { NextResponse } = await import("next/server");
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    return context;
  },
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
  name: string;
  load: () => Promise<Record<string, unknown>>;
  method: "GET" | "POST" | "PATCH" | "DELETE";
  params?: Record<string, string>;
  body?: unknown;
};

const GATED: RouteCase[] = [
  { name: "POST /api/posts (create, any intent)", load: () => import("./posts/route"), method: "POST", body: { intent: "draft" } },
  { name: "POST /api/posts/[id]/publish (schedule or publish a draft)", load: () => import("./posts/[postJobId]/publish/route"), method: "POST", params: { postJobId: "job-1" }, body: {} },
  { name: "POST /api/posts/[id]/approval", load: () => import("./posts/[postJobId]/approval/route"), method: "POST", params: { postJobId: "job-1" }, body: { decision: "approve" } },
  { name: "POST /api/posts/[id]/retry", load: () => import("./posts/[postJobId]/retry/route"), method: "POST", params: { postJobId: "job-1" }, body: {} },
  { name: "POST /api/upload (upload token)", load: () => import("./upload/route"), method: "POST", body: { type: "blob.generate-client-token" } },
  { name: "POST /api/media (register an upload)", load: () => import("./media/route"), method: "POST", body: {} },
  { name: "POST /api/posts/auto-caption", load: () => import("./posts/auto-caption/route"), method: "POST", body: {} },
  { name: "POST /api/posts/enhance-caption", load: () => import("./posts/enhance-caption/route"), method: "POST", body: {} },
  { name: "POST /api/reviews/draft-response", load: () => import("./reviews/draft-response/route"), method: "POST", body: {} },
  { name: "POST /api/reviews/[id]/reply", load: () => import("./reviews/[reviewId]/reply/route"), method: "POST", params: { reviewId: "r-1" }, body: { comment: "Thanks", reviewName: "accounts/1/locations/2/reviews/3" } },
];

/** What a paused customer must still be able to do: see their data, tidy up, change settings, leave. */
const ALLOWED: RouteCase[] = [
  { name: "GET /api/posts (read)", load: () => import("./posts/route"), method: "GET" },
  { name: "GET /api/media (read)", load: () => import("./media/route"), method: "GET" },
  { name: "PATCH /api/posts/[id] (edit a draft's text)", load: () => import("./posts/[postJobId]/route"), method: "PATCH", params: { postJobId: "job-1" }, body: { baseCaption: "New text" } },
  { name: "DELETE /api/posts/[id]", load: () => import("./posts/[postJobId]/route"), method: "DELETE", params: { postJobId: "job-1" } },
  { name: "POST /api/posts/[id]/cancel", load: () => import("./posts/[postJobId]/cancel/route"), method: "POST", params: { postJobId: "job-1" } },
  { name: "DELETE /api/media/[id]", load: () => import("./media/[id]/route"), method: "DELETE", params: { id: "media-1" } },
  { name: "POST /api/settings", load: () => import("./settings/route"), method: "POST", body: { defaultHashtags: "#surf" } },
  { name: "DELETE /api/connections/[platform] (disconnect)", load: () => import("./connections/[platform]/route"), method: "DELETE", params: { platform: "x" } },
  { name: "DELETE /api/auth/account (delete the account)", load: () => import("./auth/account/route"), method: "DELETE", body: { confirm: "DELETE" } },
];

function paused() {
  return makeWorkspaceContext({ pausedAt: new Date("2026-11-10T08:00:00Z"), pausedReason: "Unpaid invoice." });
}

async function call(route: RouteCase): Promise<{ status: number; body: unknown } | { threw: unknown }> {
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
    // A stand-in database answers null everywhere, so a route that got this far
    // may trip over it; that still proves the pause did not stop it.
    return { threw };
  }
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
});

describe("routes that create or move work, for a paused workspace", () => {
  it.each(GATED)("$name answers 403 WORKSPACE_PAUSED before reading or writing anything", async (route) => {
    getWorkspaceContextMock.mockResolvedValue(paused());

    const result = await call(route);

    expect(result).toEqual({
      status: 403,
      body: {
        error: expect.stringMatching(/^This workspace is paused: Unpaid invoice\. Contact .+\.$/),
        code: "WORKSPACE_PAUSED",
      },
    });
    expect(calls).toEqual([]);
    expect(checkRateLimitMock).not.toHaveBeenCalled();
    expect(inngestSendMock).not.toHaveBeenCalled();
  });

  it.each(GATED)("$name still answers 401 when signed out", async (route) => {
    getWorkspaceContextMock.mockResolvedValue(null);
    const result = await call(route);
    expect(result).toMatchObject({ status: 401 });
  });

  it.each(GATED)("$name is not refused for a workspace that is not paused", async (route) => {
    getWorkspaceContextMock.mockResolvedValue(makeWorkspaceContext());
    // The route's own throttle refusing is the cheapest proof it went past the check.
    checkRateLimitMock.mockResolvedValue({ allowed: false, retryAfterSeconds: 5 });

    const result = await call(route);

    if ("status" in result) {
      expect((result.body as { code?: string } | null)?.code).not.toBe("WORKSPACE_PAUSED");
    }
  });
});

describe("routes a paused workspace keeps", () => {
  it.each(ALLOWED)("$name is not refused while paused", async (route) => {
    getWorkspaceContextMock.mockResolvedValue(paused());
    getCurrentUserMock.mockResolvedValue({ id: "user-1", email: "owner@example.com", passwordHash: null });

    const result = await call(route);

    if ("status" in result) {
      expect((result.body as { code?: string } | null)?.code).not.toBe("WORKSPACE_PAUSED");
      expect(result.status).not.toBe(401);
    }
    // It went on to do its work: it read, counted or wrote something.
    expect(calls.length + checkRateLimitMock.mock.calls.length).toBeGreaterThan(0);
  });
});
