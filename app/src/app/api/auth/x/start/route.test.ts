import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// R56 client-journey L1: about one start in ten clears expired X handshakes.
// A client's link handshake must outlive its 10 minutes by a day, so a client
// whose X sign-in took longer still reaches the callback's /c reopen page.
const { requireOwnerContextForOAuthStartMock, handshakeUpsertMock, handshakeDeleteManyMock, fetchWithinLimitMock } =
  vi.hoisted(() => ({
    requireOwnerContextForOAuthStartMock: vi.fn(),
    handshakeUpsertMock: vi.fn(),
    handshakeDeleteManyMock: vi.fn(),
    fetchWithinLimitMock: vi.fn(),
  }));

const { checkRateLimitMock } = vi.hoisted(() => ({ checkRateLimitMock: vi.fn() }));
vi.mock("@/lib/rateLimit", () => ({ checkRateLimit: checkRateLimitMock }));
vi.mock("@/lib/workspace", () => ({ requireOwnerContextForOAuthStart: requireOwnerContextForOAuthStartMock }));
vi.mock("@/lib/db", () => ({
  prisma: { oAuthHandshake: { upsert: handshakeUpsertMock, deleteMany: handshakeDeleteManyMock } },
}));
vi.mock("@/lib/fetchWithTimeout", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/fetchWithTimeout")>()),
  fetchWithinLimit: fetchWithinLimitMock,
}));

import { GET } from "./route";

const ORIGIN = "https://app.example.com";
const DAY_MS = 24 * 60 * 60 * 1000;

type Row = { connectLinkId: string | null; expiresAt: Date };
type Where = {
  OR?: Where[];
  connectLinkId?: null | { not: null };
  expiresAt?: { lt: Date };
};

/** Evaluates the clean-up's where clause the way the database would. */
function matches(row: Row, where: Where): boolean {
  if (where.OR && !where.OR.some((part) => matches(row, part))) return false;
  if (where.connectLinkId === null && row.connectLinkId !== null) return false;
  if (where.connectLinkId && "not" in where.connectLinkId && row.connectLinkId === null) return false;
  if (where.expiresAt && !(row.expiresAt.getTime() < where.expiresAt.lt.getTime())) return false;
  return true;
}

beforeEach(() => {
  vi.stubEnv("NEXTAUTH_URL", ORIGIN);
  vi.stubEnv("X_CONSUMER_KEY", "ck");
  vi.stubEnv("X_CONSUMER_SECRET", "cs");
  vi.stubEnv("X_CALLBACK_URL", `${ORIGIN}/api/auth/x/callback`);
  vi.spyOn(console, "log").mockImplementation(() => {});
  requireOwnerContextForOAuthStartMock.mockResolvedValue({ user: { id: "owner-1" }, workspace: { id: "ws-1" } });
  handshakeUpsertMock.mockResolvedValue({});
  checkRateLimitMock.mockResolvedValue({ allowed: true });
  handshakeDeleteManyMock.mockResolvedValue({ count: 0 });
  fetchWithinLimitMock.mockImplementation(async () => new Response("oauth_token=req-token&oauth_token_secret=req-secret"));
  // Make this the one start in ten that cleans up.
  vi.spyOn(Math, "random").mockReturnValue(0.05);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const mock of [checkRateLimitMock, requireOwnerContextForOAuthStartMock, handshakeUpsertMock, handshakeDeleteManyMock, fetchWithinLimitMock]) {
    mock.mockReset();
  }
});

async function cleanupWhere(): Promise<{ where: Where; now: number }> {
  const before = Date.now();
  const response = await GET(new NextRequest(`${ORIGIN}/api/auth/x/start`));
  expect(response.headers.get("location")).toContain("api.twitter.com/oauth/authorize");
  expect(handshakeDeleteManyMock).toHaveBeenCalledTimes(1);
  return { where: handshakeDeleteManyMock.mock.calls[0][0].where as Where, now: before };
}

describe("X start: the expired-handshake clean-up", () => {
  it("keeps a link's handshake expired less than a day ago, and deletes one expired over a day ago", async () => {
    const { where, now } = await cleanupWhere();
    expect(matches({ connectLinkId: "link-1", expiresAt: new Date(now - 60 * 1000) }, where)).toBe(false);
    expect(matches({ connectLinkId: "link-1", expiresAt: new Date(now - DAY_MS + 60 * 1000) }, where)).toBe(false);
    expect(matches({ connectLinkId: "link-1", expiresAt: new Date(now - DAY_MS - 60 * 1000) }, where)).toBe(true);
  });

  it("deletes an owner's handshake once expired, as before, and keeps a live one", async () => {
    const { where, now } = await cleanupWhere();
    expect(matches({ connectLinkId: null, expiresAt: new Date(now - 1000) }, where)).toBe(true);
    expect(matches({ connectLinkId: null, expiresAt: new Date(now + 60 * 1000) }, where)).toBe(false);
    expect(matches({ connectLinkId: "link-1", expiresAt: new Date(now + 60 * 1000) }, where)).toBe(false);
  });

  it("runs on about one start in ten, as before", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    await GET(new NextRequest(`${ORIGIN}/api/auth/x/start`));
    expect(handshakeDeleteManyMock).not.toHaveBeenCalled();
  });
});

// R61 security-billing-2 L1: each start makes one request-token call to X on
// the app's shared key, so starts are limited per person (30 an hour), failing
// closed as the client-link start does.
describe("X start: the per-person limit", () => {
  const start = () => GET(new NextRequest(`${ORIGIN}/api/auth/x/start`));

  it("under the limit: goes to X as before, counted per person and failing closed", async () => {
    const response = await start();

    expect(response.headers.get("location")).toContain("api.twitter.com/oauth/authorize");
    expect(fetchWithinLimitMock).toHaveBeenCalledTimes(1);
    expect(checkRateLimitMock).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "owner-1", limit: 30, windowMs: 60 * 60 * 1000, failClosed: true }),
    );
  });

  it("over the limit: back to Settings with x_too_many_tries, and no call to X", async () => {
    checkRateLimitMock.mockResolvedValue({ allowed: false, retryAfterSeconds: 600 });

    const response = await start();

    expect(response.headers.get("location")).toBe(`${ORIGIN}/settings?error=x_too_many_tries`);
    expect(fetchWithinLimitMock).not.toHaveBeenCalled();
    expect(handshakeUpsertMock).not.toHaveBeenCalled();
  });

  it("the limiter unavailable: refused with x_limit_unchecked, and no call to X", async () => {
    checkRateLimitMock.mockResolvedValue({ allowed: false, retryAfterSeconds: 60, unavailable: true });

    const response = await start();

    expect(response.headers.get("location")).toBe(`${ORIGIN}/settings?error=x_limit_unchecked`);
    expect(fetchWithinLimitMock).not.toHaveBeenCalled();
  });
});
