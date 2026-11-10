import type { MediaItem, SocialConnection, User } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PUBLISH_UNCONFIRMED_MESSAGE } from "@/lib/publishOutcomes";
import {
  computeInstagramCaption,
  ensureFreshInstagramToken,
  INSTAGRAM_CONTAINER_MAX_AGE_MS,
  INSTAGRAM_POLL_INTERVAL_MS,
  INSTAGRAM_POLL_MAX_ATTEMPTS,
  INSTAGRAM_PUBLISH_RESERVE_MS,
  INSTAGRAM_STATUS_CHECK_INTERVAL_MS,
  INSTAGRAM_STATUS_MAX_CHECKS,
  instagramClient,
  waitForInstagramContainer,
} from "@/server/platforms/instagramClient";
import type { UploadSnapshot, UploadStateStore } from "@/server/jobs/uploadState";
import {
  MIN_REQUEST_WINDOW_MS,
  PUBLISH_BUDGET_EXCEEDED_CODE,
  PUBLISH_STEP_BUDGET_MS,
} from "@/server/platforms/publishBudget";
import { verifyInstagramPhotoRequest } from "@/server/platforms/instagramPhoto";
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
// 2026-11-02 scale audit: another process changed the tokens meanwhile.
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

describe("instagramClient.refreshToken - superseded", () => {
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
      get mediaItems() { return [this.mediaItem]; },
      mediaItem: {
        mimeType,
        storageLocation: "https://blob.example.com/m",
        metadata: null,
      } as unknown as MediaItem,
      caption: "hello",
    };
  }

  function stubGraph(routes: {
    container: () => Response;
    status?: () => Response;
    publish?: () => Response;
    permalink?: () => Response;
  }) {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL) => {
        const url = String(input);
        if (url.includes("fields=permalink") && routes.permalink) return Promise.resolve(routes.permalink());
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

  // 2026-11-08: the media id is not a public locator, so after publishing the
  // client asks for the post's permalink for the Activity link. Best effort: the
  // post is live either way.
  describe("permalink for the Activity link", () => {
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
    const publishPhoto = (permalink?: () => Response) => {
      stubGraph({
        container: () => json({ id: "container-1" }),
        status: () => json({ status_code: "FINISHED" }),
        publish: () => json({ id: "media-1" }),
        permalink,
      });
      return instagramClient.publishVideo(ctx("image/jpeg"));
    };

    it("returns the post's permalink as externalPostUrl", async () => {
      const result = await publishPhoto(() => json({ permalink: "https://www.instagram.com/p/DfgcZzggTmr/", id: "media-1" }));

      expect(result).toEqual({
        externalPostId: "media-1",
        externalPostUrl: "https://www.instagram.com/p/DfgcZzggTmr/",
      });
    });

    it("still succeeds, without a link, when the lookup fails", async () => {
      await expect(publishPhoto(() => new Response("{}", { status: 500 }))).resolves.toEqual({
        externalPostId: "media-1",
      });
    });

    it("ignores a permalink that is not an https instagram.com link", async () => {
      await expect(publishPhoto(() => json({ permalink: "https://evil.example/p/x" }))).resolves.toEqual({
        externalPostId: "media-1",
      });
    });
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

  // 2026-11-02 scale audit (jobs, token refresh): every flag is guarded by
  // the tokens the rejected call sent. When another process changed them (the
  // user reconnected), nothing is flagged and the call fails with the plain,
  // retryable CONNECTION_TOKEN_CHANGED instead of INSTAGRAM_RECONNECT_REQUIRED.
  describe("a rejected token whose stored tokens changed meanwhile", () => {
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
        get mediaItems() { return [this.mediaItem]; },
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

// 2026-11-08: Instagram refuses a non-JPEG or a photo outside 4:5..1.91:1, so a
// photo is handed over through the signed /api/instagram-photo copy; a video
// (REELS) still uses the stored blob URL.
describe("instagramClient.publishVideo — which URL Instagram fetches", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  async function containerUrlFor(mimeType: string): Promise<URL> {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubEnv("NEXTAUTH_URL", "https://vibesocials.wtf");
    vi.stubEnv("NEXTAUTH_SECRET", "test-secret");
    const fetchMock = vi.fn((input: string | URL) => {
      const url = String(input);
      if (url.includes("/ig-account-1/media")) {
        return Promise.resolve(new Response("{}", { status: 400 }));
      }
      throw new Error(`Unexpected fetch in test: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await instagramClient
      .publishVideo({
        user: { id: "user-1" } as unknown as User,
        socialConnection: makeConnection({ id: "conn-ig", expiresAt: null }),
        get mediaItems() { return [this.mediaItem]; },
        mediaItem: {
          mimeType,
          storageLocation: "https://blob.example.com/m",
          metadata: null,
        } as unknown as MediaItem,
        caption: "hi",
      })
      .catch(() => null);

    return new URL(String(fetchMock.mock.calls[0][0]));
  }

  it("gives Instagram the signed JPEG copy of a photo", async () => {
    const imageUrl = new URL(String((await containerUrlFor("image/png")).searchParams.get("image_url")));

    expect(`${imageUrl.origin}${imageUrl.pathname}`).toBe("https://vibesocials.wtf/api/instagram-photo");
    expect(imageUrl.searchParams.get("src")).toBe("https://blob.example.com/m");
    expect(
      verifyInstagramPhotoRequest(
        imageUrl.searchParams.get("src"),
        imageUrl.searchParams.get("exp"),
        imageUrl.searchParams.get("sig"),
      ),
    ).toBe(true);
  });

  it("gives Instagram the stored URL of a video", async () => {
    const containerUrl = await containerUrlFor("video/mp4");

    expect(containerUrl.searchParams.get("video_url")).toBe("https://blob.example.com/m");
    expect(containerUrl.searchParams.get("image_url")).toBeNull();
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
      get mediaItems() { return [this.mediaItem]; },
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

    // 2026-11-02 scale audit (jobs): media_publish answered 2xx ("created")
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
// safe. 2026-11-02 scale audit (jobs L5): it now serves only a caller with no
// upload-state store; a platform step polls across steps instead (next suite).
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

  it("does not flag, and throws CONNECTION_TOKEN_CHANGED, when the stored tokens changed since the poll started", async () => {
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

// 2026-11-02 scale audit (jobs L5): with an upload-state store a REELS video is
// not polled inside one step. Meta recommends one status query a minute for at
// most five minutes (https://developers.facebook.com/docs/instagram-platform/content-publishing),
// so the first step creates the container and saves { containerId, createdAt,
// checks: 0 }, and each later step makes ONE status check. Only a step that sees
// FINISHED calls media_publish (the commit), in that same claimed step.
describe("instagramClient.publishVideo — container polling across steps", () => {
  type CodedError = Error & { code?: string };
  const failure = (promise: Promise<unknown>) =>
    promise.then(
      () => null,
      (e: unknown) => e as CodedError,
    );

  const NOW = Date.parse("2026-11-02T10:00:00Z");
  const KIND = "instagram_container";

  const containerOk = () => new Response(JSON.stringify({ id: "container-1" }), { status: 200 });
  const status = (code: string) => new Response(JSON.stringify({ status_code: code }), { status: 200 });
  const publishOk = () => new Response(JSON.stringify({ id: "media-1" }), { status: 200 });
  const graphError = (code: number) =>
    new Response(JSON.stringify({ error: { message: "m", type: "OAuthException", code } }), { status: 400 });
  const AUTH_ERROR_BODY = JSON.stringify({
    error: { message: "Session has expired.", type: "OAuthException", code: 190 },
  });

  interface ContainerState {
    containerId: string;
    createdAt: string;
    checks: number;
  }

  /** A one-result store that behaves like uploadState.ts: it holds a snapshot per kind. */
  function makeStore(initial?: unknown) {
    const kept = new Map<string, UploadSnapshot<unknown, unknown>>();
    if (initial !== undefined) kept.set(KIND, { data: initial });
    const store = {
      load: vi.fn(async (kind: string) => kept.get(kind) ?? null),
      save: vi.fn(async (kind: string, snapshot: UploadSnapshot<unknown, unknown>) => {
        kept.set(kind, snapshot);
      }),
      clear: vi.fn(async () => {
        kept.clear();
      }),
    };
    return {
      store: store as unknown as UploadStateStore,
      mocks: store,
      /** What is saved for the container kind right now. */
      saved: () => kept.get(KIND) ?? null,
      savedData: () => (kept.get(KIND)?.data ?? null) as ContainerState | null,
    };
  }

  /** A saved state whose container was created `ageMs` ago (a minute by default). */
  const stateWith = (checks: number, ageMs = 60_000): ContainerState => ({
    containerId: "container-1",
    createdAt: new Date(NOW - ageMs).toISOString(),
    checks,
  });
  const HOUR = 3_600_000;

  function ctx(store: UploadStateStore | undefined, extra: { deadline?: number; mimeType?: string } = {}) {
    return {
      user: { id: "user-1" } as unknown as User,
      socialConnection: makeConnection({ id: "conn-ig", expiresAt: null }),
      get mediaItems() { return [this.mediaItem]; },
      mediaItem: {
        mimeType: extra.mimeType ?? "video/mp4",
        storageLocation: "https://blob.example.com/m",
        metadata: null,
      } as unknown as MediaItem,
      caption: "hello",
      deadline: extra.deadline,
      uploadState: store,
    };
  }

  type Route = () => Response | Promise<Response>;
  function stubGraph(routes: { container?: Route; status?: Route; publish?: Route }) {
    const container = vi.fn<Route>(routes.container ?? containerOk);
    const statusCheck = vi.fn<Route>(routes.status ?? (() => status("FINISHED")));
    const publish = vi.fn<Route>(routes.publish ?? publishOk);
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL) => {
        const url = String(input);
        if (url.includes("/media_publish")) return Promise.resolve(publish());
        if (url.includes("/ig-account-1/media")) return Promise.resolve(container());
        if (url.includes("fields=status_code")) return Promise.resolve(statusCheck());
        throw new Error(`Unexpected fetch in test: ${url}`);
      }),
    );
    return { container, status: statusCheck, publish };
  }

  const continuation = { continuation: { resumeAt: NOW + 60_000 } };

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("uses Meta's recommended cadence: once a minute, at most five checks", () => {
    expect(INSTAGRAM_STATUS_CHECK_INTERVAL_MS).toBe(60_000);
    expect(INSTAGRAM_STATUS_MAX_CHECKS).toBe(5);
  });

  it("treats a saved container as stale after 23 h, an hour short of Meta's 24 h expiry", () => {
    expect(INSTAGRAM_CONTAINER_MAX_AGE_MS).toBe(23 * HOUR);
  });

  describe("the first step (no saved state)", () => {
    it("creates the container once, saves checks 0, and continues in 60 s without publishing", async () => {
      const { store, savedData, saved } = makeStore();
      const graph = stubGraph({});

      const result = await instagramClient.publishVideo(ctx(store));

      expect(graph.container).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ continuation: { resumeAt: NOW + 60_000 } });
      expect(result.externalPostId).toBeUndefined();
      expect(savedData()).toEqual({ containerId: "container-1", createdAt: new Date(NOW).toISOString(), checks: 0 });
      // Nothing is secret, so nothing is sealed.
      expect(saved()).not.toHaveProperty("secret");
      // No status query and no commit call in this step.
      expect(graph.status).not.toHaveBeenCalled();
      expect(graph.publish).not.toHaveBeenCalled();
    });

    it("never stores the access token", async () => {
      const { store, mocks } = makeStore();
      stubGraph({});

      await instagramClient.publishVideo(ctx(store));

      expect(mocks.save).toHaveBeenCalledTimes(1);
      expect(mocks.save.mock.calls[0][0]).toBe(KIND);
      expect(JSON.stringify(mocks.save.mock.calls)).not.toContain("page-access-token");
    });

    it("starts over when the saved data is not a container state (nothing was published, so that is safe)", async () => {
      const { store, savedData } = makeStore({ containerId: 17, checks: "two" });
      const graph = stubGraph({});

      const result = await instagramClient.publishVideo(ctx(store));

      expect(graph.container).toHaveBeenCalledTimes(1);
      expect(result.continuation).toEqual({ resumeAt: NOW + 60_000 });
      expect(savedData()).toMatchObject({ containerId: "container-1", checks: 0 });
    });

    it("a throttled container call is RATE_LIMITED and saves nothing", async () => {
      const { store, mocks } = makeStore();
      stubGraph({ container: () => graphError(80002) });

      const error = await failure(instagramClient.publishVideo(ctx(store)));

      expect(error?.code).toBe("RATE_LIMITED");
      expect(mocks.save).not.toHaveBeenCalled();
    });

    // A container answer without a usable id used to be saved as `containerId: undefined`;
    // the next step then started over, over and over, leaving a container behind each time.
    it.each([
      ["no id", "{}"],
      ["an empty id", JSON.stringify({ id: "" })],
      ["a numeric id", JSON.stringify({ id: 17 })],
      ["a null id", JSON.stringify({ id: null })],
      ["a JSON null body", "null"],
      ["a body that is not JSON", "<html>ok</html>"],
    ])("a 200 container answer with %s is INSTAGRAM_CONTAINER_FAILED and saves nothing", async (_name, body) => {
      const { store, mocks } = makeStore();
      const graph = stubGraph({ container: () => new Response(body, { status: 200 }) });

      const error = await failure(instagramClient.publishVideo(ctx(store)));

      expect(error?.code).toBe("INSTAGRAM_CONTAINER_FAILED");
      expect(mocks.save).not.toHaveBeenCalled();
      expect(graph.status).not.toHaveBeenCalled();
      expect(graph.publish).not.toHaveBeenCalled();
    });

    it("a 200 container answer without an id fails an image publish too, before media_publish", async () => {
      const { store } = makeStore();
      const graph = stubGraph({ container: () => new Response("{}", { status: 200 }) });

      const error = await failure(instagramClient.publishVideo(ctx(store, { mimeType: "image/jpeg" })));

      expect(error?.code).toBe("INSTAGRAM_CONTAINER_FAILED");
      expect(graph.publish).not.toHaveBeenCalled();
    });

    it("a failed save propagates: the step fails, the platform is never asked to publish", async () => {
      const { store, mocks } = makeStore();
      mocks.save.mockRejectedValueOnce(Object.assign(new Error("claim gone"), { code: "RESULT_CLAIM_LOST" }));
      const graph = stubGraph({});

      const error = await failure(instagramClient.publishVideo(ctx(store)));

      expect(error?.code).toBe("RESULT_CLAIM_LOST");
      expect(graph.publish).not.toHaveBeenCalled();
    });
  });

  describe("a later step (state present): one status check", () => {
    it("FINISHED: media_publish once, in this step, then success with the post id", async () => {
      const { store } = makeStore(stateWith(2));
      const graph = stubGraph({ status: () => status("FINISHED") });

      const result = await instagramClient.publishVideo(ctx(store));

      expect(result).toEqual({ externalPostId: "media-1" });
      expect(graph.status).toHaveBeenCalledTimes(1);
      expect(graph.publish).toHaveBeenCalledTimes(1);
      const fetchMock = vi.mocked(globalThis.fetch);
      const publishUrl = new URL(String(fetchMock.mock.calls.find((c) => String(c[0]).includes("/media_publish"))![0]));
      expect(publishUrl.searchParams.get("creation_id")).toBe("container-1");
      // Lost ack: the saved container is reused, never replaced.
      expect(graph.container).not.toHaveBeenCalled();
    });

    it("checks the status of the SAVED container, not a new one", async () => {
      const { store } = makeStore(stateWith(0));
      stubGraph({ status: () => status("IN_PROGRESS") });

      await instagramClient.publishVideo(ctx(store));

      const fetchMock = vi.mocked(globalThis.fetch);
      const statusCalls = fetchMock.mock.calls.filter((c) => String(c[0]).includes("fields=status_code"));
      expect(statusCalls).toHaveLength(1);
      expect(String(statusCalls[0][0])).toContain("/container-1?");
    });

    it("IN_PROGRESS: counts the check, saves it, and continues in 60 s without publishing", async () => {
      const { store, savedData } = makeStore(stateWith(1));
      const graph = stubGraph({ status: () => status("IN_PROGRESS") });

      const result = await instagramClient.publishVideo(ctx(store));

      expect(result).toEqual(continuation);
      expect(savedData()).toMatchObject({ containerId: "container-1", checks: 2 });
      expect(graph.publish).not.toHaveBeenCalled();
      expect(graph.container).not.toHaveBeenCalled();
    });

    it("IN_PROGRESS on the 5th check: INSTAGRAM_VIDEO_TIMEOUT, and media_publish is never requested", async () => {
      const { store } = makeStore(stateWith(INSTAGRAM_STATUS_MAX_CHECKS - 1));
      const graph = stubGraph({ status: () => status("IN_PROGRESS") });

      const error = await failure(instagramClient.publishVideo(ctx(store)));

      expect(error?.code).toBe("INSTAGRAM_VIDEO_TIMEOUT");
      expect(graph.publish).not.toHaveBeenCalled();
    });

    it("FINISHED on the 5th check still publishes", async () => {
      const { store } = makeStore(stateWith(INSTAGRAM_STATUS_MAX_CHECKS - 1));
      const graph = stubGraph({ status: () => status("FINISHED") });

      await expect(instagramClient.publishVideo(ctx(store))).resolves.toEqual({ externalPostId: "media-1" });
      expect(graph.publish).toHaveBeenCalledTimes(1);
    });

    it.each([
      ["ERROR", "INSTAGRAM_VIDEO_PROCESSING_ERROR"],
      ["EXPIRED", "INSTAGRAM_CONTAINER_EXPIRED"],
      // A container that is already PUBLISHED before our own media_publish was
      // published by something else or by a lost earlier try; either way we cannot say
      // what is live, and we do not call media_publish on it.
      ["PUBLISHED", "PUBLISH_UNCONFIRMED"],
    ])("%s -> %s, and media_publish is never requested", async (statusCode, code) => {
      const { store } = makeStore(stateWith(1));
      const graph = stubGraph({ status: () => status(statusCode) });

      const error = await failure(instagramClient.publishVideo(ctx(store)));

      expect(error?.code).toBe(code);
      expect(graph.publish).not.toHaveBeenCalled();
    });

    it("PUBLISHED carries the shared user-facing PUBLISH_UNCONFIRMED message", async () => {
      const { store } = makeStore(stateWith(1));
      stubGraph({ status: () => status("PUBLISHED") });

      const error = await failure(instagramClient.publishVideo(ctx(store)));

      expect(error?.message).toBe(PUBLISH_UNCONFIRMED_MESSAGE);
    });

    it("a Meta throttle (code 80002) is RATE_LIMITED, the state is kept untouched, and nothing is published", async () => {
      const { store, mocks, savedData } = makeStore(stateWith(2));
      const graph = stubGraph({ status: () => graphError(80002) });

      const error = await failure(instagramClient.publishVideo(ctx(store)));

      expect(error).toMatchObject({ code: "RATE_LIMITED", platform: "instagram" });
      // Kept as it was: the throttled query told us nothing, so it is not counted.
      expect(savedData()).toEqual(stateWith(2));
      expect(mocks.save).not.toHaveBeenCalled();
      expect(mocks.clear).not.toHaveBeenCalled();
      expect(graph.publish).not.toHaveBeenCalled();
      expect(graph.container).not.toHaveBeenCalled();
    });

    it("an HTTP 429 on the status query is RATE_LIMITED too", async () => {
      const { store } = makeStore(stateWith(0));
      stubGraph({ status: () => new Response("{}", { status: 429 }) });

      expect((await failure(instagramClient.publishVideo(ctx(store))))?.code).toBe("RATE_LIMITED");
    });

    it("a rejected token (OAuthException 190) flags the connection and throws INSTAGRAM_RECONNECT_REQUIRED", async () => {
      const { store } = makeStore(stateWith(1));
      stubGraph({ status: () => new Response(AUTH_ERROR_BODY, { status: 400 }) });

      const error = await failure(instagramClient.publishVideo(ctx(store)));

      expect(error?.code).toBe("INSTAGRAM_RECONNECT_REQUIRED");
      expect(updateMock).toHaveBeenCalledTimes(1);
      expect((updateMock.mock.calls[0][0] as { where: { id: string } }).where).toEqual({ id: "conn-ig" });
    });

    it("a 401 whose stored tokens changed meanwhile is CONNECTION_TOKEN_CHANGED and flags nothing", async () => {
      findUniqueMock.mockResolvedValue(ROTATED_TOKENS);
      const { store } = makeStore(stateWith(1));
      stubGraph({ status: () => new Response("{}", { status: 401 }) });

      const error = await failure(instagramClient.publishVideo(ctx(store)));

      expect(error?.code).toBe("CONNECTION_TOKEN_CHANGED");
      expect(updateMock).not.toHaveBeenCalled();
    });

    it.each([
      ["a 500", () => new Response("{}", { status: 500 })],
      ["a 400 that is not a throttle or a dead token", () => graphError(100)],
      ["a 200 whose body is not JSON", () => new Response("<html>hi</html>", { status: 200 })],
      ["a 200 without a status_code", () => new Response("{}", { status: 200 })],
      ["a status_code we do not know", () => status("SOMETHING_NEW")],
      ["a connection error", () => Promise.reject(new TypeError("fetch failed"))],
      [
        "a request timeout",
        () => Promise.reject(Object.assign(new Error("Request timed out"), { code: "FETCH_TIMEOUT" })),
      ],
    ] as const)("%s counts as a check and the poll continues", async (_name, answer) => {
      const { store, savedData } = makeStore(stateWith(1));
      const graph = stubGraph({ status: answer });

      const result = await instagramClient.publishVideo(ctx(store));

      expect(result).toEqual(continuation);
      expect(savedData()).toMatchObject({ checks: 2 });
      expect(graph.publish).not.toHaveBeenCalled();
    });

    it("an unanswered 5th check ends with INSTAGRAM_VIDEO_TIMEOUT, not an endless poll", async () => {
      const { store } = makeStore(stateWith(INSTAGRAM_STATUS_MAX_CHECKS - 1));
      stubGraph({ status: () => Promise.reject(new TypeError("fetch failed")) });

      expect((await failure(instagramClient.publishVideo(ctx(store))))?.code).toBe("INSTAGRAM_VIDEO_TIMEOUT");
    });

    it("refuses to start the check once the step budget is spent (retry-safe, no request)", async () => {
      const { store } = makeStore(stateWith(1));
      const graph = stubGraph({});

      const error = await failure(
        instagramClient.publishVideo(ctx(store, { deadline: NOW + MIN_REQUEST_WINDOW_MS - 1 })),
      );

      expect(error?.code).toBe(PUBLISH_BUDGET_EXCEEDED_CODE);
      expect(graph.status).not.toHaveBeenCalled();
      expect(graph.publish).not.toHaveBeenCalled();
    });
  });

  // A container is discarded by Meta 24 h after it was created (EXPIRED, "not published
  // within 24 hours"), and a deferral can last that long. A saved container older than
  // INSTAGRAM_CONTAINER_MAX_AGE_MS is never checked: it is cleared and replaced.
  describe("a saved container that is too old", () => {
    const secondContainer = () => new Response(JSON.stringify({ id: "container-2" }), { status: 200 });

    it("23 h and 1 ms old: cleared and replaced by a new container, with no status check on the old one", async () => {
      const { store, mocks, savedData } = makeStore(stateWith(1, INSTAGRAM_CONTAINER_MAX_AGE_MS + 1));
      const graph = stubGraph({ container: secondContainer });

      const result = await instagramClient.publishVideo(ctx(store));

      expect(mocks.clear).toHaveBeenCalledTimes(1);
      expect(graph.container).toHaveBeenCalledTimes(1);
      expect(graph.status).not.toHaveBeenCalled();
      expect(graph.publish).not.toHaveBeenCalled();
      expect(result).toEqual(continuation);
      expect(savedData()).toEqual({
        containerId: "container-2",
        createdAt: new Date(NOW).toISOString(),
        checks: 0,
      });
    });

    it("22 h 59 min old: the saved container is still checked", async () => {
      const { store, mocks } = makeStore(stateWith(1, 23 * HOUR - 60_000));
      const graph = stubGraph({ status: () => status("FINISHED") });

      await expect(instagramClient.publishVideo(ctx(store))).resolves.toEqual({ externalPostId: "media-1" });

      expect(graph.container).not.toHaveBeenCalled();
      expect(graph.status).toHaveBeenCalledTimes(1);
      expect(mocks.clear).not.toHaveBeenCalled();
    });

    it("exactly 23 h old is not yet stale (older than, not at least)", async () => {
      const { store } = makeStore(stateWith(1, INSTAGRAM_CONTAINER_MAX_AGE_MS));
      const graph = stubGraph({ status: () => status("IN_PROGRESS") });

      await instagramClient.publishVideo(ctx(store));

      expect(graph.container).not.toHaveBeenCalled();
      expect(graph.status).toHaveBeenCalledTimes(1);
    });

    it("an old container on its last check is replaced rather than timed out", async () => {
      const { store } = makeStore(stateWith(INSTAGRAM_STATUS_MAX_CHECKS - 1, 24 * HOUR));
      const graph = stubGraph({ container: secondContainer });

      const result = await instagramClient.publishVideo(ctx(store));

      expect(result).toEqual(continuation);
      expect(graph.status).not.toHaveBeenCalled();
    });

    it.each([
      ["not a date", "not a date"],
      ["empty", ""],
      ["missing", undefined],
      ["a number", NOW - 60_000],
      ["null", null],
    ])("a createdAt that is %s counts as stale: a new container is created", async (_name, createdAt) => {
      const { store, savedData } = makeStore({ containerId: "container-1", checks: 1, createdAt });
      const graph = stubGraph({ container: secondContainer });

      const result = await instagramClient.publishVideo(ctx(store));

      expect(result).toEqual(continuation);
      expect(graph.container).toHaveBeenCalledTimes(1);
      expect(graph.status).not.toHaveBeenCalled();
      expect(savedData()).toMatchObject({ containerId: "container-2", checks: 0 });
    });

    it("a createdAt in the future (clock skew) is not stale", async () => {
      const { store } = makeStore(stateWith(1, -5 * 60_000));
      const graph = stubGraph({ status: () => status("IN_PROGRESS") });

      await instagramClient.publishVideo(ctx(store));

      expect(graph.container).not.toHaveBeenCalled();
      expect(graph.status).toHaveBeenCalledTimes(1);
    });

    it("a clear that fails does not fail the step: the new container's state replaces the old one", async () => {
      const { store, mocks, savedData } = makeStore(stateWith(1, 24 * HOUR));
      mocks.clear.mockRejectedValueOnce(new Error("database blip"));
      stubGraph({ container: secondContainer });

      const result = await instagramClient.publishVideo(ctx(store));

      expect(result).toEqual(continuation);
      expect(savedData()).toMatchObject({ containerId: "container-2", checks: 0 });
    });

    it("a status-check throttle whose wait runs past 23 h ends in a new container at the deferred attempt", async () => {
      const { store, savedData } = makeStore(stateWith(2));
      const graph = stubGraph({
        status: () => graphError(80002),
        container: secondContainer,
      });

      const error = await failure(instagramClient.publishVideo(ctx(store)));
      expect(error?.code).toBe("RATE_LIMITED");
      expect(savedData()).toEqual(stateWith(2));

      // The deferred attempt runs more than 23 h later.
      vi.setSystemTime(NOW + 23 * HOUR + 60_000);
      const next = await instagramClient.publishVideo(ctx(store));

      expect(graph.container).toHaveBeenCalledTimes(1);
      expect(graph.status).toHaveBeenCalledTimes(1);
      expect(next.continuation).toBeDefined();
      expect(savedData()).toMatchObject({ containerId: "container-2", checks: 0 });
    });
  });

  describe("the commit call (media_publish after FINISHED) keeps its rules", () => {
    it("a 5xx is PUBLISH_UNCONFIRMED and is not retried", async () => {
      const { store } = makeStore(stateWith(1));
      const graph = stubGraph({ publish: () => new Response("{}", { status: 500 }) });

      const error = await failure(instagramClient.publishVideo(ctx(store)));

      expect(error?.code).toBe("PUBLISH_UNCONFIRMED");
      expect(graph.publish).toHaveBeenCalledTimes(1);
    });

    it("a 2xx without a post id is PUBLISH_UNCONFIRMED", async () => {
      const { store } = makeStore(stateWith(1));
      stubGraph({ publish: () => new Response("{}", { status: 200 }) });

      expect((await failure(instagramClient.publishVideo(ctx(store))))?.code).toBe("PUBLISH_UNCONFIRMED");
    });

    const dailyCap = () =>
      new Response(
        JSON.stringify({ error: { message: "m", type: "OAuthException", code: 9, error_subcode: 2207042 } }),
        { status: 400 },
      );

    // The 100-posts-a-day cap defers the result by 24 h. The refusal is definitive (nothing
    // was posted) and the container would be older than Meta's 24 h by the deferred attempt,
    // so the saved state is cleared and that attempt creates a new container.
    it("the 100-posts-a-day cap is a RATE_LIMITED daily_limit deferral and the saved container is cleared", async () => {
      const { store, mocks, saved } = makeStore(stateWith(1));
      stubGraph({ publish: dailyCap });

      const error = await failure(instagramClient.publishVideo(ctx(store)));

      expect(error).toMatchObject({ code: "RATE_LIMITED", kind: "daily_limit" });
      expect(mocks.clear).toHaveBeenCalledTimes(1);
      expect(saved()).toBeNull();
    });

    it("a daily-cap refusal is still RATE_LIMITED when clearing the state fails", async () => {
      const { store, mocks } = makeStore(stateWith(1));
      mocks.clear.mockRejectedValueOnce(new Error("database blip"));
      stubGraph({ publish: dailyCap });

      const error = await failure(instagramClient.publishVideo(ctx(store)));

      expect(error).toMatchObject({ code: "RATE_LIMITED", kind: "daily_limit" });
    });

    it("an ordinary media_publish throttle keeps the saved container for the later attempt", async () => {
      const { store, mocks, savedData } = makeStore(stateWith(1));
      stubGraph({ publish: () => graphError(80002) });

      const error = await failure(instagramClient.publishVideo(ctx(store)));

      expect(error).toMatchObject({ code: "RATE_LIMITED", kind: "rate_limited" });
      expect(mocks.clear).not.toHaveBeenCalled();
      expect(savedData()).toEqual(stateWith(1));
    });

    it("after the daily cap, the deferred attempt creates a NEW container and publishes it", async () => {
      const { store, savedData } = makeStore(stateWith(1));
      let published = 0;
      const graph = stubGraph({
        container: () => new Response(JSON.stringify({ id: "container-2" }), { status: 200 }),
        publish: () => (++published === 1 ? dailyCap() : publishOk()),
      });

      // The step that saw FINISHED and hit the cap.
      expect(await failure(instagramClient.publishVideo(ctx(store)))).toMatchObject({
        code: "RATE_LIMITED",
        kind: "daily_limit",
      });
      // 24 h later: the old container is gone from the state, so a new one is made.
      vi.setSystemTime(NOW + 24 * HOUR);
      const created = await instagramClient.publishVideo(ctx(store));
      expect(created.continuation).toEqual({ resumeAt: NOW + 24 * HOUR + 60_000 });
      expect(savedData()).toMatchObject({ containerId: "container-2", checks: 0 });
      // One minute later it is FINISHED and published.
      vi.setSystemTime(NOW + 24 * HOUR + 60_000);
      const done = await instagramClient.publishVideo(ctx(store));

      expect(done).toEqual({ externalPostId: "media-1" });
      expect(graph.container).toHaveBeenCalledTimes(1);
      // One check on the old container (FINISHED, then refused), one on the new one.
      expect(graph.status).toHaveBeenCalledTimes(2);
      expect(graph.publish).toHaveBeenCalledTimes(2);
      const urls = vi.mocked(globalThis.fetch).mock.calls.map((c) => String(c[0]));
      expect(urls.filter((u) => u.includes("/container-2?"))).toHaveLength(1);
      const lastPublish = urls.filter((u) => u.includes("/media_publish")).at(-1)!;
      expect(new URL(lastPublish).searchParams.get("creation_id")).toBe("container-2");
    });

    it("a rejected token flags the connection", async () => {
      const { store } = makeStore(stateWith(1));
      stubGraph({ publish: () => new Response(AUTH_ERROR_BODY, { status: 400 }) });

      expect((await failure(instagramClient.publishVideo(ctx(store))))?.code).toBe("INSTAGRAM_RECONNECT_REQUIRED");
      expect(updateMock).toHaveBeenCalledTimes(1);
    });
  });

  describe("walking a whole run, one publishVideo call per step", () => {
    it("create, IN_PROGRESS, IN_PROGRESS, FINISHED: one container, one media_publish, success", async () => {
      const { store } = makeStore();
      const answers = ["IN_PROGRESS", "IN_PROGRESS", "FINISHED"];
      const graph = stubGraph({ status: () => status(answers.shift()!) });

      const outcomes = [];
      for (let step = 0; step < 4; step++) outcomes.push(await instagramClient.publishVideo(ctx(store)));

      expect(outcomes).toEqual([continuation, continuation, continuation, { externalPostId: "media-1" }]);
      expect(graph.container).toHaveBeenCalledTimes(1);
      expect(graph.status).toHaveBeenCalledTimes(3);
      expect(graph.publish).toHaveBeenCalledTimes(1);
    });

    it("a container stuck IN_PROGRESS is given exactly five checks, then INSTAGRAM_VIDEO_TIMEOUT", async () => {
      const { store } = makeStore();
      const graph = stubGraph({ status: () => status("IN_PROGRESS") });

      const outcomes: unknown[] = [];
      for (let step = 0; step < 1 + INSTAGRAM_STATUS_MAX_CHECKS - 1; step++) {
        outcomes.push(await instagramClient.publishVideo(ctx(store)));
      }
      const last = await failure(instagramClient.publishVideo(ctx(store)));

      // The creating step plus four checks continue; the fifth check gives up.
      expect(outcomes).toHaveLength(INSTAGRAM_STATUS_MAX_CHECKS);
      expect(outcomes.every((o) => JSON.stringify(o) === JSON.stringify(continuation))).toBe(true);
      expect(last?.code).toBe("INSTAGRAM_VIDEO_TIMEOUT");
      expect(graph.container).toHaveBeenCalledTimes(1);
      expect(graph.status).toHaveBeenCalledTimes(INSTAGRAM_STATUS_MAX_CHECKS);
      expect(graph.publish).not.toHaveBeenCalled();
    });

    it("a re-run of the creating step (its output was lost) finds the state and never makes a second container", async () => {
      const { store } = makeStore();
      const graph = stubGraph({ status: () => status("IN_PROGRESS") });

      await instagramClient.publishVideo(ctx(store)); // creates the container, saves checks 0
      await instagramClient.publishVideo(ctx(store)); // the same step again

      expect(graph.container).toHaveBeenCalledTimes(1);
    });
  });

  describe("without a store, or for an image: today's in-step behavior", () => {
    it("a video with no store still polls inside the step (the legacy path) and publishes", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(NOW);
      const graph = stubGraph({ status: () => status("FINISHED") });

      const promise = instagramClient.publishVideo(ctx(undefined));
      await vi.advanceTimersByTimeAsync(INSTAGRAM_POLL_INTERVAL_MS);

      await expect(promise).resolves.toEqual({ externalPostId: "media-1" });
      expect(graph.container).toHaveBeenCalledTimes(1);
      expect(graph.publish).toHaveBeenCalledTimes(1);
    });

    it("an image waits 3 s in the step and publishes; it never reads or writes the state", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(NOW);
      const { store, mocks } = makeStore();
      const graph = stubGraph({});

      const promise = instagramClient.publishVideo(ctx(store, { mimeType: "image/jpeg" }));
      await vi.advanceTimersByTimeAsync(3_000);

      await expect(promise).resolves.toEqual({ externalPostId: "media-1" });
      expect(graph.status).not.toHaveBeenCalled();
      expect(graph.publish).toHaveBeenCalledTimes(1);
      expect(mocks.load).not.toHaveBeenCalled();
      expect(mocks.save).not.toHaveBeenCalled();
    });
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
      get mediaItems() { return [this.mediaItem]; },
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
    // container, media_publish, then the best-effort permalink lookup (2026-11-08;
    // unanswered here, so no link)
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(String(fetchMock.mock.calls[2][0])).toContain("fields=permalink");
    // container timeout, the 3 s image wait, the media_publish timeout, then the
    // permalink lookup's own 5 s cap (9 s were left)
    expect(setTimeoutSpy.mock.calls.map((c) => c[1])).toEqual([12_000, 3_000, 9_000, 5_000]);
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

// 07b: a post with several photos is one Instagram carousel
// (https://developers.facebook.com/docs/instagram-platform/content-publishing, "Carousel posts"):
// one container per photo with is_carousel_item=true, then a CAROUSEL container naming the
// children in order with the caption, then media_publish on it. The parent container waits
// across steps with the same saved state a REELS video uses.
describe("instagramClient.publishVideo — several photos (carousel)", () => {
  type CodedError = Error & { code?: string };
  const failure = (promise: Promise<unknown>) =>
    promise.then(
      () => null,
      (e: unknown) => e as CodedError,
    );

  const NOW = Date.parse("2026-11-10T10:00:00Z");
  const KIND = "instagram_container";
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  const savedAt = (ageMs: number, containerId = "carousel-1", checks = 0) => ({
    containerId,
    createdAt: new Date(NOW - ageMs).toISOString(),
    checks,
  });

  function makeStore(initial?: unknown) {
    const kept = new Map<string, UploadSnapshot<unknown, unknown>>();
    if (initial !== undefined) kept.set(KIND, { data: initial });
    const store = {
      load: vi.fn(async (kind: string) => kept.get(kind) ?? null),
      save: vi.fn(async (kind: string, snapshot: UploadSnapshot<unknown, unknown>) => {
        kept.set(kind, snapshot);
      }),
      clear: vi.fn(async () => {
        kept.clear();
      }),
    };
    return {
      store: store as unknown as UploadStateStore,
      mocks: store,
      savedData: () => kept.get(KIND)?.data ?? null,
    };
  }

  const photoUrl = (i: number) => `https://blob.example.com/p${i}`;

  /** A post of `count` photos; the list carries file fields only, as the publish function builds it. */
  function ctx(
    count: number,
    extra: { store?: UploadStateStore; deadline?: number; mimeTypes?: string[]; caption?: string } = {},
  ) {
    const mediaItems = Array.from({ length: count }, (_, i) => ({
      mimeType: extra.mimeTypes?.[i] ?? (i % 2 ? "image/png" : "image/jpeg"),
      storageLocation: photoUrl(i),
      metadata: null,
      baseCaption: "",
      perPlatformOverrides: null,
    })) as unknown as MediaItem[];
    return {
      user: { id: "user-1" } as unknown as User,
      socialConnection: makeConnection({ id: "conn-ig", expiresAt: null }),
      mediaItem: { ...mediaItems[0], baseCaption: "base text" } as unknown as MediaItem,
      mediaItems,
      caption: extra.caption ?? "hello carousel",
      deadline: extra.deadline,
      uploadState: extra.store,
    };
  }

  type Route = (url: URL) => Response | Promise<Response>;
  /**
   * Graph stub. Children answer child-1, child-2, ... in creation order; the parent
   * answers carousel-1. Every request is kept, in order, for the exact-sequence checks.
   */
  function stubGraph(routes: { child?: Route; parent?: Route; status?: Route; publish?: Route } = {}) {
    let children = 0;
    const requests: URL[] = [];
    const fetchMock = vi.fn((input: string | URL) => {
      const url = new URL(String(input));
      requests.push(url);
      if (url.pathname.endsWith("/media_publish")) {
        return Promise.resolve((routes.publish ?? (() => json({ id: "media-9" })))(url));
      }
      if (url.pathname.endsWith("/ig-account-1/media")) {
        if (url.searchParams.get("is_carousel_item") === "true") {
          children += 1;
          const n = children;
          return Promise.resolve((routes.child ?? (() => json({ id: `child-${n}` })))(url));
        }
        return Promise.resolve((routes.parent ?? (() => json({ id: "carousel-1" })))(url));
      }
      if (url.searchParams.get("fields") === "status_code") {
        return Promise.resolve((routes.status ?? (() => json({ status_code: "FINISHED" })))(url));
      }
      if (url.searchParams.get("fields") === "permalink") {
        return Promise.resolve(json({ permalink: "https://www.instagram.com/p/abc/" }));
      }
      throw new Error(`Unexpected fetch in test: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const isChild = (u: URL) => u.searchParams.get("is_carousel_item") === "true";
    const isParent = (u: URL) => u.pathname.endsWith("/ig-account-1/media") && !isChild(u);
    return {
      fetchMock,
      requests,
      childRequests: () => requests.filter(isChild),
      parentRequests: () => requests.filter(isParent),
      statusRequests: () => requests.filter((u) => u.searchParams.get("fields") === "status_code"),
      publishRequests: () => requests.filter((u) => u.pathname.endsWith("/media_publish")),
    };
  }

  /** The photo a child container hands Instagram: the app's signed, fitted copy of the stored photo. */
  function expectFittedPhoto(child: URL, i: number) {
    const imageUrl = new URL(String(child.searchParams.get("image_url")));
    expect(`${imageUrl.origin}${imageUrl.pathname}`).toBe("https://vibesocials.wtf/api/instagram-photo");
    expect(imageUrl.searchParams.get("src")).toBe(photoUrl(i));
    expect(
      verifyInstagramPhotoRequest(
        imageUrl.searchParams.get("src"),
        imageUrl.searchParams.get("exp"),
        imageUrl.searchParams.get("sig"),
      ),
    ).toBe(true);
  }

  /** The exact fields of each child container, in order. */
  function expectChildren(childRequests: URL[], count: number) {
    expect(childRequests).toHaveLength(count);
    childRequests.forEach((child, i) => {
      expect(child.pathname.endsWith("/ig-account-1/media")).toBe(true);
      expect([...child.searchParams.keys()].sort()).toEqual(["access_token", "image_url", "is_carousel_item"]);
      expect(child.searchParams.get("is_carousel_item")).toBe("true");
      expect(child.searchParams.get("access_token")).toBe("page-access-token");
      expectFittedPhoto(child, i);
    });
  }

  function expectParent(parent: URL, count: number, caption = "hello carousel") {
    expect([...parent.searchParams.keys()].sort()).toEqual(["access_token", "caption", "children", "media_type"]);
    expect(parent.searchParams.get("media_type")).toBe("CAROUSEL");
    expect(parent.searchParams.get("children")).toBe(
      Array.from({ length: count }, (_, i) => `child-${i + 1}`).join(","),
    );
    expect(parent.searchParams.get("caption")).toBe(caption);
    expect(parent.searchParams.get("access_token")).toBe("page-access-token");
  }

  const continuation = { continuation: { resumeAt: NOW + 60_000 } };
  const published = { externalPostId: "media-9", externalPostUrl: "https://www.instagram.com/p/abc/" };

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    vi.stubEnv("NEXTAUTH_URL", "https://vibesocials.wtf");
    vi.stubEnv("NEXTAUTH_SECRET", "test-secret");
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  /** A request's last path segment and its `fields`, e.g. "carousel-1?status_code". */
  const shortName = (u: URL) => {
    if (u.searchParams.get("is_carousel_item") === "true") return "child";
    if (u.pathname.endsWith("/ig-account-1/media")) return "parent";
    return `${u.pathname.split("/").pop()}?${u.searchParams.get("fields") ?? ""}`;
  };

  /** Exactly one media_publish, with exactly these fields. */
  function expectOnePublish(publishRequests: URL[]) {
    expect(publishRequests).toHaveLength(1);
    const publish = publishRequests[0];
    expect(publish.pathname.endsWith("/ig-account-1/media_publish")).toBe(true);
    expect([...publish.searchParams.keys()].sort()).toEqual(["access_token", "creation_id"]);
    expect(publish.searchParams.get("creation_id")).toBe("carousel-1");
    expect(publish.searchParams.get("access_token")).toBe("page-access-token");
  }

  it.each([2, 10])(
    "%i photos ready at once: children in order, one CAROUSEL container, one status check and one media_publish, all in the first step",
    async (count) => {
      const { store, savedData } = makeStore();
      const graph = stubGraph();

      const result = await instagramClient.publishVideo(ctx(count, { store }));

      expect(result).toEqual(published);
      expect(graph.requests.map(shortName)).toEqual([
        ...Array<string>(count).fill("child"),
        "parent",
        "carousel-1?status_code",
        "media_publish?",
        "media-9?permalink",
      ]);
      expectChildren(graph.childRequests(), count);
      expectParent(graph.parentRequests()[0], count);
      expectOnePublish(graph.publishRequests());
      expect(JSON.stringify(savedData())).not.toContain("page-access-token");
    },
  );

  it.each([2, 10])(
    "%i photos not ready at once: the first step waits; the next one checks, then makes one media_publish with the post id and link",
    async (count) => {
      const { store, savedData } = makeStore();
      const answers = ["IN_PROGRESS", "FINISHED"];
      const graph = stubGraph({ status: () => json({ status_code: answers.shift() }) });

      const first = await instagramClient.publishVideo(ctx(count, { store }));

      expect(first).toEqual(continuation);
      expect(graph.requests.map(shortName)).toEqual([
        ...Array<string>(count).fill("child"),
        "parent",
        "carousel-1?status_code",
      ]);
      expect(savedData()).toEqual(savedAt(0, "carousel-1", 1));
      expect(JSON.stringify(savedData())).not.toContain("page-access-token");

      graph.requests.length = 0;
      const second = await instagramClient.publishVideo(ctx(count, { store }));

      expect(second).toEqual(published);
      expect(graph.requests.map(shortName)).toEqual(["carousel-1?status_code", "media_publish?", "media-9?permalink"]);
      expectOnePublish(graph.publishRequests());
    },
  );

  it("saves the carousel before its first status check, so a step that dies after it resumes the same carousel", async () => {
    const { store, savedData } = makeStore();
    let savedAtCheck: unknown = "not checked";
    const graph = stubGraph({
      status: () => {
        savedAtCheck = savedData();
        return json({ status_code: "FINISHED" });
      },
    });

    await instagramClient.publishVideo(ctx(2, { store }));

    expect(savedAtCheck).toEqual(savedAt(0));
    expectOnePublish(graph.publishRequests());
  });

  it("a step that runs again after the carousel was saved checks it and never creates a second one", async () => {
    // The first step's output was lost after the save (its check said IN_PROGRESS).
    const { store } = makeStore();
    const answers = ["IN_PROGRESS", "FINISHED"];
    const graph = stubGraph({ status: () => json({ status_code: answers.shift() }) });

    await instagramClient.publishVideo(ctx(3, { store }));
    const again = await instagramClient.publishVideo(ctx(3, { store }));

    expect(again).toEqual(published);
    expect(graph.childRequests()).toHaveLength(3);
    expect(graph.parentRequests()).toHaveLength(1);
    expectOnePublish(graph.publishRequests());
  });

  it("with too little of the step left for a check and the publish, saves the carousel and continues", async () => {
    const { store, savedData } = makeStore();
    // Enough for the three container calls (the clock does not move), not for the reserve.
    const graph = stubGraph();

    const result = await instagramClient.publishVideo(
      ctx(2, { store, deadline: NOW + INSTAGRAM_PUBLISH_RESERVE_MS + MIN_REQUEST_WINDOW_MS - 1 }),
    );

    expect(result).toEqual(continuation);
    expect(graph.statusRequests()).toHaveLength(0);
    expect(graph.publishRequests()).toHaveLength(0);
    expect(savedData()).toEqual(savedAt(0));
  });

  it("the daily cap on the carousel's publish clears it; the deferred attempt makes new photo containers and a new carousel", async () => {
    const { store, savedData } = makeStore();
    let publishes = 0;
    const graph = stubGraph({
      publish: () =>
        ++publishes === 1
          ? json({ error: { message: "m", type: "OAuthException", code: 9, error_subcode: 2207042 } }, 400)
          : json({ id: "media-9" }),
    });

    const error = await failure(instagramClient.publishVideo(ctx(2, { store })));

    expect(error?.code).toBe("RATE_LIMITED");
    expect((error as { kind?: string } | null)?.kind).toBe("daily_limit");
    expect(savedData()).toBeNull();

    graph.requests.length = 0;
    const deferred = await instagramClient.publishVideo(ctx(2, { store }));

    expect(deferred).toEqual(published);
    expect(graph.requests.map(shortName)).toEqual([
      "child",
      "child",
      "parent",
      "carousel-1?status_code",
      "media_publish?",
      "media-9?permalink",
    ]);
    // Children numbered on from the first attempt: new containers, not the old ones.
    expect(graph.parentRequests()[0].searchParams.get("children")).toBe("child-3,child-4");
  });

  it("takes the text from ctx.caption (cut to Instagram's limit), never from the list entries", async () => {
    const graph = stubGraph();
    const long = "x".repeat(2_300);

    await instagramClient.publishVideo(ctx(2, { store: makeStore().store, caption: long }));

    expectParent(graph.parentRequests()[0], 2, computeInstagramCaption(long));
  });

  it("without a store, waits for the parent inside the step and publishes once", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const graph = stubGraph();

    const promise = instagramClient.publishVideo(ctx(3));
    await vi.advanceTimersByTimeAsync(INSTAGRAM_POLL_INTERVAL_MS);

    await expect(promise).resolves.toEqual(published);
    expectChildren(graph.childRequests(), 3);
    expect(graph.parentRequests()).toHaveLength(1);
    expect(graph.statusRequests()[0].pathname.endsWith("/carousel-1")).toBe(true);
    expect(graph.publishRequests()).toHaveLength(1);
  });

  it("the second photo failing: one clear message, no parent, no publish, nothing saved", async () => {
    const { store, savedData } = makeStore();
    let n = 0;
    const graph = stubGraph({
      child: () =>
        ++n === 2 ? json({ error: { message: "m", type: "OAuthException", code: 100 } }, 400) : json({ id: `child-${n}` }),
    });

    const error = await failure(instagramClient.publishVideo(ctx(3, { store })));

    expect(error?.code).toBe("INSTAGRAM_CAROUSEL_ITEM_FAILED");
    expect(error?.message).toBe("Instagram did not accept photo 2 of 3, so nothing was posted. Please retry.");
    expect(graph.childRequests()).toHaveLength(2);
    expect(graph.parentRequests()).toHaveLength(0);
    expect(graph.publishRequests()).toHaveLength(0);
    expect(savedData()).toBeNull();
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("a photo answered without a container id fails the same way", async () => {
    let n = 0;
    const graph = stubGraph({ child: () => (++n === 2 ? json({}) : json({ id: `child-${n}` })) });

    const error = await failure(instagramClient.publishVideo(ctx(2, { store: makeStore().store })));

    expect(error?.code).toBe("INSTAGRAM_CAROUSEL_ITEM_FAILED");
    expect(graph.parentRequests()).toHaveLength(0);
  });

  it("a throttled photo stays RATE_LIMITED, and a dead token stays the reconnect error", async () => {
    stubGraph({ child: () => json({ error: { message: "m", type: "OAuthException", code: 80002 } }, 400) });
    expect((await failure(instagramClient.publishVideo(ctx(2, { store: makeStore().store }))))?.code).toBe(
      "RATE_LIMITED",
    );

    stubGraph({ child: () => json({ error: { message: "m", type: "OAuthException", code: 190 } }, 400) });
    expect((await failure(instagramClient.publishVideo(ctx(2, { store: makeStore().store }))))?.code).toBe(
      "INSTAGRAM_RECONNECT_REQUIRED",
    );
    expect(updateMock).toHaveBeenCalledTimes(1);
  });

  it("a failed CAROUSEL container: INSTAGRAM_CONTAINER_FAILED, nothing saved, no publish", async () => {
    const { store, savedData } = makeStore();
    const graph = stubGraph({ parent: () => json({}, 400) });

    const error = await failure(instagramClient.publishVideo(ctx(2, { store })));

    expect(error?.code).toBe("INSTAGRAM_CONTAINER_FAILED");
    expect(savedData()).toBeNull();
    expect(graph.publishRequests()).toHaveLength(0);
  });

  it("media_publish answering 500 is PUBLISH_UNCONFIRMED and is not sent again by the in-step retry", async () => {
    const { store } = makeStore(savedAt(60_000));
    const graph = stubGraph({ publish: () => json({}, 500) });

    const error = await failure(
      withTransientRetries(() => instagramClient.publishVideo(ctx(2, { store })), { sleep: async () => {} }),
    );

    expect(error?.code).toBe("PUBLISH_UNCONFIRMED");
    expect(error?.message).toBe(PUBLISH_UNCONFIRMED_MESSAGE);
    expect(graph.publishRequests()).toHaveLength(1);
    expect(graph.childRequests()).toHaveLength(0);
  });

  it.each([["video/mp4"], ["image/gif"]])("a %s among several photos: refused before any request", async (bad) => {
    const graph = stubGraph();
    const { store, mocks } = makeStore();

    const error = await failure(
      instagramClient.publishVideo(ctx(3, { store, mimeTypes: ["image/jpeg", bad, "image/png"] })),
    );

    expect(error?.code).toBe("INSTAGRAM_CAROUSEL_UNSUPPORTED_MEDIA");
    expect(error?.message).toBe(
      "Instagram can only post several JPG, PNG or WebP photos together. Remove file 2 and try again.",
    );
    expect(graph.fetchMock).not.toHaveBeenCalled();
    expect(mocks.load).not.toHaveBeenCalled();
  });

  it("accepts WebP photos (Instagram is handed the app's JPEG copy)", async () => {
    const graph = stubGraph();

    const result = await instagramClient.publishVideo(
      ctx(2, { store: makeStore().store, mimeTypes: ["image/webp", "image/webp"] }),
    );

    expect(result).toEqual(published);
    expectChildren(graph.childRequests(), 2);
  });

  it("a parent not ready before the step ends continues in the next step and publishes once", async () => {
    const { store } = makeStore();
    // The first answer is the creating step's own check.
    const answers = ["IN_PROGRESS", "IN_PROGRESS", "IN_PROGRESS", "FINISHED"];
    const graph = stubGraph({ status: () => json({ status_code: answers.shift() }) });

    const outcomes = [];
    for (let step = 0; step < 4; step++) outcomes.push(await instagramClient.publishVideo(ctx(4, { store })));

    expect(outcomes).toEqual([continuation, continuation, continuation, published]);
    expect(graph.childRequests()).toHaveLength(4);
    expect(graph.parentRequests()).toHaveLength(1);
    expect(graph.statusRequests()).toHaveLength(4);
    expectOnePublish(graph.publishRequests());
  });

  it("a re-run of the creating step (its output was lost) checks the saved carousel instead of making a second", async () => {
    const { store } = makeStore();
    const graph = stubGraph({ status: () => json({ status_code: "IN_PROGRESS" }) });

    await instagramClient.publishVideo(ctx(2, { store }));
    await instagramClient.publishVideo(ctx(2, { store }));

    expect(graph.childRequests()).toHaveLength(2);
    expect(graph.parentRequests()).toHaveLength(1);
  });

  it("a carousel stuck IN_PROGRESS gets five checks, then fails with a photo message and no publish", async () => {
    const { store } = makeStore();
    const graph = stubGraph({ status: () => json({ status_code: "IN_PROGRESS" }) });

    // The creating step makes the first check, so four steps continue and the fifth check gives up.
    for (let step = 0; step < INSTAGRAM_STATUS_MAX_CHECKS - 1; step++) {
      expect(await instagramClient.publishVideo(ctx(2, { store }))).toEqual(continuation);
    }
    const error = await failure(instagramClient.publishVideo(ctx(2, { store })));

    expect(error?.code).toBe("INSTAGRAM_CAROUSEL_TIMEOUT");
    expect(error?.message).toBe("Instagram took too long to process the photos, so nothing was posted. Please retry.");
    expect(graph.statusRequests()).toHaveLength(INSTAGRAM_STATUS_MAX_CHECKS);
    expect(graph.publishRequests()).toHaveLength(0);
  });

  it("a carousel Instagram reports as ERROR fails with a photo message and no publish", async () => {
    const { store } = makeStore(savedAt(60_000));
    const graph = stubGraph({ status: () => json({ status_code: "ERROR" }) });

    const error = await failure(instagramClient.publishVideo(ctx(2, { store })));

    expect(error?.code).toBe("INSTAGRAM_CAROUSEL_PROCESSING_ERROR");
    expect(error?.message).toBe("Instagram could not process the photos, so nothing was posted.");
    expect(graph.publishRequests()).toHaveLength(0);
  });

  it("a carousel Instagram reports as EXPIRED keeps the code with a photo message, and no publish", async () => {
    const { store } = makeStore(savedAt(60_000));
    const graph = stubGraph({ status: () => json({ status_code: "EXPIRED" }) });

    const error = await failure(instagramClient.publishVideo(ctx(2, { store })));

    expect(error?.code).toBe("INSTAGRAM_CONTAINER_EXPIRED");
    expect(error?.message).toBe("Instagram discarded the photos before they were posted. Please retry.");
    expect(graph.publishRequests()).toHaveLength(0);
  });

  it("a saved carousel already PUBLISHED is PUBLISH_UNCONFIRMED and is never sent to media_publish", async () => {
    const { store } = makeStore(savedAt(60_000));
    const graph = stubGraph({ status: () => json({ status_code: "PUBLISHED" }) });

    const error = await failure(instagramClient.publishVideo(ctx(2, { store })));

    expect(error?.code).toBe("PUBLISH_UNCONFIRMED");
    expect(error?.message).toBe(PUBLISH_UNCONFIRMED_MESSAGE);
    expect(graph.publishRequests()).toHaveLength(0);
    expect(graph.childRequests()).toHaveLength(0);
  });

  it("a saved carousel older than 23 h is replaced by a new one, not checked", async () => {
    const { store, savedData } = makeStore(savedAt(INSTAGRAM_CONTAINER_MAX_AGE_MS + 1, "old-carousel", 1));
    const graph = stubGraph({ status: () => json({ status_code: "IN_PROGRESS" }) });

    expect(await instagramClient.publishVideo(ctx(2, { store }))).toEqual(continuation);
    // Only the new carousel is checked.
    expect(graph.statusRequests().map((u) => u.pathname.split("/").pop())).toEqual(["carousel-1"]);
    expect(graph.childRequests()).toHaveLength(2);
    expect(savedData()).toEqual(savedAt(0, "carousel-1", 1));
  });

  it("a spent step budget before the first photo is retry-safe: PUBLISH_TIME_BUDGET_EXCEEDED, no request", async () => {
    const graph = stubGraph();

    const error = await failure(
      instagramClient.publishVideo(ctx(2, { store: makeStore().store, deadline: NOW + MIN_REQUEST_WINDOW_MS - 1 })),
    );

    expect(error?.code).toBe(PUBLISH_BUDGET_EXCEEDED_CODE);
    expect(graph.fetchMock).not.toHaveBeenCalled();
  });
});
