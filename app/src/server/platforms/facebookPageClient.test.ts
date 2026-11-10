import type { MediaItem, SocialConnection, User } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PUBLISH_UNCONFIRMED_MESSAGE } from "@/lib/publishOutcomes";
import {
  facebookPageClient,
  isFacebookAuthErrorBody,
} from "@/server/platforms/facebookPageClient";
import type { PublishContext } from "@/server/platforms/types";

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

vi.mock("@/lib/fetchWithTimeout", () => ({
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
