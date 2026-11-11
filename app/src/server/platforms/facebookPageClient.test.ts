import type { MediaItem, SocialConnection, User } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PUBLISH_UNCONFIRMED_MESSAGE } from "@/lib/publishOutcomes";
import {
  facebookPageClient,
  isFacebookAuthErrorBody,
} from "@/server/platforms/facebookPageClient";
import type { PublishContext } from "@/server/platforms/types";
import { withTransientRetries } from "@/server/platforms/transientRetry";

// Facebook Page stores a long-lived PAGE token with no refresh path (the user
// token that minted it is never stored), so the behavior to pin is publish-time
// auth-failure mapping: HTTP 401 or an OAuthException code 190 body -> the
// coded reconnect error + needsReconnect flag; any other failure -> the
// sanitized FACEBOOK_PAGE_PUBLISH_FAILED without the raw upstream body.
const { updateMock, findUniqueMock, fetchMock } = vi.hoisted(() => ({
  updateMock: vi.fn(),
  findUniqueMock: vi.fn(),
  fetchMock: vi.fn(),
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

vi.mock("@/lib/fetchWithTimeout", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/fetchWithTimeout")>()),
  fetchWithTimeout: fetchMock,
}));

beforeEach(() => {
  updateMock.mockReset();
  updateMock.mockResolvedValue({});
  // By default the database still holds the tokens makeConnection() builds, so
  // the guarded flag finds them unchanged and writes.
  findUniqueMock.mockReset();
  findUniqueMock.mockResolvedValue({ accessToken: "page-access-token", refreshToken: null });
  fetchMock.mockReset();
  // Silence the client's operational console output in test logs.
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
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
    platform: "facebook_page",
    accessToken: "page-access-token",
    refreshToken: null,
    expiresAt: new Date("2020-01-01T00:00:00Z"),
    accountIdentifier: "page-1",
    scopes: null,
    metadata: { pageName: "Acme" },
    needsReconnect: false,
    lastRefreshErrorCode: null,
    refreshFailedAt: null,
    createdAt: new Date("2020-01-01T00:00:00Z"),
    updatedAt: new Date("2020-01-01T00:00:00Z"),
    ...overrides,
  } as SocialConnection;
}

function makeContext(
  connectionOverrides: Partial<SocialConnection> = {},
  mediaOverrides: Partial<MediaItem> = {},
): PublishContext {
  return {
    user: { id: "user-1" } as User,
    socialConnection: makeConnection(connectionOverrides),
    get mediaItems() { return [this.mediaItem]; },
    mediaItem: {
      id: "media-1",
      mimeType: "image/jpeg",
      storageLocation: "https://blob.example.com/photo.jpg",
      ...mediaOverrides,
    } as MediaItem,
    caption: "hello",
  };
}

function response(status: number, body: unknown): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
  });
}

describe("isFacebookAuthErrorBody", () => {
  it("is true for an OAuthException with code 190", () => {
    expect(
      isFacebookAuthErrorBody(
        JSON.stringify({
          error: { type: "OAuthException", code: 190, message: "expired" },
        }),
      ),
    ).toBe(true);
  });

  it("is false for a non-auth Graph error (e.g. code 100 parameter error)", () => {
    expect(
      isFacebookAuthErrorBody(
        JSON.stringify({ error: { type: "GraphMethodException", code: 100 } }),
      ),
    ).toBe(false);
  });

  it("is false for OAuthException codes other than 190 (e.g. 4 rate limit)", () => {
    expect(
      isFacebookAuthErrorBody(
        JSON.stringify({ error: { type: "OAuthException", code: 4 } }),
      ),
    ).toBe(false);
  });

  it("is false for a non-JSON body", () => {
    expect(isFacebookAuthErrorBody("<html>Bad Gateway</html>")).toBe(false);
  });
});

describe("facebookPageClient.publishVideo", () => {
  it("publishes a photo and returns the external post id", async () => {
    fetchMock.mockResolvedValue(response(200, { id: "post-123" }));

    const result = await facebookPageClient.publishVideo(makeContext());

    expect(result.externalPostId).toBe("post-123");
    expect(updateMock).not.toHaveBeenCalled();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/page-1/photos");
    expect(String(init.body)).toContain("page-access-token");
  });

  it("maps HTTP 401 to FACEBOOK_PAGE_RECONNECT_REQUIRED and marks needsReconnect (flag fields only, no tokens)", async () => {
    fetchMock.mockResolvedValue(
      response(401, { error: { type: "OAuthException", code: 190 } }),
    );

    const error = await facebookPageClient
      .publishVideo(makeContext({ id: "conn-99" }))
      .then(() => null)
      .catch((e: unknown) => e as Error & { code?: string });

    expect(error?.code).toBe("FACEBOOK_PAGE_RECONNECT_REQUIRED");
    expect(error?.message).toContain("reconnect");

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
    expect(arg.data.lastRefreshErrorCode).toBe(
      "FACEBOOK_PAGE_RECONNECT_REQUIRED",
    );
    expect(arg.data).not.toHaveProperty("accessToken");
    expect(arg.data).not.toHaveProperty("refreshToken");
  });

  it("maps an HTTP 400 OAuthException code 190 body to the reconnect error too (Facebook often uses 400 for dead tokens)", async () => {
    fetchMock.mockResolvedValue(
      response(400, {
        error: { type: "OAuthException", code: 190, message: "Error validating access token" },
      }),
    );

    const error = await facebookPageClient
      .publishVideo(makeContext())
      .then(() => null)
      .catch((e: unknown) => e as Error & { code?: string });

    expect(error?.code).toBe("FACEBOOK_PAGE_RECONNECT_REQUIRED");
    expect(updateMock).toHaveBeenCalledTimes(1);
  });

  // 2026-11-02 scale audit (jobs, token refresh): the flag is guarded by the
  // tokens the rejected /photos call sent. When another process changed them (the
  // user reconnected), nothing is flagged and the call fails with the plain,
  // retryable CONNECTION_TOKEN_CHANGED.
  it.each([
    ["HTTP 401", () => response(401, { error: { type: "OAuthException", code: 190 } })],
    [
      "an HTTP 400 OAuthException 190",
      () => response(400, { error: { type: "OAuthException", code: 190, message: "expired" } }),
    ],
  ] as const)("%s with changed stored tokens throws CONNECTION_TOKEN_CHANGED and flags nothing", async (_name, make) => {
    findUniqueMock.mockResolvedValue({ accessToken: "rotated-page-token", refreshToken: null });
    fetchMock.mockResolvedValue(make());

    const error = await facebookPageClient
      .publishVideo(makeContext({ id: "conn-99" }))
      .then(() => null)
      .catch((e: unknown) => e as Error & { code?: string });

    expect(error?.code).toBe("CONNECTION_TOKEN_CHANGED");
    expect(error?.message).toBe(
      "This connection was refreshed or reconnected while publishing. Please retry.",
    );
    expect(findUniqueMock).toHaveBeenCalledWith({
      where: { id: "conn-99" },
      select: { accessToken: true, refreshToken: true },
    });
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("keeps non-auth failures as sanitized FACEBOOK_PAGE_PUBLISH_FAILED without the raw body, and does NOT mark needsReconnect", async () => {
    fetchMock.mockResolvedValue(
      response(400, {
        error: { type: "GraphMethodException", code: 100, message: "Invalid parameter SECRET-DETAIL" },
      }),
    );

    const error = await facebookPageClient
      .publishVideo(makeContext())
      .then(() => null)
      .catch((e: unknown) => e as Error & { code?: string });

    expect(error?.code).toBe("FACEBOOK_PAGE_PUBLISH_FAILED");
    expect(error?.message).toBe(
      "Facebook Page photo publish failed (status 400)",
    );
    expect(error?.message).not.toContain("SECRET-DETAIL");
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("throws FACEBOOK_PAGE_NO_ACCESS_TOKEN without any network call when the token is missing", async () => {
    const error = await facebookPageClient
      .publishVideo(makeContext({ accessToken: "" }))
      .then(() => null)
      .catch((e: unknown) => e as Error & { code?: string });

    expect(error?.code).toBe("FACEBOOK_PAGE_NO_ACCESS_TOKEN");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects media that is neither an image nor a video with FACEBOOK_PAGE_UNSUPPORTED_MEDIA_TYPE before any network call", async () => {
    const error = await facebookPageClient
      .publishVideo(makeContext({}, { mimeType: "application/pdf" }))
      .then(() => null)
      .catch((e: unknown) => e as Error & { code?: string });

    expect(error?.code).toBe("FACEBOOK_PAGE_UNSUPPORTED_MEDIA_TYPE");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// 2026-11-08: Facebook Page videos. POST /{page}/videos on graph-video.facebook.com with
// file_url (Meta fetches the file, as Instagram does for Reels) and the caption as
// `description` (https://developers.facebook.com/docs/graph-api/reference/page/videos/).
describe("facebookPageClient.publishVideo — videos (POST /{page}/videos)", () => {
  const videoContext = (deadline?: number) => ({
    ...makeContext({}, { mimeType: "video/mp4", storageLocation: "https://blob.example.com/reel.mp4" }),
    caption: "Small feet, big dreams",
    deadline,
  });
  type CodedError = Error & { code?: string };

  it("posts the video by URL to the Page's videos edge and returns the video id", async () => {
    fetchMock.mockResolvedValue(response(200, { id: "video-777" }));

    const result = await facebookPageClient.publishVideo(videoContext());

    expect(result.externalPostId).toBe("video-777");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit, number];
    expect(new URL(url).host).toBe("graph-video.facebook.com");
    expect(new URL(url).pathname).toMatch(/\/page-1\/videos$/);
    const body = new URLSearchParams(String(init.body));
    expect(body.get("file_url")).toBe("https://blob.example.com/reel.mp4");
    expect(body.get("description")).toBe("Small feet, big dreams");
    expect(body.get("access_token")).toBe("page-access-token");
    expect(body.has("url")).toBe(false); // the photos parameter
  });

  it("gives Facebook up to 2 minutes to fetch the file, but never past the step deadline", async () => {
    // A fresh Response per call: a body can be read only once.
    fetchMock.mockImplementation(async () => response(200, { id: "video-777" }));

    await facebookPageClient.publishVideo(videoContext());
    expect(fetchMock.mock.calls[0][2]).toBe(120_000);

    fetchMock.mockClear();
    await facebookPageClient.publishVideo(videoContext(Date.now() + 40_000));
    const timeout = fetchMock.mock.calls[0][2] as number;
    expect(timeout).toBeLessThanOrEqual(40_000);
    expect(timeout).toBeGreaterThan(35_000);
  });

  it("does not start the upload when the step budget is spent", async () => {
    const error = await facebookPageClient.publishVideo(videoContext(Date.now() + 1_000)).then(
      () => null,
      (e: unknown) => e as CodedError,
    );

    expect(error?.code).toBe("PUBLISH_TIME_BUDGET_EXCEEDED");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("maps a dead token to the reconnect error, like photos", async () => {
    fetchMock.mockResolvedValue(response(400, { error: { type: "OAuthException", code: 190, message: "expired" } }));

    const error = await facebookPageClient.publishVideo(videoContext()).then(
      () => null,
      (e: unknown) => e as CodedError,
    );

    expect(error?.code).toBe("FACEBOOK_PAGE_RECONNECT_REQUIRED");
    expect(updateMock).toHaveBeenCalledTimes(1);
  });

  it("keeps other failures as FACEBOOK_PAGE_PUBLISH_FAILED naming the video, without the raw body", async () => {
    fetchMock.mockResolvedValue(response(400, { error: { code: 100, message: "secret upstream detail" } }));

    const error = await facebookPageClient.publishVideo(videoContext()).then(
      () => null,
      (e: unknown) => e as CodedError,
    );

    expect(error?.code).toBe("FACEBOOK_PAGE_PUBLISH_FAILED");
    expect(error?.message).toBe("Facebook Page video publish failed (status 400)");
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("a timeout after the request was sent is PUBLISH_UNCONFIRMED (the video may be live), requested once", async () => {
    fetchMock.mockRejectedValue(Object.assign(new Error("Request timed out"), { code: "FETCH_TIMEOUT" }));

    const error = await facebookPageClient.publishVideo(videoContext()).then(
      () => null,
      (e: unknown) => e as CodedError,
    );

    expect(error?.code).toBe("PUBLISH_UNCONFIRMED");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("facebookPageClient.refreshToken", () => {
  it("returns the connection unchanged without touching the database (page tokens have no refresh path)", async () => {
    const connection = makeConnection();

    const result = await facebookPageClient.refreshToken!(connection);

    expect(result).toBe(connection);
    expect(updateMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// 2026-11-01 scale audit (platform limits, V11): Meta throttles Page calls with
// a body `error.code` and reports the wait in `X-Business-Use-Case-Usage`
// (`estimated_time_to_regain_access`, in minutes).
describe("facebookPageClient.publishVideo — rate limits (RATE_LIMITED)", () => {
  type LimitedError = Error & { code?: string; kind?: string; retryAt?: number | null; platform?: string };

  afterEach(() => {
    vi.useRealTimers();
  });

  it("photos 400 code 32 with a 3 minute business-use-case header -> retryAt = now + 180 s", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-01T12:00:00Z"));
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: { type: "OAuthException", code: 32, message: "m" } }), {
        status: 400,
        headers: {
          "X-Business-Use-Case-Usage": JSON.stringify({
            "page-1": [{ type: "pages", estimated_time_to_regain_access: 3 }],
          }),
        },
      }),
    );

    const error = await facebookPageClient.publishVideo(makeContext()).then(
      () => null,
      (e: unknown) => e as LimitedError,
    );

    expect(error).toMatchObject({
      code: "RATE_LIMITED",
      platform: "facebook_page",
      kind: "rate_limited",
      retryAt: Date.parse("2026-11-01T12:00:00Z") + 180_000,
    });
    expect(error?.message).toBe("Facebook Page is limiting requests right now.");
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("an HTTP 429 with Retry-After is rate limited too", async () => {
    fetchMock.mockResolvedValue(new Response("", { status: 429, headers: { "Retry-After": "60" } }));

    const error = await facebookPageClient.publishVideo(makeContext()).then(
      () => null,
      (e: unknown) => e as LimitedError,
    );

    expect(error?.code).toBe("RATE_LIMITED");
    expect(error?.retryAt).toBeGreaterThan(Date.now());
  });

  it("a non-throttle Graph error keeps FACEBOOK_PAGE_PUBLISH_FAILED", async () => {
    fetchMock.mockResolvedValue(response(400, { error: { type: "GraphMethodException", code: 100 } }));

    const error = await facebookPageClient.publishVideo(makeContext()).then(
      () => null,
      (e: unknown) => e as LimitedError,
    );

    expect(error?.code).toBe("FACEBOOK_PAGE_PUBLISH_FAILED");
  });
});

// 07b: several photos in one post. Each photo goes to /{page}/photos with
// published=false, then one /{page}/feed post names them in attached_media, in
// order (https://developers.facebook.com/docs/graph-api/reference/page/photos/,
// "Publishing Multiple Photos"). The feed post is the commit call.
describe("facebookPageClient.publishVideo — several photos (photos published=false + feed)", () => {
  type CodedError = Error & { code?: string; status?: number };

  function multiContext(
    mimeTypes: string[],
    extra: Partial<PublishContext> = {},
  ): PublishContext {
    const items = mimeTypes.map(
      (mimeType, i) =>
        ({
          id: `media-${i + 1}`,
          mimeType,
          storageLocation: `https://blob.example.com/photo-${i + 1}.jpg`,
          baseCaption: "",
          perPlatformOverrides: null,
        }) as MediaItem,
    );
    return {
      user: { id: "user-1" } as User,
      socialConnection: makeConnection(),
      mediaItem: { ...items[0], baseCaption: "Surf day" } as MediaItem,
      mediaItems: items,
      caption: "Surf day #waves",
      ...extra,
    };
  }

  const photos = (n: number) => Array.from({ length: n }, () => "image/jpeg");

  /** Uploads answer photo-1..photo-n, then the feed answers the post id. */
  function answerUploadsThenFeed(n: number, feed: () => Response = () => response(200, { id: "page-1_post-9" })) {
    for (let i = 1; i <= n; i++) {
      fetchMock.mockImplementationOnce(async () => response(200, { id: `photo-${i}` }));
    }
    fetchMock.mockImplementationOnce(async () => feed());
  }

  function call(i: number) {
    const [url, init, timeout] = fetchMock.mock.calls[i] as [string, RequestInit, number | undefined];
    return { url: new URL(url), body: new URLSearchParams(String(init.body)), init, timeout };
  }

  const failure = (ctx: PublishContext) =>
    facebookPageClient.publishVideo(ctx).then(
      () => null,
      (e: unknown) => e as CodedError,
    );

  it("two photos: uploads each unpublished, then one feed post with the caption and both photos in order", async () => {
    answerUploadsThenFeed(2);

    const result = await facebookPageClient.publishVideo(multiContext(photos(2)));

    expect(result).toEqual({ externalPostId: "page-1_post-9" });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    for (const i of [0, 1]) {
      const { url, body, init } = call(i);
      expect(init.method).toBe("POST");
      expect(url.host).toBe("graph.facebook.com");
      expect(url.pathname).toMatch(/\/page-1\/photos$/);
      expect([...body.keys()].sort()).toEqual(["access_token", "published", "url"]);
      expect(body.get("url")).toBe(`https://blob.example.com/photo-${i + 1}.jpg`);
      expect(body.get("published")).toBe("false");
      expect(body.get("access_token")).toBe("page-access-token");
    }
    const feed = call(2);
    expect(feed.init.method).toBe("POST");
    expect(feed.url.host).toBe("graph.facebook.com");
    expect(feed.url.pathname).toMatch(/\/page-1\/feed$/);
    expect([...feed.body.keys()]).toEqual([
      "message",
      "attached_media[0]",
      "attached_media[1]",
      "access_token",
    ]);
    expect(feed.body.get("message")).toBe("Surf day #waves");
    expect(feed.body.get("attached_media[0]")).toBe('{"media_fbid":"photo-1"}');
    expect(feed.body.get("attached_media[1]")).toBe('{"media_fbid":"photo-2"}');
    expect(feed.body.get("access_token")).toBe("page-access-token");
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("ten photos: ten uploads in order, then one feed post naming all ten in order", async () => {
    answerUploadsThenFeed(10);

    const result = await facebookPageClient.publishVideo(multiContext(photos(10)));

    expect(result.externalPostId).toBe("page-1_post-9");
    expect(fetchMock).toHaveBeenCalledTimes(11);
    for (let i = 0; i < 10; i++) {
      expect(call(i).url.pathname).toMatch(/\/page-1\/photos$/);
      expect(call(i).body.get("url")).toBe(`https://blob.example.com/photo-${i + 1}.jpg`);
    }
    const feed = call(10);
    expect(feed.url.pathname).toMatch(/\/page-1\/feed$/);
    for (let i = 0; i < 10; i++) {
      expect(feed.body.get(`attached_media[${i}]`)).toBe(`{"media_fbid":"photo-${i + 1}"}`);
    }
    expect(feed.body.has("attached_media[10]")).toBe(false);
  });

  it("waits on each upload and on the feed post no longer than the single-photo path (30 s)", async () => {
    answerUploadsThenFeed(3);

    await facebookPageClient.publishVideo(multiContext(photos(3)));

    for (let i = 0; i < 4; i++) expect(call(i).timeout).toBe(30_000);
  });

  it("clamps each request to the step deadline", async () => {
    answerUploadsThenFeed(2);

    await facebookPageClient.publishVideo(multiContext(photos(2), { deadline: Date.now() + 20_000 }));

    for (let i = 0; i < 3; i++) {
      expect(call(i).timeout).toBeLessThanOrEqual(20_000);
      expect(call(i).timeout).toBeGreaterThan(15_000);
    }
  });

  it("sends nothing when the step budget is already spent", async () => {
    const error = await failure(multiContext(photos(2), { deadline: Date.now() + 1_000 }));

    expect(error?.code).toBe("PUBLISH_TIME_BUDGET_EXCEEDED");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a failed upload of the second photo makes no post and fails with one clear message", async () => {
    fetchMock.mockImplementationOnce(async () => response(200, { id: "photo-1" }));
    fetchMock.mockImplementationOnce(async () =>
      response(400, { error: { type: "GraphMethodException", code: 100, message: "SECRET-DETAIL" } }),
    );

    const error = await failure(multiContext(photos(3)));

    expect(error?.code).toBe("FACEBOOK_PAGE_PUBLISH_FAILED");
    expect(error?.message).toBe("Facebook Page could not upload photo 2 of 3 (status 400). No post was made.");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/feed"))).toBe(false);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("an upload 5xx is not unconfirmed (nothing is posted yet) and carries its status so the publish may be retried", async () => {
    fetchMock.mockImplementationOnce(async () => response(200, { id: "photo-1" }));
    fetchMock.mockImplementationOnce(async () => response(503, "<html>Service Unavailable</html>"));

    const error = await failure(multiContext(photos(2)));

    expect(error?.code).toBe("FACEBOOK_PAGE_PUBLISH_FAILED");
    expect(error?.status).toBe(503);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("an upload answered 2xx without a photo id makes no post", async () => {
    fetchMock.mockImplementationOnce(async () => response(200, { id: "photo-1" }));
    fetchMock.mockImplementationOnce(async () => response(200, {}));

    const error = await failure(multiContext(photos(2)));

    expect(error?.code).toBe("FACEBOOK_PAGE_PUBLISH_FAILED");
    expect(error?.message).toBe("Facebook Page could not upload photo 2 of 2. No post was made.");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("a dead token on an upload is the reconnect error and flags the connection", async () => {
    fetchMock.mockImplementationOnce(async () =>
      response(400, { error: { type: "OAuthException", code: 190, message: "expired" } }),
    );

    const error = await failure(multiContext(photos(2)));

    expect(error?.code).toBe("FACEBOOK_PAGE_RECONNECT_REQUIRED");
    expect(updateMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("a throttled upload is RATE_LIMITED", async () => {
    fetchMock.mockImplementationOnce(async () => new Response("", { status: 429, headers: { "Retry-After": "60" } }));

    const error = await failure(multiContext(photos(2)));

    expect(error?.code).toBe("RATE_LIMITED");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["a timeout", () => Promise.reject(Object.assign(new Error("Request timed out"), { code: "FETCH_TIMEOUT" }))],
    ["a 503", async () => response(503, "<html>Service Unavailable</html>")],
    ["a 2xx without an id", async () => response(200, {})],
    ["a 2xx with an unreadable body", async () => new Response("<html>ok</html>", { status: 200 })],
  ] as const)("the feed post answering %s is PUBLISH_UNCONFIRMED and is not sent again", async (_name, feed) => {
    fetchMock.mockImplementationOnce(async () => response(200, { id: "photo-1" }));
    fetchMock.mockImplementationOnce(async () => response(200, { id: "photo-2" }));
    fetchMock.mockImplementationOnce(feed);

    const error = await failure(multiContext(photos(2)));

    expect(error?.code).toBe("PUBLISH_UNCONFIRMED");
    expect(error?.message).toBe(PUBLISH_UNCONFIRMED_MESSAGE);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes("/feed"))).toHaveLength(1);
  });

  it("a feed post refused with a 4xx fails without the raw body", async () => {
    answerUploadsThenFeed(2, () =>
      response(400, { error: { type: "GraphMethodException", code: 100, message: "SECRET-DETAIL" } }),
    );

    const error = await failure(multiContext(photos(2)));

    expect(error?.code).toBe("FACEBOOK_PAGE_PUBLISH_FAILED");
    expect(error?.message).toBe("Facebook Page photos publish failed (status 400)");
    expect(error?.message).not.toContain("SECRET-DETAIL");
  });

  it.each([
    ["a video", "video/mp4"],
    ["a GIF", "image/gif"],
    ["a PDF", "application/pdf"],
  ])("%s among several photos sends no request", async (_name, mimeType) => {
    const error = await failure(multiContext(["image/jpeg", mimeType, "image/png"]));

    expect(error?.code).toBe("FACEBOOK_PAGE_UNSUPPORTED_MEDIA_TYPE");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("accepts JPEG, PNG and WebP together", async () => {
    answerUploadsThenFeed(3);

    await expect(
      facebookPageClient.publishVideo(multiContext(["image/jpeg", "image/png", "image/webp"])),
    ).resolves.toEqual({ externalPostId: "page-1_post-9" });
  });

  it("more than 10 photos sends no request", async () => {
    const error = await failure(multiContext(photos(11)));

    expect(error?.code).toBe("FACEBOOK_PAGE_TOO_MANY_PHOTOS");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// 2026-11-01 scale audit (jobs H6, Review Focus 5): `POST /{page}/photos` is the
// commit call. A 5xx, a timeout or a dropped connection there may already have
// posted the photo, so it is PUBLISH_UNCONFIRMED and is never re-run.
describe("facebookPageClient.publishVideo — commit call (POST /{page}/photos)", () => {
  type CodedError = Error & { code?: string };
  const failure = () =>
    facebookPageClient.publishVideo(makeContext()).then(
      () => null,
      (e: unknown) => e as CodedError,
    );

  it("photos timeout (FETCH_TIMEOUT) -> PUBLISH_UNCONFIRMED, requested once", async () => {
    const timeout = Object.assign(new Error("Request timed out after 30000ms"), { code: "FETCH_TIMEOUT" });
    fetchMock.mockRejectedValue(timeout);

    const error = await failure();

    expect(error?.code).toBe("PUBLISH_UNCONFIRMED");
    expect(error?.message).toBe(PUBLISH_UNCONFIRMED_MESSAGE);
    expect((error as { cause?: unknown }).cause).toBe(timeout);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("photos 503 -> PUBLISH_UNCONFIRMED, without flagging the connection", async () => {
    fetchMock.mockResolvedValue(response(503, "<html>Service Unavailable</html>"));

    const error = await failure();

    expect(error?.code).toBe("PUBLISH_UNCONFIRMED");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("a connection dropped after the request was sent -> PUBLISH_UNCONFIRMED", async () => {
    fetchMock.mockRejectedValue(new TypeError("fetch failed", { cause: { code: "ECONNRESET" } }));

    expect((await failure())?.code).toBe("PUBLISH_UNCONFIRMED");
  });

  it("a connection that was never made is rethrown unchanged (provably not sent)", async () => {
    const neverConnected = new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } });
    fetchMock.mockRejectedValue(neverConnected);

    expect(await failure()).toBe(neverConnected);
  });

  // Final review F4 (I2): a 2xx photos response means the photo may be live, so a
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
  ] as const)("a 2xx photos response with %s -> PUBLISH_UNCONFIRMED, requested once", async (_name, make) => {
    fetchMock.mockResolvedValue(make());

    const error = await failure();

    expect(error?.code).toBe("PUBLISH_UNCONFIRMED");
    expect(error?.message).toBe(PUBLISH_UNCONFIRMED_MESSAGE);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(updateMock).not.toHaveBeenCalled();
  });

  // 2026-11-02 scale audit (jobs): photos answered 2xx ("created") but the
  // parsed body has no post id: PUBLISH_UNCONFIRMED, not a success with a null
  // externalPostId. `id` wins; `post_id` is read only when `id` is absent.
  it.each([
    ["{}", {}],
    ["an empty id and no post_id", { id: "" }],
    ["a numeric id", { id: 12 }],
    ["a JSON null body", null],
  ] as const)("a 2xx photos response with %s -> PUBLISH_UNCONFIRMED, requested once", async (_name, body) => {
    fetchMock.mockResolvedValue(response(200, JSON.stringify(body)));

    const error = await failure();

    expect(error?.code).toBe("PUBLISH_UNCONFIRMED");
    expect(error?.message).toBe(PUBLISH_UNCONFIRMED_MESSAGE);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("a 2xx photos response with only post_id succeeds with it as externalPostId", async () => {
    fetchMock.mockResolvedValue(response(200, { post_id: "p1" }));

    await expect(facebookPageClient.publishVideo(makeContext())).resolves.toEqual({
      externalPostId: "p1",
    });
  });

  it("prefers id over post_id", async () => {
    fetchMock.mockResolvedValue(response(200, { id: "photo-1", post_id: "p1" }));

    await expect(facebookPageClient.publishVideo(makeContext())).resolves.toEqual({
      externalPostId: "photo-1",
    });
  });

  it("a 4xx keeps FACEBOOK_PAGE_PUBLISH_FAILED, and a 401 keeps the reconnect error", async () => {
    fetchMock.mockResolvedValue(response(400, { error: { type: "GraphMethodException", code: 100 } }));
    expect((await failure())?.code).toBe("FACEBOOK_PAGE_PUBLISH_FAILED");

    fetchMock.mockResolvedValue(response(401, { error: { type: "OAuthException", code: 190 } }));
    expect((await failure())?.code).toBe("FACEBOOK_PAGE_RECONNECT_REQUIRED");
    expect(updateMock).toHaveBeenCalledTimes(1);
  });
});

// 2026-11-10: a Page Story (https://developers.facebook.com/docs/page-stories-api).
// Photo: upload unpublished, then /photo_stories (the commit call). Video:
// /video_stories start, the hosted file to the answered rupload address, then
// /video_stories finish (the commit call).
describe("facebookPageClient.publishVideo — Story", () => {
  type CodedError = Error & { code?: string; status?: number };
  const STORY = { placement: "story" } as const;

  const photoStory = (extra: Partial<PublishContext> = {}): PublishContext => ({
    ...makeContext(),
    caption: "Two spots left today",
    facebookMetadata: STORY,
    ...extra,
  });
  const videoStory = (extra: Partial<PublishContext> = {}): PublishContext => ({
    ...makeContext({}, { mimeType: "video/mp4", storageLocation: "https://blob.example.com/reel.mp4" }),
    caption: "Two spots left today",
    facebookMetadata: STORY,
    ...extra,
  });

  function call(i: number) {
    const [url, init, timeout] = fetchMock.mock.calls[i] as [string, RequestInit, number | undefined];
    return {
      url: new URL(url),
      body: new URLSearchParams(String(init.body ?? "")),
      headers: new Headers(init.headers),
      init,
      timeout,
    };
  }

  const failure = (ctx: PublishContext) =>
    facebookPageClient.publishVideo(ctx).then(
      () => null,
      (e: unknown) => e as CodedError,
    );

  const UPLOAD_URL = "https://rupload.facebook.com/video-upload/v26.0/video-5";
  const answerVideo = (finish: () => Response = () => response(200, { success: true, post_id: "story-5" })) => {
    fetchMock.mockImplementationOnce(async () => response(200, { video_id: "video-5", upload_url: UPLOAD_URL }));
    fetchMock.mockImplementationOnce(async () => response(200, { success: true }));
    fetchMock.mockImplementationOnce(async () => finish());
  };

  it("photo Story: uploads the photo unpublished, then one photo_stories call naming it; no caption", async () => {
    fetchMock.mockImplementationOnce(async () => response(200, { id: "photo-1" }));
    fetchMock.mockImplementationOnce(async () => response(200, { success: true, post_id: "story-1" }));

    const result = await facebookPageClient.publishVideo(photoStory());

    expect(result).toEqual({ externalPostId: "story-1" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const upload = call(0);
    expect(upload.url.pathname).toMatch(/\/page-1\/photos$/);
    expect(Object.fromEntries(upload.body)).toEqual({
      url: "https://blob.example.com/photo.jpg",
      published: "false",
      access_token: "page-access-token",
    });
    const story = call(1);
    expect(story.init.method).toBe("POST");
    expect(story.url.host).toBe("graph.facebook.com");
    expect(story.url.pathname).toMatch(/\/page-1\/photo_stories$/);
    expect(Object.fromEntries(story.body)).toEqual({ photo_id: "photo-1", access_token: "page-access-token" });
  });

  it("accepts the numeric post_id the page's example shows", async () => {
    fetchMock.mockImplementationOnce(async () => response(200, { id: "photo-1" }));
    fetchMock.mockImplementationOnce(async () => response(200, { success: true, post_id: 1234 }));

    expect(await facebookPageClient.publishVideo(photoStory())).toEqual({ externalPostId: "1234" });
  });

  it("a failed photo upload publishes nothing", async () => {
    fetchMock.mockImplementationOnce(async () => response(400, { error: { code: 100, message: "bad" } }));

    const error = await failure(photoStory());

    expect(error?.code).toBe("FACEBOOK_PAGE_PUBLISH_FAILED");
    expect(error?.message).toContain("No Story was made");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("an upload 5xx carries its status (nothing is visible yet, so it may be retried)", async () => {
    fetchMock.mockImplementationOnce(async () => response(503, "busy"));

    const error = await failure(photoStory());

    expect(error?.code).toBe("FACEBOOK_PAGE_PUBLISH_FAILED");
    expect(error?.status).toBe(503);
  });

  it("a lost answer on photo_stories is PUBLISH_UNCONFIRMED and photo_stories is never sent again", async () => {
    fetchMock.mockImplementationOnce(async () => response(200, { id: "photo-1" }));
    fetchMock.mockImplementationOnce(async () => {
      throw Object.assign(new Error("Request timed out"), { code: "FETCH_TIMEOUT" });
    });
    fetchMock.mockImplementation(async () => response(200, { id: "photo-again" }));

    await expect(
      withTransientRetries(() => facebookPageClient.publishVideo(photoStory()), { sleep: async () => {} }),
    ).rejects.toMatchObject({ code: "PUBLISH_UNCONFIRMED", message: PUBLISH_UNCONFIRMED_MESSAGE });
    const storyCalls = fetchMock.mock.calls.filter((c) => String(c[0]).includes("/photo_stories"));
    expect(storyCalls).toHaveLength(1);
  });

  it("photo_stories answering 2xx without post_id is PUBLISH_UNCONFIRMED", async () => {
    fetchMock.mockImplementationOnce(async () => response(200, { id: "photo-1" }));
    fetchMock.mockImplementationOnce(async () => response(200, { success: true }));

    expect((await failure(photoStory()))?.code).toBe("PUBLISH_UNCONFIRMED");
  });

  it("video Story: start, the hosted file to the answered address, then finish; no caption", async () => {
    answerVideo();

    const result = await facebookPageClient.publishVideo(videoStory());

    expect(result).toEqual({ externalPostId: "story-5" });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const start = call(0);
    expect(start.url.host).toBe("graph.facebook.com");
    expect(start.url.pathname).toMatch(/\/page-1\/video_stories$/);
    expect(Object.fromEntries(start.body)).toEqual({ upload_phase: "start", access_token: "page-access-token" });

    const transfer = call(1);
    expect(transfer.url.toString()).toBe(UPLOAD_URL);
    expect(transfer.init.method).toBe("POST");
    expect(transfer.headers.get("file_url")).toBe("https://blob.example.com/reel.mp4");
    expect(transfer.headers.get("authorization")).toBe("OAuth page-access-token");

    const finish = call(2);
    expect(finish.url.pathname).toMatch(/\/page-1\/video_stories$/);
    expect(Object.fromEntries(finish.body)).toEqual({
      video_id: "video-5",
      upload_phase: "finish",
      access_token: "page-access-token",
    });
    for (const i of [0, 1, 2]) expect(call(i).body.has("description")).toBe(false);
  });

  it("gives the file transfer up to 2 minutes, but never past the step deadline", async () => {
    answerVideo();
    await facebookPageClient.publishVideo(videoStory());
    expect(call(1).timeout).toBe(120_000);

    fetchMock.mockReset();
    answerVideo();
    await facebookPageClient.publishVideo(videoStory({ deadline: Date.now() + 40_000 }));
    expect(call(1).timeout).toBeLessThanOrEqual(40_000);
    expect(call(1).timeout).toBeGreaterThan(35_000);
  });

  it("refuses an upload address that is not rupload.facebook.com, before sending the token there", async () => {
    fetchMock.mockImplementationOnce(async () =>
      response(200, { video_id: "video-5", upload_url: "https://evil.example.com/up" }),
    );

    const error = await failure(videoStory());

    expect(error?.code).toBe("FACEBOOK_PAGE_PUBLISH_FAILED");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("a failed start or transfer publishes nothing (no finish)", async () => {
    fetchMock.mockImplementationOnce(async () => response(400, { error: { code: 100 } }));
    expect((await failure(videoStory()))?.code).toBe("FACEBOOK_PAGE_PUBLISH_FAILED");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fetchMock.mockReset();
    fetchMock.mockImplementationOnce(async () => response(200, { video_id: "video-5", upload_url: UPLOAD_URL }));
    fetchMock.mockImplementationOnce(async () => response(400, { error: { code: 100 } }));
    expect((await failure(videoStory()))?.code).toBe("FACEBOOK_PAGE_PUBLISH_FAILED");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  // Fix round 1: a 200 that carries a Graph error is a failed transfer.
  it("a transfer answered 200 with an error body fails before finish, keeping the error text out of the logs", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    fetchMock.mockImplementationOnce(async () => response(200, { video_id: "video-5", upload_url: UPLOAD_URL }));
    fetchMock.mockImplementationOnce(async () =>
      response(200, { error: { code: 1, type: "OAuthException", message: "bad token EAAB-secret-token" } }),
    );

    const error = await failure(videoStory());

    expect(error?.code).toBe("FACEBOOK_PAGE_PUBLISH_FAILED");
    expect(error?.message).toContain("No Story was made");
    expect(error?.message).not.toContain("EAAB");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain("EAAB-secret-token");
  });

  it("a transfer answered 200 with a body that is not JSON still goes on to finish", async () => {
    fetchMock.mockImplementationOnce(async () => response(200, { video_id: "video-5", upload_url: UPLOAD_URL }));
    fetchMock.mockImplementationOnce(async () => response(200, "ok"));
    fetchMock.mockImplementationOnce(async () => response(200, { success: true, post_id: "story-5" }));

    expect(await facebookPageClient.publishVideo(videoStory())).toEqual({ externalPostId: "story-5" });
  });

  it("a lost answer on finish is PUBLISH_UNCONFIRMED and finish is never sent again", async () => {
    answerVideo(() => response(502, "bad gateway"));
    fetchMock.mockImplementation(async () => response(200, { video_id: "video-6", upload_url: UPLOAD_URL }));

    await expect(
      withTransientRetries(() => facebookPageClient.publishVideo(videoStory()), { sleep: async () => {} }),
    ).rejects.toMatchObject({ code: "PUBLISH_UNCONFIRMED" });
    const finishes = fetchMock.mock.calls.filter((c) =>
      String((c[1] as RequestInit).body ?? "").includes("upload_phase=finish"),
    );
    expect(finishes).toHaveLength(1);
  });

  it("a dead token on the Story call is the reconnect error", async () => {
    fetchMock.mockImplementationOnce(async () => response(200, { id: "photo-1" }));
    fetchMock.mockImplementationOnce(async () =>
      response(400, { error: { type: "OAuthException", code: 190, message: "expired" } }),
    );

    expect((await failure(photoStory()))?.code).toBe("FACEBOOK_PAGE_RECONNECT_REQUIRED");
  });

  it.each([undefined, { placement: "feed" as const }])(
    "feed (%o): a photo and a video send exactly today's single request",
    async (facebookMetadata) => {
      fetchMock.mockImplementation(async () => response(200, { id: "post-1" }));

      await facebookPageClient.publishVideo({ ...makeContext(), facebookMetadata });
      await facebookPageClient.publishVideo({
        ...makeContext({}, { mimeType: "video/mp4", storageLocation: "https://blob.example.com/reel.mp4" }),
        facebookMetadata,
      });

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(call(0).url.pathname).toMatch(/\/page-1\/photos$/);
      expect(Object.fromEntries(call(0).body)).toEqual({
        url: "https://blob.example.com/photo.jpg",
        caption: "hello",
        access_token: "page-access-token",
      });
      expect(call(1).url.host).toBe("graph-video.facebook.com");
      expect(Object.fromEntries(call(1).body)).toEqual({
        file_url: "https://blob.example.com/reel.mp4",
        description: "hello",
        access_token: "page-access-token",
      });
    },
  );

  it("several photos with Story chosen are refused before any request", async () => {
    const ctx = photoStory();
    const two = { ...ctx, mediaItems: [ctx.mediaItem, { ...ctx.mediaItem, id: "media-2" } as MediaItem] };

    expect((await failure(two))?.code).toBe("FACEBOOK_PAGE_STORY_ONE_FILE");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
