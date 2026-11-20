import type { SocialConnection } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_FETCH_TIMEOUT_MS, FETCH_TIMEOUT_CODE } from "@/lib/fetchWithTimeout";
import { abortSignalTimeoutOnFakeClock, bodyNeverEnds } from "@/lib/stallingFetch.testkit";

// A missing bound must be a quick red test, never a hung run.
const STALL_TEST_TIMEOUT_MS = 5_000;
import { refreshLinkedInToken } from "@/server/platforms/linkedinClient";
import { refreshPinterestToken } from "@/server/platforms/pinterestClient";
import { refreshTikTokToken } from "@/server/platforms/tiktokClient";

// R47 platform L1: every token refresh's limit covers the body too
// (fetchWithinLimit). A refresh whose headers came and whose body stalls ends
// as FETCH_TIMEOUT within the limit: nothing is written and nothing flagged.
// The real fetch helpers run here over a stubbed global fetch; no database.
const { updateMock, findUniqueMock } = vi.hoisted(() => ({
  updateMock: vi.fn(),
  findUniqueMock: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: { socialConnection: { update: updateMock, findUnique: findUniqueMock } },
}));

function makeConnection(platform: string): SocialConnection {
  return {
    id: "conn-1",
    userId: "user-1",
    workspaceId: "workspace-1",
    platform,
    accessToken: "old-access",
    refreshToken: "old-refresh",
    expiresAt: new Date("2020-01-01T00:00:00Z"),
    accountIdentifier: "acct-1",
    scopes: null,
    metadata: null,
    needsReconnect: false,
    lastRefreshErrorCode: null,
    refreshFailedAt: null,
    reconnectEmailedAt: null,
    expiryWarnedFor: null,
    createdAt: new Date("2020-01-01T00:00:00Z"),
    updatedAt: new Date("2020-01-01T00:00:00Z"),
  } as SocialConnection;
}

/** Headers with `status` at once, then an error body that never ends. */
function errorBodyNeverEnds(status: number) {
  return (_input: string | URL, init?: RequestInit): Promise<Response> => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"error":'));
        init?.signal?.addEventListener("abort", () => controller.error(init.signal?.reason));
      },
    });
    return Promise.resolve(new Response(body, { status, headers: { "content-type": "application/json" } }));
  };
}

async function settleWithin(promise: Promise<unknown>, ms: number): Promise<unknown> {
  const settled = promise.then(
    () => "resolved",
    (error: unknown) => error,
  );
  await vi.advanceTimersByTimeAsync(ms);
  return Promise.race([settled, Promise.resolve("still waiting")]);
}

beforeEach(() => {
  updateMock.mockReset();
  findUniqueMock.mockReset();
  findUniqueMock.mockResolvedValue({ accessToken: "old-access", refreshToken: "old-refresh" });
  vi.stubEnv("PINTEREST_APP_ID", "1234567");
  vi.stubEnv("PINTEREST_APP_SECRET", "app-secret");
  vi.stubEnv("PINTEREST_REDIRECT_URI", "https://app.example.com/api/auth/pinterest/callback");
  vi.stubEnv("LINKEDIN_CLIENT_ID", "test-client-id");
  vi.stubEnv("LINKEDIN_CLIENT_SECRET", "test-client-secret");
  vi.stubEnv("TIKTOK_CLIENT_KEY", "test-client-key");
  vi.stubEnv("TIKTOK_CLIENT_SECRET", "test-client-secret");
  vi.useFakeTimers();
  abortSignalTimeoutOnFakeClock();
  for (const method of ["log", "info", "warn", "error"] as const) {
    vi.spyOn(console, method).mockImplementation(() => undefined);
  }
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const refreshers = [
  ["Pinterest", "pinterest", refreshPinterestToken],
  ["LinkedIn", "linkedin", refreshLinkedInToken],
  ["TikTok", "tiktok", refreshTikTokToken],
] as const;

describe.each(refreshers)("%s token refresh: a stalled body", (_name, platform, refresh) => {
  it("a 200 whose body never ends rejects with FETCH_TIMEOUT within the limit, and writes nothing", async () => {
    vi.stubGlobal("fetch", vi.fn(bodyNeverEnds));

    const out = await settleWithin(refresh(makeConnection(platform)), DEFAULT_FETCH_TIMEOUT_MS);

    expect(out).toMatchObject({ code: FETCH_TIMEOUT_CODE });
    expect(updateMock).not.toHaveBeenCalled();
  }, STALL_TEST_TIMEOUT_MS);

  it("an error body that never ends is bounded too: FETCH_TIMEOUT, and the connection is not flagged", async () => {
    vi.stubGlobal("fetch", vi.fn(errorBodyNeverEnds(400)));

    const out = await settleWithin(refresh(makeConnection(platform)), DEFAULT_FETCH_TIMEOUT_MS);

    expect(out).toMatchObject({ code: FETCH_TIMEOUT_CODE });
    expect(updateMock).not.toHaveBeenCalled();
  }, STALL_TEST_TIMEOUT_MS);
});
