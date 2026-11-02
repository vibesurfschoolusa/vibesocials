import type { MediaItem, SocialConnection, User } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PUBLISH_UNCONFIRMED_MESSAGE } from "@/lib/publishOutcomes";
import {
  computeInstagramCaption,
  ensureFreshInstagramToken,
  INSTAGRAM_POLL_INTERVAL_MS,
  INSTAGRAM_POLL_MAX_ATTEMPTS,
  INSTAGRAM_PUBLISH_RESERVE_MS,
  instagramClient,
  waitForInstagramContainer,
} from "@/server/platforms/instagramClient";
import {
  MIN_REQUEST_WINDOW_MS,
  PUBLISH_BUDGET_EXCEEDED_CODE,
  PUBLISH_STEP_BUDGET_MS,
} from "@/server/platforms/publishBudget";
import { withTransientRetries } from "@/server/platforms/transientRetry";

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
const { updateMock, findUniqueMock } = vi.hoisted(() => ({
  updateMock: vi.fn(),
  findUniqueMock: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    socialConnection: {
      update: updateMock,
      // The guarded reconnect flag re-reads the stored tokens (connectionHealth.ts).
      findUnique: findUniqueMock,
    },
  },
}));

// What the database holds when a guarded flag re-reads the tokens: the ones
// makeConnection() builds, so by default the flag finds them unchanged and writes.
const STORED_TOKENS = { accessToken: "page-access-token", refreshToken: null };
// 2026-11-02 scale audit (R24): another process changed the tokens meanwhile.
const ROTATED_TOKENS = { accessToken: "rotated-page-token", refreshToken: null };

beforeEach(() => {
  updateMock.mockReset();
  updateMock.mockResolvedValue({});
  findUniqueMock.mockReset();
  findUniqueMock.mockResolvedValue(STORED_TOKENS);
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

describe("instagramClient.refreshToken - superseded (R24)", () => {
  // The health sweep calls refreshToken through refreshConnectionToken, which
  // catches TOKEN_REFRESH_SUPERSEDED and returns the stored row. It must NOT
  // surface CONNECTION_TOKEN_CHANGED (that is the publish path's code).
  it("throws TOKEN_REFRESH_SUPERSEDED and flags nothing when the stored tokens already changed", async () => {
    findUniqueMock.mockResolvedValue(ROTATED_TOKENS);

    const error = await instagramClient
      .refreshToken!(makeConnection({ id: "conn-99" })) // expiresAt in the past
      .then(() => null)
      .catch((e: unknown) => e as Error & { code?: string });

    expect(error?.code).toBe("TOKEN_REFRESH_SUPERSEDED");
    expect(updateMock).not.toHaveBeenCalled();
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

  // 2026-11-02 scale audit (jobs, token refresh, R24): every flag is guarded by
  // the tokens the rejected call sent. When another process changed them (the
  // user reconnected), nothing is flagged and the call fails with the plain,
  // retryable CONNECTION_TOKEN_CHANGED instead of INSTAGRAM_RECONNECT_REQUIRED.
  describe("a rejected token whose stored tokens changed meanwhile (R24)", () => {
    const failureOf = (promise: Promise<unknown>) =>
      promise.then(
        () => null,
        (e: unknown) => e as Error & { code?: string },
      );

    beforeEach(() => {
      findUniqueMock.mockResolvedValue(ROTATED_TOKENS);
    });

    it("container creation 401: CONNECTION_TOKEN_CHANGED and no flag", async () => {
      stubGraph({ container: () => new Response("{}", { status: 401 }) });

      const error = await failureOf(instagramClient.publishVideo(ctx("image/jpeg")));

      expect(error?.code).toBe("CONNECTION_TOKEN_CHANGED");
      expect(updateMock).not.toHaveBeenCalled();
    });

    it("container creation OAuthException 190: CONNECTION_TOKEN_CHANGED and no flag", async () => {
      stubGraph({ container: () => new Response(AUTH_ERROR_BODY, { status: 400 }) });

      const error = await failureOf(instagramClient.publishVideo(ctx("image/jpeg")));

      expect(error?.code).toBe("CONNECTION_TOKEN_CHANGED");
      expect(updateMock).not.toHaveBeenCalled();
    });

    it("media_publish 401: CONNECTION_TOKEN_CHANGED and no flag", async () => {
      vi.useFakeTimers();
      stubGraph({
        container: () => new Response(JSON.stringify({ id: "container-1" }), { status: 200 }),
        publish: () => new Response("{}", { status: 401 }),
      });

      const promise = failureOf(instagramClient.publishVideo(ctx("image/jpeg")));
      await vi.advanceTimersByTimeAsync(3_000);

      expect((await promise)?.code).toBe("CONNECTION_TOKEN_CHANGED");
      expect(updateMock).not.toHaveBeenCalled();
    });

    it("media_publish OAuthException 190: CONNECTION_TOKEN_CHANGED and no flag", async () => {
      vi.useFakeTimers();
      stubGraph({
        container: () => new Response(JSON.stringify({ id: "container-1" }), { status: 200 }),
        publish: () => new Response(AUTH_ERROR_BODY, { status: 400 }),
      });

      const promise = failureOf(instagramClient.publishVideo(ctx("image/jpeg")));
      await vi.advanceTimersByTimeAsync(3_000);

      expect((await promise)?.code).toBe("CONNECTION_TOKEN_CHANGED");
      expect(updateMock).not.toHaveBeenCalled();
    });

    it("video status poll 401: CONNECTION_TOKEN_CHANGED and no flag", async () => {
      vi.useFakeTimers();
      stubGraph({
        container: () => new Response(JSON.stringify({ id: "container-1" }), { status: 200 }),
        status: () => new Response("{}", { status: 401 }),
      });

      const promise = failureOf(instagramClient.publishVideo(ctx("video/mp4")));
      await vi.advanceTimersByTimeAsync(5_000);

      expect((await promise)?.code).toBe("CONNECTION_TOKEN_CHANGED");
      expect(updateMock).not.toHaveBeenCalled();
    });

    it("the expiry guard at publish time: CONNECTION_TOKEN_CHANGED and no flag", async () => {
      // An expired stored expiresAt, but the row was refreshed or reconnected since.
      stubGraph({ container: () => new Response("{}", { status: 500 }) });

      const error = await failureOf(
        instagramClient.publishVideo({
          ...ctx("image/jpeg"),
          socialConnection: makeConnection({ id: "conn-ig" }), // expiresAt in the past
        }),
      );

      expect(error?.code).toBe("CONNECTION_TOKEN_CHANGED");
      expect(updateMock).not.toHaveBeenCalled();
    });
  });

  it("the expiry guard at publish time flags (tokens unchanged) and keeps INSTAGRAM_RECONNECT_REQUIRED", async () => {
    stubGraph({ container: () => new Response("{}", { status: 500 }) });

    const error = await instagramClient
      .publishVideo({
        ...ctx("image/jpeg"),
        socialConnection: makeConnection({ id: "conn-ig" }), // expiresAt in the past
      })
      .then(() => null)
      .catch((e: unknown) => e as Error & { code?: string });

    expect(error?.code).toBe("INSTAGRAM_RECONNECT_REQUIRED");
    expectFlagged();
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

  // 2026-11-01 scale audit (jobs H6, Review Focus 5): `media_publish` is the
  // commit call. An ambiguous outcome there is PUBLISH_UNCONFIRMED and is never
  // re-run (a re-run would build a second container and post again).
  describe("commit call (media_publish)", () => {
    const containerOk = () => new Response(JSON.stringify({ id: "container-1" }), { status: 200 });

    /** Run an image publish to completion, stepping past the 3 s image-processing wait. */
    async function publishFailure(ctxValue = ctx("image/jpeg")) {
      vi.useFakeTimers();
      const promise = failure(instagramClient.publishVideo(ctxValue));
      await vi.advanceTimersByTimeAsync(3_000);
      return promise;
    }

    it("media_publish 500 -> PUBLISH_UNCONFIRMED, without flagging the connection", async () => {
      const publish = vi.fn(() => new Response("{}", { status: 500 }));
      stubGraph({ container: containerOk, publish });

      const error = await publishFailure();

      expect(error?.code).toBe("PUBLISH_UNCONFIRMED");
      expect(error?.message).toBe(PUBLISH_UNCONFIRMED_MESSAGE);
      expect(publish).toHaveBeenCalledTimes(1);
      expect(updateMock).not.toHaveBeenCalled();
    });

    it("media_publish 500 is not re-run by the in-step retry: one container, one publish", async () => {
      vi.useFakeTimers();
      const container = vi.fn(containerOk);
      const publish = vi.fn(() => new Response("{}", { status: 500 }));
      stubGraph({ container, publish });

      const promise = failure(
        withTransientRetries(() => instagramClient.publishVideo(ctx("image/jpeg")), { sleep: async () => {} }),
      );
      await vi.advanceTimersByTimeAsync(3_000);

      expect((await promise)?.code).toBe("PUBLISH_UNCONFIRMED");
      expect(container).toHaveBeenCalledTimes(1);
      expect(publish).toHaveBeenCalledTimes(1);
    });

    it("a connection dropped after media_publish was sent -> PUBLISH_UNCONFIRMED", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn((input: string | URL) => {
          if (String(input).includes("/media_publish")) {
            return Promise.reject(new TypeError("fetch failed", { cause: { code: "ECONNRESET" } }));
          }
          return Promise.resolve(containerOk());
        }),
      );

      expect((await publishFailure())?.code).toBe("PUBLISH_UNCONFIRMED");
    });

    it("a media_publish that never connected is rethrown unchanged (provably not sent)", async () => {
      const neverConnected = new TypeError("fetch failed", { cause: { code: "ENOTFOUND" } });
      vi.stubGlobal(
        "fetch",
        vi.fn((input: string | URL) =>
          String(input).includes("/media_publish")
            ? Promise.reject(neverConnected)
            : Promise.resolve(containerOk()),
        ),
      );

      expect(await publishFailure()).toBe(neverConnected);
    });

    // Final review F4 (I2): a 2xx media_publish means the post may be live, so a
    // success body that cannot be read or parsed is PUBLISH_UNCONFIRMED.
    it.each([
      ["invalid JSON", () => new Response("<html>ok</html>", { status: 200 })],
      [
        "a body that errors mid-read",
        () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.error(new TypeError("terminated"));
              },
            }),
            { status: 200 },
          ),
      ],
    ] as const)("a 2xx media_publish with %s -> PUBLISH_UNCONFIRMED, published once", async (_name, make) => {
      const publish = vi.fn(make);
      stubGraph({ container: containerOk, publish });

      const error = await publishFailure();

      expect(error?.code).toBe("PUBLISH_UNCONFIRMED");
      expect(error?.message).toBe(PUBLISH_UNCONFIRMED_MESSAGE);
      expect(publish).toHaveBeenCalledTimes(1);
    });

    // 2026-11-02 scale audit (jobs, R30): media_publish answered 2xx ("created")
    // but the parsed body has no post id: PUBLISH_UNCONFIRMED, not a success with
    // an undefined externalPostId.
    it.each([
      ["{}", "{}"],
      ["an empty id", JSON.stringify({ id: "" })],
      ["a numeric id", JSON.stringify({ id: 17 })],
      ["a JSON null body", "null"],
    ])("a 2xx media_publish with %s -> PUBLISH_UNCONFIRMED, published once", async (_name, body) => {
      const publish = vi.fn(() => new Response(body, { status: 200 }));
      stubGraph({ container: containerOk, publish });

      const error = await publishFailure();

      expect(error?.code).toBe("PUBLISH_UNCONFIRMED");
      expect(error?.message).toBe(PUBLISH_UNCONFIRMED_MESSAGE);
      expect(publish).toHaveBeenCalledTimes(1);
      expect(updateMock).not.toHaveBeenCalled();
    });

    it("a 2xx media_publish with an id succeeds with it as externalPostId", async () => {
      stubGraph({
        container: containerOk,
        publish: () => new Response(JSON.stringify({ id: "media-1" }), { status: 200 }),
      });
      vi.useFakeTimers();

      const promise = instagramClient.publishVideo(ctx("image/jpeg"));
      await vi.advanceTimersByTimeAsync(3_000);

      await expect(promise).resolves.toEqual({ externalPostId: "media-1" });
    });

    it("media_publish 400 keeps INSTAGRAM_PUBLISH_FAILED", async () => {
      stubGraph({ container: containerOk, publish: () => new Response("{}", { status: 400 }) });

      expect((await publishFailure())?.code).toBe("INSTAGRAM_PUBLISH_FAILED");
    });

    it("media_publish 401 keeps the reconnect error and still flags the connection", async () => {
      stubGraph({ container: containerOk, publish: () => new Response("{}", { status: 401 }) });

      const error = await publishFailure();

      expect(error?.code).toBe("INSTAGRAM_RECONNECT_REQUIRED");
      expect(updateMock).toHaveBeenCalledTimes(1);
    });

    it("a 5xx on the container call (before the commit) is NOT unconfirmed", async () => {
      stubGraph({ container: () => new Response("{}", { status: 500 }) });

      expect((await publishFailure())?.code).toBe("INSTAGRAM_CONTAINER_FAILED");
    });
  });
});

// 2026-11-01 scale audit (step budget, Task 7): the in-step container poll
// (5 s x up to 30) is bounded by the step deadline. It stops while
// INSTAGRAM_PUBLISH_RESERVE_MS is still left for media_publish and ends with
// INSTAGRAM_VIDEO_TIMEOUT - nothing was published at that point, so a retry is
// safe. (Meta's once-a-minute / 5 min guidance needs polling across steps with
// step.sleep: phase 3.)
describe("waitForInstagramContainer", () => {
  type CodedError = Error & { code?: string };
  const failure = (promise: Promise<unknown>) =>
    promise.then(
      () => null,
      (e: unknown) => e as CodedError,
    );

  const status = (statusCode: string) => new Response(JSON.stringify({ status_code: statusCode }), { status: 200 });

  /** A manual clock: `sleep` advances it, so a poll loop runs without real waiting. */
  function makeClock(start = Date.parse("2026-11-01T12:00:00Z")) {
    let time = start;
    return {
      now: () => time,
      sleep: async (ms: number) => {
        time += ms;
      },
    };
  }

  function stubStatus(answer: (call: number) => Response) {
    let call = 0;
    const fetchMock = vi.fn<typeof fetch>(() => Promise.resolve(answer(++call)));
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  const baseOptions = {
    containerId: "container-1",
    accessToken: "page-access-token",
    connection: { id: "conn-ig", accessToken: "page-access-token", refreshToken: null },
  };

  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses the documented poll constants", () => {
    expect(INSTAGRAM_POLL_INTERVAL_MS).toBe(5_000);
    expect(INSTAGRAM_POLL_MAX_ATTEMPTS).toBe(30);
    expect(INSTAGRAM_PUBLISH_RESERVE_MS).toBe(20_000);
  });

  it("resolves once the container is FINISHED, after one interval per check", async () => {
    const clock = makeClock();
    const start = clock.now();
    const fetchMock = stubStatus((call) => status(call < 3 ? "IN_PROGRESS" : "FINISHED"));

    await waitForInstagramContainer({ ...baseOptions, sleep: clock.sleep, now: clock.now });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(clock.now() - start).toBe(3 * INSTAGRAM_POLL_INTERVAL_MS);
  });

  it("throws INSTAGRAM_VIDEO_PROCESSING_ERROR when Instagram reports ERROR", async () => {
    const clock = makeClock();
    stubStatus(() => status("ERROR"));

    const error = await failure(waitForInstagramContainer({ ...baseOptions, sleep: clock.sleep, now: clock.now }));

    expect(error?.code).toBe("INSTAGRAM_VIDEO_PROCESSING_ERROR");
  });

  it("without a deadline, gives up after INSTAGRAM_POLL_MAX_ATTEMPTS checks with INSTAGRAM_VIDEO_TIMEOUT", async () => {
    const clock = makeClock();
    const fetchMock = stubStatus(() => status("IN_PROGRESS"));

    const error = await failure(waitForInstagramContainer({ ...baseOptions, sleep: clock.sleep, now: clock.now }));

    expect(error?.code).toBe("INSTAGRAM_VIDEO_TIMEOUT");
    expect(fetchMock).toHaveBeenCalledTimes(INSTAGRAM_POLL_MAX_ATTEMPTS);
  });

  it("keeps polling after a transient non-auth HTTP error", async () => {
    const clock = makeClock();
    const fetchMock = stubStatus((call) => (call === 1 ? new Response("{}", { status: 500 }) : status("FINISHED")));

    await waitForInstagramContainer({ ...baseOptions, sleep: clock.sleep, now: clock.now });

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("flags the connection it was given and throws the reconnect error on a dead token", async () => {
    const clock = makeClock();
    stubStatus(() => new Response("{}", { status: 401 }));

    const error = await failure(waitForInstagramContainer({ ...baseOptions, sleep: clock.sleep, now: clock.now }));

    expect(error?.code).toBe("INSTAGRAM_RECONNECT_REQUIRED");
    expect(updateMock).toHaveBeenCalledTimes(1);
    expect((updateMock.mock.calls[0][0] as { where: { id: string } }).where).toEqual({ id: "conn-ig" });
  });

  it("does not flag, and throws CONNECTION_TOKEN_CHANGED, when the stored tokens changed since the poll started (R24)", async () => {
    const clock = makeClock();
    findUniqueMock.mockResolvedValue(ROTATED_TOKENS);
    stubStatus(() => new Response("{}", { status: 401 }));

    const error = await failure(waitForInstagramContainer({ ...baseOptions, sleep: clock.sleep, now: clock.now }));

    expect(error?.code).toBe("CONNECTION_TOKEN_CHANGED");
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("with 40 s left and a container stuck IN_PROGRESS, stops with INSTAGRAM_VIDEO_TIMEOUT while the publish reserve is still left", async () => {
    const clock = makeClock();
    const deadline = clock.now() + 40_000;
    const fetchMock = stubStatus(() => status("IN_PROGRESS"));

    const error = await failure(
      waitForInstagramContainer({ ...baseOptions, deadline, sleep: clock.sleep, now: clock.now }),
    );

    expect(error?.code).toBe("INSTAGRAM_VIDEO_TIMEOUT");
    // At least the media_publish reserve is still there for a retry-free hand-off.
    expect(deadline - clock.now()).toBeGreaterThanOrEqual(INSTAGRAM_PUBLISH_RESERVE_MS);
    // 40 s - 20 s reserve = 20 s of polling: checks at +5 s, +10 s and +15 s
    // (each needs the 5 s wait and a >= 5 s request window before the reserve).
    expect(fetchMock).toHaveBeenCalledTimes(3);
    // media_publish is never requested by the poll.
    expect(fetchMock.mock.calls.filter((c) => String(c[0]).includes("media_publish"))).toHaveLength(0);
  });

  it("clamps each status request to the time left before the publish reserve", async () => {
    const clock = makeClock();
    const deadline = clock.now() + 40_000;
    stubStatus(() => status("IN_PROGRESS"));
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");

    await failure(waitForInstagramContainer({ ...baseOptions, deadline, sleep: clock.sleep, now: clock.now }));

    // Before the reserve there are 15 s, 10 s and 5 s left at the three checks
    // (never the 30 s default): the check cannot eat the reserve.
    expect(setTimeoutSpy.mock.calls.map((c) => c[1])).toEqual([15_000, 10_000, 5_000]);
  });

  it("does not poll at all when the reserve plus one wait and request would not fit", async () => {
    const clock = makeClock();
    const deadline = clock.now() + INSTAGRAM_PUBLISH_RESERVE_MS + INSTAGRAM_POLL_INTERVAL_MS + MIN_REQUEST_WINDOW_MS - 1;
    const fetchMock = stubStatus(() => status("FINISHED"));

    const error = await failure(
      waitForInstagramContainer({ ...baseOptions, deadline, sleep: clock.sleep, now: clock.now }),
    );

    expect(error?.code).toBe("INSTAGRAM_VIDEO_TIMEOUT");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("instagramClient.publishVideo — step deadline", () => {
  type CodedError = Error & { code?: string };
  const failure = (promise: Promise<unknown>) =>
    promise.then(
      () => null,
      (e: unknown) => e as CodedError,
    );

  function ctx(mimeType: string, deadline?: number) {
    return {
      user: { id: "user-1" } as unknown as User,
      socialConnection: makeConnection({ id: "conn-ig", expiresAt: null }),
      mediaItem: {
        mimeType,
        storageLocation: "https://blob.example.com/m",
        metadata: null,
      } as unknown as MediaItem,
      caption: "hello",
      deadline,
    };
  }

  const containerOk = () => new Response(JSON.stringify({ id: "container-1" }), { status: 200 });
  const inProgress = () => new Response(JSON.stringify({ status_code: "IN_PROGRESS" }), { status: 200 });
  const finished = () => new Response(JSON.stringify({ status_code: "FINISHED" }), { status: 200 });
  const publishOk = () => new Response(JSON.stringify({ id: "media-1" }), { status: 200 });

  /** Resolve after `ms` of (fake) time, or reject if the request is aborted first. */
  const slow = (ms: number, make: () => Response) => (init?: RequestInit) =>
    new Promise<Response>((resolve, reject) => {
      const timer = setTimeout(() => resolve(make()), ms);
      init?.signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(new DOMException("aborted", "AbortError"));
      });
    });
  /** Never answers: settles only when the request is aborted. */
  const hang = (init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    });

  type Route = (init?: RequestInit) => Promise<Response>;
  function stubRoutes(routes: { container?: Route; status?: Route; publish?: Route }) {
    const fetchMock = vi.fn<typeof fetch>((input, init) => {
      const url = String(input);
      if (url.includes("/media_publish")) return (routes.publish ?? (async () => publishOk()))(init);
      if (url.includes("/ig-account-1/media")) return (routes.container ?? (async () => containerOk()))(init);
      if (url.includes("fields=status_code")) return (routes.status ?? (async () => finished()))(init);
      throw new Error(`Unexpected fetch in test: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }
  const callsTo = (fetchMock: ReturnType<typeof stubRoutes>, fragment: string) =>
    fetchMock.mock.calls.filter((c) => String(c[0]).includes(fragment));

  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it.each([
    ["reel", "video/mp4"],
    ["image", "image/jpeg"],
  ])("refuses to start a %s publish once the step budget is spent (no request at all)", async (_label, mimeType) => {
    const fetchMock = stubRoutes({});

    const error = await failure(
      instagramClient.publishVideo(ctx(mimeType, Date.now() + MIN_REQUEST_WINDOW_MS - 1)),
    );

    expect(error?.code).toBe(PUBLISH_BUDGET_EXCEEDED_CODE);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("clamps the container call and media_publish to the time left (12 s -> 12 s, then 3 s later 9 s)", async () => {
    vi.useFakeTimers();
    const start = Date.now();
    const fetchMock = stubRoutes({});
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");

    const promise = instagramClient.publishVideo(ctx("image/jpeg", start + 12_000));
    await vi.advanceTimersByTimeAsync(3_000);

    await expect(promise).resolves.toEqual({ externalPostId: "media-1" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // container timeout, the 3 s image wait, then the media_publish timeout
    expect(setTimeoutSpy.mock.calls.map((c) => c[1])).toEqual([12_000, 3_000, 9_000]);
  });

  it("an image media_publish that would start with under 5 s left is refused (retry-safe), never reported unconfirmed", async () => {
    vi.useFakeTimers();
    const start = Date.now();
    // 3 s image wait leaves 4.999 s of the 7.999 s: below the 5 s request window.
    const fetchMock = stubRoutes({});

    const promise = failure(instagramClient.publishVideo(ctx("image/jpeg", start + 3_000 + MIN_REQUEST_WINDOW_MS - 1)));
    await vi.advanceTimersByTimeAsync(3_000);
    const error = await promise;

    expect(error?.code).toBe(PUBLISH_BUDGET_EXCEEDED_CODE);
    expect(callsTo(fetchMock, "/media_publish")).toHaveLength(0);
  });

  it("worst case: slow status checks on a container that never finishes end with INSTAGRAM_VIDEO_TIMEOUT before the publish reserve", async () => {
    vi.useFakeTimers();
    const start = Date.now();
    const deadline = start + PUBLISH_STEP_BUDGET_MS;
    const fetchMock = stubRoutes({ status: slow(20_000, inProgress) });

    let settledAt = 0;
    const promise = failure(instagramClient.publishVideo(ctx("video/mp4", deadline))).then((e) => {
      settledAt = Date.now();
      return e;
    });
    await vi.advanceTimersByTimeAsync(400_000);
    const error = await promise;

    // Unbounded this is 30 x (5 s + 20 s) = 750 s of polling.
    expect(error?.code).toBe("INSTAGRAM_VIDEO_TIMEOUT");
    expect(deadline - settledAt).toBeGreaterThanOrEqual(INSTAGRAM_PUBLISH_RESERVE_MS);
    expect(callsTo(fetchMock, "/media_publish")).toHaveLength(0);
  });

  it("worst case: a container that finishes late and a hung media_publish still settle by the step deadline", async () => {
    vi.useFakeTimers();
    const start = Date.now();
    const deadline = start + PUBLISH_STEP_BUDGET_MS;
    let checks = 0;
    const fetchMock = stubRoutes({
      // 8 checks of 5 s + 20 s: FINISHED arrives at 200 s, 25 s before the deadline.
      status: (init) => slow(20_000, ++checks < 8 ? inProgress : finished)(init),
      publish: hang,
    });

    let settledAt = 0;
    const promise = failure(instagramClient.publishVideo(ctx("video/mp4", deadline))).then((e) => {
      settledAt = Date.now();
      return e;
    });
    await vi.advanceTimersByTimeAsync(400_000);
    const error = await promise;

    // media_publish got the 25 s left (not its 30 s default) and was cut off at the deadline.
    expect(error?.code).toBe("PUBLISH_UNCONFIRMED");
    expect(callsTo(fetchMock, "/media_publish")).toHaveLength(1);
    expect(settledAt).toBeLessThanOrEqual(deadline);
    expect(settledAt - start).toBeLessThan(240_000);
  });
});
