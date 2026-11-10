import type { MediaItem, SocialConnection, User } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PUBLISH_UNCONFIRMED_MESSAGE } from "@/lib/publishOutcomes";
import {
  computeGbpPostSummary,
  googleBusinessProfileClient,
} from "@/server/platforms/googleBusinessProfileClient";
import {
  MIN_REQUEST_WINDOW_MS,
  PUBLISH_BUDGET_EXCEEDED_CODE,
  PUBLISH_STEP_BUDGET_MS,
} from "@/server/platforms/publishBudget";
import { withTransientRetries } from "@/server/platforms/transientRetry";
import type { PublishContext } from "@/server/platforms/types";

// Google Business Profile photo publishing. No real Google endpoint and no
// database: every call goes through a stubbed global fetch (googleTokens.ts
// resolves prisma lazily - through this mock - and only when a token expired).
const { updateMock, refreshConnectionTokenMock } = vi.hoisted(() => ({
  updateMock: vi.fn(),
  // The per-connection refresh lock has its own suite (connectionRefresh.test.ts):
  // here it is a pass-through spy, so the refresh itself still runs.
  refreshConnectionTokenMock: vi.fn<
    (
      snapshot: unknown,
      refresh: (current: unknown) => Promise<unknown>,
      opts?: { deadline?: number },
    ) => Promise<unknown>
  >((snapshot, refresh) => refresh(snapshot)),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    socialConnection: {
      update: updateMock,
    },
  },
}));

vi.mock("@/server/platforms/connectionRefresh", () => ({
  refreshConnectionToken: refreshConnectionTokenMock,
}));

const NOW = Date.parse("2026-11-01T12:00:00Z");

function makeContext(): PublishContext {
  return {
    user: { id: "user-1" } as unknown as User,
    socialConnection: {
      id: "conn-gbp",
      platform: "google_business_profile",
      accessToken: "access-token",
      refreshToken: "refresh-token",
      expiresAt: null,
      metadata: { locationName: "accounts/111/locations/999" },
    } as unknown as SocialConnection,
    get mediaItems() { return [this.mediaItem]; },
    mediaItem: {
      mimeType: "image/jpeg",
      storageLocation: "https://blob.example.com/photo.jpg",
      originalFilename: "photo.jpg",
    } as unknown as MediaItem,
    caption: "hello",
  };
}

function stubMediaCreate(response: () => Response) {
  const fetchMock = vi.fn<typeof fetch>((input) => {
    const url = String(input);
    if (url.includes("mybusiness.googleapis.com/v4/accounts/111/locations/999/localPosts")) {
      return Promise.resolve(response());
    }
    throw new Error(`Unexpected fetch in test: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

type CodedError = Error & {
  code?: string;
  kind?: string;
  platform?: string;
  retryAt?: number | null;
  status?: number;
};

const failure = (promise: Promise<unknown>) =>
  promise.then(
    () => null,
    (e: unknown) => e as CodedError,
  );

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("googleBusinessProfileClient.publishVideo", () => {
  it("publishes a photo as a post and returns its resource name", async () => {
    const fetchMock = stubMediaCreate(
      () => new Response(JSON.stringify({ name: "accounts/111/locations/999/localPosts/p1" }), { status: 200 }),
    );

    await expect(googleBusinessProfileClient.publishVideo(makeContext())).resolves.toEqual({
      externalPostId: "accounts/111/locations/999/localPosts/p1",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps the sanitized GBP_CREATE_POST_FAILED for a non-limit failure", async () => {
    stubMediaCreate(() => new Response("permission denied SECRET_TOKEN", { status: 403 }));

    const error = await failure(googleBusinessProfileClient.publishVideo(makeContext()));

    expect(error?.code).toBe("GBP_CREATE_POST_FAILED");
    expect(error?.status).toBe(403);
    expect(error?.message).not.toContain("SECRET_TOKEN");
  });
});

// 2026-11-08: a photo is a Business Profile post (an "Update" with the caption),
// not a caption-less gallery photo; a video still goes to the gallery.
describe("googleBusinessProfileClient.publishVideo — what is posted", () => {
  const POSTS_URL = "https://mybusiness.googleapis.com/v4/accounts/111/locations/999/localPosts";
  const MEDIA_URL = "https://mybusiness.googleapis.com/v4/accounts/111/locations/999/media";

  function stubAny(response: () => Response) {
    const fetchMock = vi.fn<typeof fetch>(() => Promise.resolve(response()));
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }
  const sentBody = (fetchMock: ReturnType<typeof stubAny>) =>
    JSON.parse(String(fetchMock.mock.calls[0][1]?.body)) as Record<string, unknown>;

  it("posts a photo with the caption as a STANDARD post", async () => {
    const fetchMock = stubAny(
      () => new Response(JSON.stringify({ name: "accounts/111/locations/999/localPosts/p1", state: "LIVE" })),
    );

    await googleBusinessProfileClient.publishVideo({ ...makeContext(), caption: "Surf's up!\n\n#surf" });

    expect(String(fetchMock.mock.calls[0][0])).toBe(POSTS_URL);
    expect(sentBody(fetchMock)).toEqual({
      languageCode: "en-US",
      topicType: "STANDARD",
      summary: "Surf's up!\n\n#surf",
      media: [{ mediaFormat: "PHOTO", sourceUrl: "https://blob.example.com/photo.jpg" }],
    });
  });

  it("cuts a caption over 1,500 characters the way the preview shows it", async () => {
    const fetchMock = stubAny(() => new Response(JSON.stringify({ name: "accounts/111/locations/999/localPosts/p1" })));

    await googleBusinessProfileClient.publishVideo({ ...makeContext(), caption: "🌊".repeat(1600) });

    const summary = String(sentBody(fetchMock).summary);
    expect(summary).toBe(`${"🌊".repeat(1497)}...`);
    expect(computeGbpPostSummary("🌊".repeat(1600))).toBe(summary);
  });

  it("sends a photo with no caption without an empty summary", async () => {
    const fetchMock = stubAny(() => new Response(JSON.stringify({ name: "accounts/111/locations/999/localPosts/p1" })));

    await googleBusinessProfileClient.publishVideo({ ...makeContext(), caption: "   " });

    expect(sentBody(fetchMock)).not.toHaveProperty("summary");
  });

  it("fails GBP_POST_REJECTED when Google rejects the post under its content policy", async () => {
    stubAny(
      () => new Response(JSON.stringify({ name: "accounts/111/locations/999/localPosts/p1", state: "REJECTED" })),
    );

    const error = await failure(googleBusinessProfileClient.publishVideo(makeContext()));

    expect(error?.code).toBe("GBP_POST_REJECTED");
  });

  it("still adds a video to the gallery (posts take photos only)", async () => {
    const fetchMock = stubAny(() => new Response(JSON.stringify({ name: "accounts/111/locations/999/media/v1" })));
    const base = makeContext();

    await expect(
      googleBusinessProfileClient.publishVideo({
        ...base,
        mediaItem: { ...base.mediaItem, mimeType: "video/mp4", storageLocation: "https://blob.example.com/clip.mp4" },
      }),
    ).resolves.toEqual({ externalPostId: "accounts/111/locations/999/media/v1" });

    expect(String(fetchMock.mock.calls[0][0])).toBe(MEDIA_URL);
    expect(sentBody(fetchMock)).toEqual({
      mediaFormat: "VIDEO",
      sourceUrl: "https://blob.example.com/clip.mp4",
      locationAssociation: { category: "ADDITIONAL" },
    });
  });

  it("keeps GBP_CREATE_MEDIA_FAILED for a refused video", async () => {
    stubAny(() => new Response("denied", { status: 403 }));
    const base = makeContext();

    const error = await failure(
      googleBusinessProfileClient.publishVideo({
        ...base,
        mediaItem: { ...base.mediaItem, mimeType: "video/mp4" },
      }),
    );

    expect(error?.code).toBe("GBP_CREATE_MEDIA_FAILED");
  });
});

// 2026-11-01 scale audit (platform limits, V17): GBP allows 300 QPM per API and
// 10 edits/min per profile and answers an excess with HTTP 429 (Retry-After is
// not documented, so retryAt may be null).
describe("googleBusinessProfileClient.publishVideo — rate limits (RATE_LIMITED)", () => {
  it("post create 429 with Retry-After: 30 -> retryAt = now + 30 s", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    stubMediaCreate(() => new Response("", { status: 429, headers: { "Retry-After": "30" } }));

    const error = await failure(googleBusinessProfileClient.publishVideo(makeContext()));

    expect(error).toMatchObject({
      code: "RATE_LIMITED",
      platform: "google_business_profile",
      kind: "rate_limited",
      retryAt: NOW + 30_000,
    });
    expect(error?.message).toBe("Google Business Profile is limiting requests right now.");
  });

  it("post create 429 without Retry-After -> retryAt null", async () => {
    stubMediaCreate(() => new Response("", { status: 429 }));

    const error = await failure(googleBusinessProfileClient.publishVideo(makeContext()));

    expect(error).toMatchObject({ code: "RATE_LIMITED", retryAt: null });
  });
});

// 2026-11-01 scale audit (jobs H6, Review Focus 5): `POST .../localPosts` is the
// commit call. A 5xx, a timeout or a dropped connection there may already have
// created the media item, so it is PUBLISH_UNCONFIRMED and is never re-run.
describe("googleBusinessProfileClient.publishVideo — commit call (POST .../localPosts)", () => {
  it("post create 500 -> PUBLISH_UNCONFIRMED, requested once", async () => {
    const fetchMock = stubMediaCreate(() => new Response("internal", { status: 500 }));

    const error = await failure(googleBusinessProfileClient.publishVideo(makeContext()));

    expect(error?.code).toBe("PUBLISH_UNCONFIRMED");
    expect(error?.message).toBe(PUBLISH_UNCONFIRMED_MESSAGE);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("post create 500 is not re-run by the in-step retry", async () => {
    const fetchMock = stubMediaCreate(() => new Response("internal", { status: 500 }));

    await expect(
      withTransientRetries(() => googleBusinessProfileClient.publishVideo(makeContext()), { sleep: async () => {} }),
    ).rejects.toMatchObject({ code: "PUBLISH_UNCONFIRMED" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("a connection dropped after the request was sent -> PUBLISH_UNCONFIRMED", async () => {
    stubMediaCreate(() => {
      throw new TypeError("fetch failed", { cause: { code: "ECONNRESET" } });
    });

    expect((await failure(googleBusinessProfileClient.publishVideo(makeContext())))?.code).toBe(
      "PUBLISH_UNCONFIRMED",
    );
  });

  it("a timeout -> PUBLISH_UNCONFIRMED", async () => {
    stubMediaCreate(() => {
      throw Object.assign(new Error("Request timed out after 30000ms"), { code: "FETCH_TIMEOUT" });
    });

    expect((await failure(googleBusinessProfileClient.publishVideo(makeContext())))?.code).toBe(
      "PUBLISH_UNCONFIRMED",
    );
  });

  it("a connection that was never made is rethrown unchanged (provably not sent)", async () => {
    const neverConnected = new TypeError("fetch failed", { cause: { code: "ENOTFOUND" } });
    stubMediaCreate(() => {
      throw neverConnected;
    });

    expect(await failure(googleBusinessProfileClient.publishVideo(makeContext()))).toBe(neverConnected);
  });

  // Final review F4 (I2): a 2xx media create means the item may exist, so a
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
  ] as const)("a 2xx post create with %s -> PUBLISH_UNCONFIRMED, requested once", async (_name, make) => {
    const fetchMock = stubMediaCreate(make);

    const error = await failure(googleBusinessProfileClient.publishVideo(makeContext()));

    expect(error?.code).toBe("PUBLISH_UNCONFIRMED");
    expect(error?.message).toBe(PUBLISH_UNCONFIRMED_MESSAGE);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  // 2026-11-02 scale audit (jobs): the media create answered 2xx ("created")
  // but the parsed body has no resource `name`: PUBLISH_UNCONFIRMED, not a
  // success with a null externalPostId.
  it.each([
    ["{}", "{}"],
    ["an empty name", JSON.stringify({ name: "" })],
    ["a numeric name", JSON.stringify({ name: 3 })],
    ["a JSON null body", "null"],
  ])("a 2xx post create with %s -> PUBLISH_UNCONFIRMED, requested once", async (_name, body) => {
    const fetchMock = stubMediaCreate(() => new Response(body, { status: 200 }));

    const error = await failure(googleBusinessProfileClient.publishVideo(makeContext()));

    expect(error?.code).toBe("PUBLISH_UNCONFIRMED");
    expect(error?.message).toBe(PUBLISH_UNCONFIRMED_MESSAGE);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("a 429 is still RATE_LIMITED and a 403 still GBP_CREATE_POST_FAILED", async () => {
    stubMediaCreate(() => new Response("", { status: 429 }));
    expect((await failure(googleBusinessProfileClient.publishVideo(makeContext())))?.code).toBe("RATE_LIMITED");

    stubMediaCreate(() => new Response("denied", { status: 403 }));
    expect((await failure(googleBusinessProfileClient.publishVideo(makeContext())))?.code).toBe(
      "GBP_CREATE_POST_FAILED",
    );
  });
});

// 2026-11-01 scale audit (step budget, Task 7): every GBP request - the token
// refresh, the store-code lookups and the media create - ends by the step
// deadline, and none is started with under 5 s left.
describe("googleBusinessProfileClient.publishVideo — step deadline", () => {
  const MEDIA_URL_FRAGMENT = "mybusiness.googleapis.com/v4/accounts/111/locations/999/localPosts";
  const TOKEN_URL_FRAGMENT = "oauth2.googleapis.com/token";
  const ACCOUNTS_URL_FRAGMENT = "mybusinessaccountmanagement.googleapis.com/v1/accounts";
  const LOCATIONS_URL_FRAGMENT = "mybusinessbusinessinformation.googleapis.com";
  // Any media create (the matching account differs per test).
  const ANY_MEDIA_URL_FRAGMENT = "mybusiness.googleapis.com/v4/";

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  const tokenOk = () => json({ access_token: "fresh-token", expires_in: 3600, token_type: "Bearer" });
  const mediaOk = () => json({ name: "accounts/111/locations/999/localPosts/p1" });
  const noLocations = () => json({ locations: [] });
  const matchingLocation = () => json({ locations: [{ name: "locations/999", storeCode: "STORE-1" }] });
  const accountsList = (count: number) =>
    json({ accounts: Array.from({ length: count }, (_, i) => ({ name: `accounts/${111 + i}` })) });

  /** The default context, with the connection's expiry / location overridden. */
  function ctx(
    overrides: { deadline?: number; expired?: boolean; locationName?: string } = {},
  ): PublishContext {
    const base = makeContext();
    return {
      ...base,
      deadline: overrides.deadline,
      socialConnection: {
        ...base.socialConnection,
        expiresAt: overrides.expired ? new Date("2020-01-01T00:00:00Z") : null,
        metadata: { locationName: overrides.locationName ?? "accounts/111/locations/999" },
      } as SocialConnection,
    };
  }

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
  function stubRoutes(routes: Record<string, Route>) {
    const fetchMock = vi.fn<typeof fetch>((input, init) => {
      const url = String(input);
      const route = Object.entries(routes).find(([fragment]) => url.includes(fragment));
      if (!route) throw new Error(`Unexpected fetch in test: ${url}`);
      return route[1](init);
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  beforeEach(() => {
    updateMock.mockReset();
    updateMock.mockImplementation((args: { data: Record<string, unknown> }) =>
      // The persisted row keeps the connection's metadata (the store code the refresh test publishes with).
      Promise.resolve({ ...makeContext().socialConnection, metadata: { locationName: "STORE-1" }, ...args.data }),
    );
    vi.stubEnv("GOOGLE_GBP_CLIENT_ID", "test-client-id");
    vi.stubEnv("GOOGLE_GBP_CLIENT_SECRET", "test-client-secret");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("refuses to start once the step budget is spent (no request at all)", async () => {
    const fetchMock = stubRoutes({ [MEDIA_URL_FRAGMENT]: async () => mediaOk() });

    const error = await failure(
      googleBusinessProfileClient.publishVideo(ctx({ deadline: Date.now() + MIN_REQUEST_WINDOW_MS - 1 })),
    );

    expect(error?.code).toBe(PUBLISH_BUDGET_EXCEEDED_CODE);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses to refresh an expired token with under 5 s left (no token request)", async () => {
    const fetchMock = stubRoutes({ [TOKEN_URL_FRAGMENT]: async () => tokenOk() });

    const error = await failure(
      googleBusinessProfileClient.publishVideo(
        ctx({ expired: true, deadline: Date.now() + MIN_REQUEST_WINDOW_MS - 1 }),
      ),
    );

    expect(error?.code).toBe(PUBLISH_BUDGET_EXCEEDED_CODE);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("clamps the token refresh, both store-code lookups and the media create to the time left (each <= 12 s)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    const fetchMock = stubRoutes({
      [TOKEN_URL_FRAGMENT]: async () => tokenOk(),
      [ACCOUNTS_URL_FRAGMENT]: async () => accountsList(1),
      [LOCATIONS_URL_FRAGMENT]: async () => matchingLocation(),
      [MEDIA_URL_FRAGMENT]: async () => mediaOk(),
    });
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");

    await expect(
      googleBusinessProfileClient.publishVideo(
        ctx({ expired: true, locationName: "STORE-1", deadline: NOW + 12_000 }),
      ),
    ).resolves.toEqual({ externalPostId: "accounts/111/locations/999/localPosts/p1" });

    expect(fetchMock).toHaveBeenCalledTimes(4);
    const timeouts = setTimeoutSpy.mock.calls.map((c) => c[1] as number);
    // token refresh, accounts list, location lookup, media create
    expect(timeouts).toHaveLength(4);
    for (const timeout of timeouts) {
      expect(timeout).toBeLessThanOrEqual(12_000);
      expect(timeout).toBeGreaterThanOrEqual(MIN_REQUEST_WINDOW_MS);
    }
  });

  it("worst case: slow store-code lookups across many accounts still settle by the step deadline", async () => {
    vi.useFakeTimers();
    const start = Date.now();
    const deadline = start + PUBLISH_STEP_BUDGET_MS;
    const fetchMock = stubRoutes({
      [ACCOUNTS_URL_FRAGMENT]: async () => accountsList(12),
      [LOCATIONS_URL_FRAGMENT]: slow(29_000, noLocations),
      [ANY_MEDIA_URL_FRAGMENT]: async () => mediaOk(),
    });

    let settledAt = 0;
    const promise = failure(
      googleBusinessProfileClient.publishVideo(ctx({ locationName: "STORE-1", deadline })),
    ).then((e) => {
      settledAt = Date.now();
      return e;
    });
    await vi.advanceTimersByTimeAsync(500_000);
    const error = await promise;

    // 12 lookups x 29 s = 348 s unbounded; the 8th was cut off at the deadline.
    expect(error?.code).toBe("FETCH_TIMEOUT");
    expect(fetchMock.mock.calls.filter((c) => String(c[0]).includes(ANY_MEDIA_URL_FRAGMENT))).toHaveLength(0);
    expect(settledAt).toBeLessThanOrEqual(deadline);
    expect(settledAt - start).toBeLessThan(240_000);
  });

  it("worst case: slow lookups and a hung media create still settle by the step deadline", async () => {
    vi.useFakeTimers();
    const start = Date.now();
    const deadline = start + PUBLISH_STEP_BUDGET_MS;
    let lookups = 0;
    const fetchMock = stubRoutes({
      [ACCOUNTS_URL_FRAGMENT]: async () => accountsList(7),
      // The last of 7 accounts holds the store code: 7 x 29 s = 203 s.
      [LOCATIONS_URL_FRAGMENT]: (init) => slow(29_000, ++lookups === 7 ? matchingLocation : noLocations)(init),
      [ANY_MEDIA_URL_FRAGMENT]: hang,
    });

    let settledAt = 0;
    const promise = failure(
      googleBusinessProfileClient.publishVideo(ctx({ locationName: "STORE-1", deadline })),
    ).then((e) => {
      settledAt = Date.now();
      return e;
    });
    await vi.advanceTimersByTimeAsync(500_000);
    const error = await promise;

    // The media create got the 22 s left (not its 30 s default).
    expect(error?.code).toBe("PUBLISH_UNCONFIRMED");
    expect(fetchMock.mock.calls.filter((c) => String(c[0]).includes(ANY_MEDIA_URL_FRAGMENT))).toHaveLength(1);
    expect(settledAt).toBeLessThanOrEqual(deadline);
    expect(settledAt - start).toBeLessThan(240_000);
  });
});

// 2026-11-01 scale audit (jobs, token refresh): every GBP refresh goes through
// refreshConnectionToken (connectionRefresh.ts), which serializes it per
// connection and hands back the stored row when another process refreshed first.
describe("googleBusinessProfileClient — serialized token refresh", () => {
  const MEDIA_URL = "mybusiness.googleapis.com/v4/accounts/111/locations/999/localPosts";

  function expiredContext(deadline?: number): PublishContext {
    const base = makeContext();
    return {
      ...base,
      deadline,
      socialConnection: { ...base.socialConnection, expiresAt: new Date("2020-01-01T00:00:00Z") },
    } as PublishContext;
  }

  beforeEach(() => {
    refreshConnectionTokenMock.mockClear();
    updateMock.mockReset();
    vi.stubEnv("GOOGLE_GBP_CLIENT_ID", "test-client-id");
    vi.stubEnv("GOOGLE_GBP_CLIENT_SECRET", "test-client-secret");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("publishVideo routes an expired token's refresh through refreshConnectionToken with the snapshot and the step deadline", async () => {
    const fetchMock = vi.fn<typeof fetch>((input) => {
      if (String(input).includes(MEDIA_URL)) {
        return Promise.resolve(new Response(JSON.stringify({ name: "accounts/111/locations/999/localPosts/p1" })));
      }
      throw new Error(`Unexpected fetch in test: ${String(input)}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    // Another process refreshed first: the lock hands back its row, no token request is made.
    refreshConnectionTokenMock.mockResolvedValueOnce({
      ...makeContext().socialConnection,
      accessToken: "winner-access-token",
    });
    const deadline = Date.now() + 60_000;
    const ctx = expiredContext(deadline);

    await googleBusinessProfileClient.publishVideo(ctx);

    expect(refreshConnectionTokenMock).toHaveBeenCalledTimes(1);
    expect(refreshConnectionTokenMock.mock.calls[0][0]).toBe(ctx.socialConnection);
    expect(refreshConnectionTokenMock.mock.calls[0][2]).toEqual({ deadline });
    expect(updateMock).not.toHaveBeenCalled();
    const headers = (fetchMock.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer winner-access-token");
  });

  it("publishVideo does not take the lock for a token that is still fresh", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(() =>
        Promise.resolve(new Response(JSON.stringify({ name: "accounts/111/locations/999/localPosts/p1" }))),
      ),
    );

    await googleBusinessProfileClient.publishVideo(makeContext());

    expect(refreshConnectionTokenMock).not.toHaveBeenCalled();
  });

  it("refreshToken (the health sweep's hook) forwards its deadline to the Google refresh", async () => {
    updateMock.mockImplementation((args: { data: Record<string, unknown> }) =>
      Promise.resolve({ ...makeContext().socialConnection, ...args.data }),
    );
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(() =>
        Promise.resolve(
          new Response(JSON.stringify({ access_token: "swept", expires_in: 3600, token_type: "Bearer" })),
        ),
      ),
    );
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");

    await googleBusinessProfileClient.refreshToken!(makeContext().socialConnection, {
      deadline: Date.now() + 8_000,
    });

    const timeouts = setTimeoutSpy.mock.calls.map((c) => c[1] as number);
    expect(timeouts).toHaveLength(1);
    expect(timeouts[0]).toBeLessThanOrEqual(8_000);
    setTimeoutSpy.mockRestore();
  });
});
