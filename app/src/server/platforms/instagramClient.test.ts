import type { MediaItem, SocialConnection, User } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  computeInstagramCaption,
  ensureFreshInstagramToken,
  instagramClient,
} from "@/server/platforms/instagramClient";

// Instagram stores a long-lived Facebook PAGE token with no refresh path, so
// the core behavior to pin is the expiry guard: usable token -> returned
// as-is; expired/near-expired -> a clean, coded reconnect error.
//
// ensureFreshInstagramToken() itself still has no DB import — Roadmap Phase 4
// marking is wrapped at instagramClient's call sites (publishVideo,
// refreshToken), not inside the guard, so it stays synchronous and directly
// testable. But instagramClient.ts now imports connectionHealth.ts (which
// resolves prisma via `await import("@/lib/db")` at call time), so the mock
// below is required for the refreshToken() tests further down.
const { updateMock } = vi.hoisted(() => ({ updateMock: vi.fn() }));

vi.mock("@/lib/db", () => ({
  prisma: {
    socialConnection: {
      update: updateMock,
    },
  },
}));

beforeEach(() => {
  updateMock.mockReset();
  updateMock.mockResolvedValue({});
});

afterEach(() => {
  vi.restoreAllMocks();
});

function makeConnection(
  overrides: Partial<SocialConnection> = {},
): SocialConnection {
  return {
    id: "conn-1",
    userId: "user-1",
    workspaceId: "workspace-1",
    platform: "instagram",
    accessToken: "page-access-token",
    refreshToken: null,
    expiresAt: new Date("2020-01-01T00:00:00Z"),
    accountIdentifier: "ig-account-1",
    scopes: null,
    metadata: { username: "acme", pageId: "page-1" },
    needsReconnect: false,
    lastRefreshErrorCode: null,
    refreshFailedAt: null,
    createdAt: new Date("2020-01-01T00:00:00Z"),
    updatedAt: new Date("2020-01-01T00:00:00Z"),
    ...overrides,
  };
}

describe("ensureFreshInstagramToken", () => {
  it("returns the connection unchanged when the token is comfortably fresh", () => {
    const future = new Date(Date.now() + 24 * 60 * 60 * 1000); // 1 day ahead
    const connection = makeConnection({ expiresAt: future });

    expect(ensureFreshInstagramToken(connection)).toBe(connection);
  });

  it("returns the connection unchanged when no expiry is recorded (cannot judge)", () => {
    const connection = makeConnection({ expiresAt: null });

    expect(ensureFreshInstagramToken(connection)).toBe(connection);
  });

  it("throws INSTAGRAM_RECONNECT_REQUIRED with an actionable message when the token has expired", () => {
    const connection = makeConnection(); // expiresAt in the past

    const error = (() => {
      try {
        ensureFreshInstagramToken(connection);
        return null;
      } catch (e) {
        return e as Error & { code?: string };
      }
    })();

    expect(error?.code).toBe("INSTAGRAM_RECONNECT_REQUIRED");
    expect(error?.message).toContain("reconnect");
  });

  it("throws INSTAGRAM_RECONNECT_REQUIRED when the token is within the 5-minute safety buffer", () => {
    const almostExpired = new Date(Date.now() + 2 * 60 * 1000); // 2 min ahead
    const connection = makeConnection({ expiresAt: almostExpired });

    const error = (() => {
      try {
        ensureFreshInstagramToken(connection);
        return null;
      } catch (e) {
        return e as Error & { code?: string };
      }
    })();

    expect(error?.code).toBe("INSTAGRAM_RECONNECT_REQUIRED");
  });
});

describe("instagramClient.refreshToken", () => {
  it("returns the connection unchanged without touching the database when the token is fresh", async () => {
    const future = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const connection = makeConnection({ expiresAt: future });

    const result = await instagramClient.refreshToken!(connection);

    expect(result).toBe(connection);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("marks needsReconnect (flag fields only, no tokens) and rethrows INSTAGRAM_RECONNECT_REQUIRED when expired", async () => {
    const connection = makeConnection({ id: "conn-99" }); // expiresAt in the past

    const error = await instagramClient
      .refreshToken!(connection)
      .then(() => null)
      .catch((e: unknown) => e as Error & { code?: string });

    expect(error?.code).toBe("INSTAGRAM_RECONNECT_REQUIRED");

    // Roadmap Phase 4: marked before the error propagates — flag fields
    // only, never accessToken/refreshToken.
    expect(updateMock).toHaveBeenCalledTimes(1);
    const arg = updateMock.mock.calls[0][0] as {
      where: { id: string };
      data: Record<string, unknown>;
    };
    expect(arg.where).toEqual({ id: "conn-99" });
    expect(Object.keys(arg.data).sort()).toEqual([
      "lastRefreshErrorCode",
      "needsReconnect",
      "refreshFailedAt",
    ]);
    expect(arg.data.needsReconnect).toBe(true);
    expect(arg.data.lastRefreshErrorCode).toBe("INSTAGRAM_RECONNECT_REQUIRED");
    expect(arg.data).not.toHaveProperty("accessToken");
    expect(arg.data).not.toHaveProperty("refreshToken");
  });
});

// 2026-11-01 audit (Task 4 item 3): the Graph API reports a dead page token as
// an OAuthException with code 190 — usually with HTTP 400, not 401. Instagram
// must treat it as reconnect-required exactly like facebookPageClient does
// (same shared detection), at every Graph call of the publish flow.
describe("instagramClient.publishVideo — Graph OAuthException 190", () => {
  const AUTH_ERROR_BODY = JSON.stringify({
    error: {
      message: "Error validating access token: Session has expired.",
      type: "OAuthException",
      code: 190,
      error_subcode: 463,
    },
  });
  const PARAM_ERROR_BODY = JSON.stringify({
    error: { message: "Invalid parameter", type: "OAuthException", code: 100 },
  });

  function ctx(mimeType: string) {
    return {
      user: { id: "user-1" } as unknown as User,
      socialConnection: makeConnection({ id: "conn-ig", expiresAt: null }),
      mediaItem: {
        mimeType,
        storageLocation: "https://blob.example.com/m",
        metadata: null,
      } as unknown as MediaItem,
      caption: "hello",
    };
  }

  function stubGraph(routes: { container: () => Response; status?: () => Response; publish?: () => Response }) {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL) => {
        const url = String(input);
        if (url.includes("/media_publish")) return Promise.resolve(routes.publish!());
        if (url.includes("/ig-account-1/media")) return Promise.resolve(routes.container());
        if (url.includes("fields=status_code")) return Promise.resolve(routes.status!());
        throw new Error(`Unexpected fetch in test: ${url}`);
      }),
    );
  }

  function expectFlagged() {
    expect(updateMock).toHaveBeenCalledTimes(1);
    const arg = updateMock.mock.calls[0][0] as { where: { id: string }; data: Record<string, unknown> };
    expect(arg.where).toEqual({ id: "conn-ig" });
    expect(arg.data.needsReconnect).toBe(true);
    expect(arg.data.lastRefreshErrorCode).toBe("INSTAGRAM_RECONNECT_REQUIRED");
    expect(arg.data).not.toHaveProperty("accessToken");
  }

  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("maps an HTTP 400 OAuthException 190 from container creation to INSTAGRAM_RECONNECT_REQUIRED and flags", async () => {
    stubGraph({ container: () => new Response(AUTH_ERROR_BODY, { status: 400 }) });

    const error = await instagramClient
      .publishVideo(ctx("image/jpeg"))
      .then(() => null)
      .catch((e: unknown) => e as Error & { code?: string });

    expect(error?.code).toBe("INSTAGRAM_RECONNECT_REQUIRED");
    expect(error?.message).not.toContain("Session has expired");
    expectFlagged();
  });

  it("maps an HTTP 400 OAuthException 190 from media_publish to the reconnect error and flags", async () => {
    vi.useFakeTimers();
    stubGraph({
      container: () => new Response(JSON.stringify({ id: "container-1" }), { status: 200 }),
      publish: () => new Response(AUTH_ERROR_BODY, { status: 400 }),
    });

    const promise = instagramClient
      .publishVideo(ctx("image/jpeg"))
      .then(() => null)
      .catch((e: unknown) => e as Error & { code?: string });
    await vi.advanceTimersByTimeAsync(3_000);

    expect((await promise)?.code).toBe("INSTAGRAM_RECONNECT_REQUIRED");
    expectFlagged();
  });

  it("stops polling and maps an OAuthException 190 from the video status check to the reconnect error", async () => {
    vi.useFakeTimers();
    const statusMock = vi.fn(() => new Response(AUTH_ERROR_BODY, { status: 400 }));
    stubGraph({
      container: () => new Response(JSON.stringify({ id: "container-1" }), { status: 200 }),
      status: statusMock,
    });

    const promise = instagramClient
      .publishVideo(ctx("video/mp4"))
      .then(() => null)
      .catch((e: unknown) => e as Error & { code?: string });
    await vi.advanceTimersByTimeAsync(5_000);

    expect((await promise)?.code).toBe("INSTAGRAM_RECONNECT_REQUIRED");
    expect(statusMock).toHaveBeenCalledTimes(1);
    expectFlagged();
  });

  it("keeps a non-auth Graph error (code 100) as INSTAGRAM_CONTAINER_FAILED without flagging", async () => {
    stubGraph({ container: () => new Response(PARAM_ERROR_BODY, { status: 400 }) });

    const error = await instagramClient
      .publishVideo(ctx("image/jpeg"))
      .then(() => null)
      .catch((e: unknown) => e as Error & { code?: string });

    expect(error?.code).toBe("INSTAGRAM_CONTAINER_FAILED");
    expect(updateMock).not.toHaveBeenCalled();
  });
});


describe("computeInstagramCaption (2,200-character limit, 2026-11-01 audit)", () => {
  it("leaves a caption at or under the limit untouched", () => {
    expect(computeInstagramCaption("hello")).toBe("hello");
    const exactly = "a".repeat(2200);
    expect(computeInstagramCaption(exactly)).toBe(exactly);
  });

  it("truncates an over-long caption to 2,200 characters", () => {
    expect(computeInstagramCaption("a".repeat(2201))).toBe("a".repeat(2200));
  });

  it("counts graphemes, never splitting an emoji sequence", () => {
    const family = "\u{1F468}‍\u{1F469}‍\u{1F467}"; // one grapheme, 8 UTF-16 units
    const result = computeInstagramCaption(family.repeat(2201));
    expect(result).toBe(family.repeat(2200));
  });
});

describe("instagramClient.publishVideo — caption limit", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends the truncated caption to the media container", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchMock = vi.fn((input: string | URL) => {
      const url = String(input);
      if (url.includes("/ig-account-1/media")) {
        // Container creation fails once we have the request URL to inspect.
        return Promise.resolve(new Response("{}", { status: 400 }));
      }
      throw new Error(`Unexpected fetch in test: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await instagramClient
      .publishVideo({
        user: { id: "user-1" } as unknown as User,
        socialConnection: makeConnection({ id: "conn-ig", expiresAt: null }),
        mediaItem: {
          mimeType: "image/jpeg",
          storageLocation: "https://blob.example.com/m",
          metadata: null,
        } as unknown as MediaItem,
        caption: "b".repeat(3000),
      })
      .catch(() => null);

    const containerUrl = new URL(String(fetchMock.mock.calls[0][0]));
    expect(containerUrl.searchParams.get("caption")).toBe("b".repeat(2200));
  });
});

// 2026-11-01 scale audit (platform limits, V11/V12): Meta throttles with a
// body `error.code` (4, 17, 32, 613, 80001, 80002) on HTTP 400, not 429. Those
// become RATE_LIMITED; Instagram's publishing cap (code 9 / subcode 2207042)
// is a daily_limit; suspected spam (code 4 / subcode 2207051) is NOT a limit.
describe("instagramClient.publishVideo — rate limits (RATE_LIMITED)", () => {
  const graphError = (code: number, subcode?: number, headers: Record<string, string> = {}) =>
    new Response(
      JSON.stringify({
        error: { message: "m", type: "OAuthException", code, error_subcode: subcode },
      }),
      { status: 400, headers },
    );

  function ctx(mimeType: string) {
    return {
      user: { id: "user-1" } as unknown as User,
      socialConnection: makeConnection({ id: "conn-ig", expiresAt: null }),
      mediaItem: {
        mimeType,
        storageLocation: "https://blob.example.com/m",
        metadata: null,
      } as unknown as MediaItem,
      caption: "hello",
    };
  }

  function stubGraph(routes: { container: () => Response; status?: () => Response; publish?: () => Response }) {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL) => {
        const url = String(input);
        if (url.includes("/media_publish")) return Promise.resolve(routes.publish!());
        if (url.includes("/ig-account-1/media")) return Promise.resolve(routes.container());
        if (url.includes("fields=status_code")) return Promise.resolve(routes.status!());
        throw new Error(`Unexpected fetch in test: ${url}`);
      }),
    );
  }

  type LimitedError = Error & { code?: string; kind?: string; retryAt?: number | null; platform?: string };
  const failure = (promise: Promise<unknown>) =>
    promise.then(
      () => null,
      (e: unknown) => e as LimitedError,
    );

  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("container 400 code 80002 -> RATE_LIMITED, not INSTAGRAM_CONTAINER_FAILED, and no reconnect flag", async () => {
    stubGraph({ container: () => graphError(80002) });

    const error = await failure(instagramClient.publishVideo(ctx("image/jpeg")));

    expect(error).toMatchObject({ code: "RATE_LIMITED", platform: "instagram", kind: "rate_limited" });
    expect(error?.message).toBe("Instagram is limiting requests right now.");
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("uses the business-use-case estimate (minutes) as retryAt", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-01T12:00:00Z"));
    stubGraph({
      container: () =>
        graphError(80002, undefined, {
          "X-Business-Use-Case-Usage": JSON.stringify({
            "ig-account-1": [{ type: "instagram", estimated_time_to_regain_access: 4 }],
          }),
        }),
    });

    const error = await failure(instagramClient.publishVideo(ctx("image/jpeg")));

    expect(error?.retryAt).toBe(Date.parse("2026-11-01T12:00:00Z") + 4 * 60_000);
  });

  it("media_publish 400 code 9 / subcode 2207042 -> RATE_LIMITED daily_limit (24 h)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-01T12:00:00Z"));
    stubGraph({
      container: () => new Response(JSON.stringify({ id: "container-1" }), { status: 200 }),
      publish: () => graphError(9, 2207042),
    });

    const promise = failure(instagramClient.publishVideo(ctx("image/jpeg")));
    await vi.advanceTimersByTimeAsync(3_000);
    const error = await promise;

    expect(error).toMatchObject({ code: "RATE_LIMITED", kind: "daily_limit" });
    expect(error?.retryAt).toBe(Date.parse("2026-11-01T12:00:03Z") + 24 * 60 * 60_000);
  });

  it("a rate limit during the video status poll stops polling with RATE_LIMITED", async () => {
    vi.useFakeTimers();
    const statusMock = vi.fn(() => graphError(4));
    stubGraph({
      container: () => new Response(JSON.stringify({ id: "container-1" }), { status: 200 }),
      status: statusMock,
    });

    const promise = failure(instagramClient.publishVideo(ctx("video/mp4")));
    await vi.advanceTimersByTimeAsync(5_000);

    expect((await promise)?.code).toBe("RATE_LIMITED");
    expect(statusMock).toHaveBeenCalledTimes(1);
  });

  it("suspected spam (code 4 / subcode 2207051) is not a rate limit: INSTAGRAM_CONTAINER_FAILED", async () => {
    stubGraph({ container: () => graphError(4, 2207051) });

    const error = await failure(instagramClient.publishVideo(ctx("image/jpeg")));

    expect(error?.code).toBe("INSTAGRAM_CONTAINER_FAILED");
  });
});
