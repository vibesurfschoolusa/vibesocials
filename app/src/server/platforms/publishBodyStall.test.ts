import type { MediaItem, SocialConnection, User } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_FETCH_TIMEOUT_MS } from "@/lib/fetchWithTimeout";
import { PUBLISH_UNCONFIRMED_CODE } from "@/lib/publishOutcomes";
import { abortSignalTimeoutOnFakeClock, bodyNeverEnds } from "@/lib/stallingFetch.testkit";

// R48 platform latent pattern: every request in the publish path reads its
// whole body within its own limit (fetchWithinLimit; bodyBound.guard.test.ts
// keeps it so). Per client:
//  - a body that stalls before the post is a plain failure within the limit,
//    and the commit call is never sent (nothing was posted);
//  - a refusal whose body stalls is the same failure as before, status kept,
//    so a 5xx refusal is still retried in-step;
//  - a commit's 2xx body that stalls is PUBLISH_UNCONFIRMED and never resent.
// Each test carries its own short timeout, so a missing bound is a quick red
// test instead of a hung run. The real fetch helpers run over a stubbed fetch.
const STALL_TEST_TIMEOUT_MS = 5_000;

const { updateMock, findUniqueMock, workspaceFindUniqueMock } = vi.hoisted(() => ({
  updateMock: vi.fn(),
  findUniqueMock: vi.fn(),
  workspaceFindUniqueMock: vi.fn(),
}));
vi.mock("@/lib/db", () => ({
  prisma: {
    socialConnection: { update: updateMock, findUnique: findUniqueMock },
    workspace: { findUnique: workspaceFindUniqueMock },
  },
}));
// The per-connection refresh lock needs a database; here a refresh just runs.
vi.mock("@/server/platforms/connectionRefresh", () => ({
  refreshConnectionToken: (connection: unknown, refresh: (current: unknown) => Promise<unknown>) => refresh(connection),
}));

import { FACEBOOK_VIDEO_UPLOAD_TIMEOUT_MS, facebookPageClient } from "./facebookPageClient";
import { googleBusinessProfileClient } from "./googleBusinessProfileClient";
import { linkedinClient } from "./linkedinClient";
import { pinterestClient } from "./pinterestClient";
import { tiktokClient, TIKTOK_POLL_INTERVAL_MS } from "./tiktokClient";
import { withTransientRetries } from "./transientRetry";
import type { PublishContext } from "./types";
import { xClient } from "./xClient";
import { youtubeClient } from "./youtubeClient";

type Handler = (input: string | URL, init?: RequestInit) => Promise<Response>;
type Route = [match: (url: string, body: string) => boolean, handler: Handler];

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
const answer = (make: () => Response): Handler => () => Promise.resolve(make());
/** Headers with `status` at once, then a body that never ends. */
const stalls =
  (status = 200): Handler =>
  (input, init) =>
    bodyNeverEnds(input, init).then((res) => new Response(res.body, { status }));
const blob = answer(() => new Response(new Uint8Array([1, 2, 3, 4])));

function stub(routes: Route[]) {
  const fetchMock = vi.fn((input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const body = typeof init?.body === "string" || init?.body instanceof URLSearchParams ? String(init.body) : "";
    const route = routes.find(([match]) => match(url, body));
    if (!route) throw new Error(`Unexpected fetch in test: ${url}`);
    return route[1](input, init);
  });
  vi.stubGlobal("fetch", fetchMock);
  const calls = (part: string) => fetchMock.mock.calls.filter(([url]) => String(url).includes(part)).length;
  return { fetchMock, calls };
}
const has =
  (part: string) =>
  (url: string): boolean =>
    url.includes(part);

type Outcome = { value: unknown } | { error: Error & { code?: string; status?: number } } | "still waiting";

/** Where `run` stands after `ms` of fake time. */
async function after(ms: number, run: Promise<unknown>): Promise<Outcome> {
  const settled = run.then(
    (value) => ({ value }),
    (error: Error & { code?: string; status?: number }) => ({ error }),
  );
  await vi.advanceTimersByTimeAsync(ms);
  return Promise.race([settled, Promise.resolve("still waiting" as const)]);
}
const errorOf = (out: Outcome) => (typeof out === "object" && "error" in out ? out.error : null);

function connection(platform: string, overrides: Partial<SocialConnection> = {}): SocialConnection {
  return {
    id: `conn-${platform}`,
    userId: "user-1",
    workspaceId: "workspace-1",
    platform,
    accessToken: "access-token",
    refreshToken: "refresh-token",
    expiresAt: new Date(Date.now() + 24 * 3_600_000),
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
    ...overrides,
  } as SocialConnection;
}

function ctx(socialConnection: SocialConnection, mimeType: string, extra: Partial<PublishContext> = {}): PublishContext {
  const mediaItem = {
    id: "media-1",
    mimeType,
    storageLocation: `https://blob.example.com/${mimeType.startsWith("video/") ? "v.mp4" : "photo.jpg"}`,
    sizeBytes: 4,
    originalFilename: mimeType.startsWith("video/") ? "v.mp4" : "photo.jpg",
    baseCaption: "hello",
    perPlatformOverrides: null,
    metadata: null,
  } as unknown as MediaItem;
  return {
    user: { id: "user-1" } as User,
    socialConnection,
    mediaItem,
    mediaItems: [mediaItem],
    caption: "hello",
    ...extra,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  abortSignalTimeoutOnFakeClock();
  updateMock.mockReset();
  updateMock.mockResolvedValue({});
  findUniqueMock.mockReset();
  findUniqueMock.mockResolvedValue({ accessToken: "access-token", refreshToken: "refresh-token" });
  workspaceFindUniqueMock.mockReset();
  workspaceFindUniqueMock.mockResolvedValue(null);
  vi.stubEnv("X_CONSUMER_KEY", "consumer-key");
  vi.stubEnv("X_CONSUMER_SECRET", "consumer-secret");
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

describe("X: a body that never ends", () => {
  const routes = (over: { init?: Handler; finalize?: Handler; status?: Handler; v1?: Handler }): Route[] => [
    [has("blob.example.com"), blob],
    [(url, body) => url.includes("upload.twitter.com") && body.includes("command=INIT"), over.init ?? answer(() => json({ media_id_string: "m1" }))],
    [(url, body) => url.includes("upload.twitter.com") && body.includes("command=APPEND"), answer(() => new Response(null, { status: 204 }))],
    [
      (url, body) => url.includes("upload.twitter.com") && body.includes("command=FINALIZE"),
      over.finalize ?? answer(() => json({ media_id_string: "m1", processing_info: { state: "succeeded" } })),
    ],
    [has("command=STATUS"), over.status ?? answer(() => json({ processing_info: { state: "succeeded" } }))],
    [has("statuses/update.json"), over.v1 ?? answer(() => json({ id_str: "tweet-1" }))],
    [has("/2/tweets"), answer(() => json({ data: { id: "tweet-2" } }))],
  ];
  const tweets = (calls: (part: string) => number) => calls("statuses/update.json") + calls("/2/tweets");

  it("a stalled INIT body is a plain failure within the limit; no tweet is sent", async () => {
    const { calls } = stub(routes({ init: stalls() }));

    const error = errorOf(await after(DEFAULT_FETCH_TIMEOUT_MS, xClient.publishVideo(ctx(connection("x"), "video/mp4"))));

    expect(error).not.toBeNull();
    expect(error?.code).not.toBe(PUBLISH_UNCONFIRMED_CODE);
    expect(tweets(calls)).toBe(0);
  }, STALL_TEST_TIMEOUT_MS);

  it("a stalled FINALIZE body is a plain failure within the limit; no tweet is sent", async () => {
    const { calls } = stub(routes({ finalize: stalls() }));

    const error = errorOf(await after(DEFAULT_FETCH_TIMEOUT_MS, xClient.publishVideo(ctx(connection("x"), "video/mp4"))));

    expect(error).not.toBeNull();
    expect(error?.code).not.toBe(PUBLISH_UNCONFIRMED_CODE);
    expect(tweets(calls)).toBe(0);
  }, STALL_TEST_TIMEOUT_MS);

  // R48 review low 3: v1.1's refusal is read before v2 is sent. A stalled
  // refusal body still ends within the limit and leads to exactly one v2 send.
  it("a v1.1 refusal whose body stalls leads to exactly one v2 send, which posts", async () => {
    const { calls } = stub(routes({ v1: stalls(403) }));

    const out = await after(2 * DEFAULT_FETCH_TIMEOUT_MS, xClient.publishVideo(ctx(connection("x"), "video/mp4")));

    expect(out).toEqual({ value: { externalPostId: "tweet-2" } });
    expect(calls("statuses/update.json")).toBe(1);
    expect(calls("/2/tweets")).toBe(1);
  }, STALL_TEST_TIMEOUT_MS);

  it("a stalled tweet body is PUBLISH_UNCONFIRMED, sent once, with no v2 fallback", async () => {
    const { calls } = stub(routes({ v1: stalls() }));

    const error = errorOf(
      await after(
        DEFAULT_FETCH_TIMEOUT_MS,
        withTransientRetries(() => xClient.publishVideo(ctx(connection("x"), "video/mp4")), { sleep: async () => {} }),
      ),
    );

    expect(error?.code).toBe(PUBLISH_UNCONFIRMED_CODE);
    expect(calls("statuses/update.json")).toBe(1);
    expect(calls("/2/tweets")).toBe(0);
  }, STALL_TEST_TIMEOUT_MS);
});

describe("LinkedIn: a body that never ends", () => {
  const UPLOAD_URL = "https://upload.linkedin.example/u";
  const li = () =>
    connection("linkedin", { scopes: "w_organization_social", metadata: { organizations: [{ id: "123", name: "Acme" }] } });
  const routes = (over: { register?: Handler; post?: Handler }): Route[] => [
    [has("blob.example.com"), blob],
    [
      has("?action=initializeUpload"),
      over.register ??
        answer(() => json({ value: { uploadUrlExpiresAt: Date.now() + 3_600_000, uploadUrl: UPLOAD_URL, image: "urn:li:image:1" } })),
    ],
    [(url) => url === UPLOAD_URL, answer(() => new Response("", { status: 201 }))],
    [(url) => url === "https://api.linkedin.com/rest/posts", over.post ?? answer(() => json({ id: "urn:li:share:1" }, 201))],
  ];

  it("a stalled initializeUpload body is a plain failure within the limit; nothing is posted", async () => {
    const { calls } = stub(routes({ register: stalls() }));

    const error = errorOf(await after(DEFAULT_FETCH_TIMEOUT_MS, linkedinClient.publishVideo(ctx(li(), "image/jpeg"))));

    expect(error).not.toBeNull();
    expect(error?.code).not.toBe(PUBLISH_UNCONFIRMED_CODE);
    expect(calls("/rest/posts")).toBe(0);
  }, STALL_TEST_TIMEOUT_MS);

  it("a post refused with a 400 whose body stalls fails as before, not unconfirmed", async () => {
    stub(routes({ post: stalls(400) }));

    const error = errorOf(await after(DEFAULT_FETCH_TIMEOUT_MS, linkedinClient.publishVideo(ctx(li(), "image/jpeg"))));

    expect(error?.code).toBe("LINKEDIN_POST_CREATION_FAILED");
  }, STALL_TEST_TIMEOUT_MS);

  it("a stalled 201 post body (no x-restli-id) is PUBLISH_UNCONFIRMED and sent once", async () => {
    const { calls } = stub(routes({ post: (input, init) => stalls(201)(input, init) }));

    const error = errorOf(
      await after(
        DEFAULT_FETCH_TIMEOUT_MS,
        withTransientRetries(() => linkedinClient.publishVideo(ctx(li(), "image/jpeg")), { sleep: async () => {} }),
      ),
    );

    expect(error?.code).toBe(PUBLISH_UNCONFIRMED_CODE);
    expect(calls("/rest/posts")).toBe(1);
  }, STALL_TEST_TIMEOUT_MS);
});

describe("Pinterest: a body that never ends", () => {
  const pin = () => connection("pinterest", { metadata: { username: "acme", boardId: "555", boardName: "Surf" } });
  const PINS = "https://api.pinterest.com/v5/pins";

  it("a video registration refused with a 503 whose body stalls keeps its status, so it is retried in-step", async () => {
    const { calls } = stub([[has("/v5/media"), stalls(503)]]);

    const error = errorOf(
      await after(
        4 * DEFAULT_FETCH_TIMEOUT_MS,
        withTransientRetries(() => pinterestClient.publishVideo(ctx(pin(), "video/mp4")), { sleep: async () => {} }),
      ),
    );

    expect(error).toMatchObject({ code: "PINTEREST_VIDEO_REGISTER_FAILED", status: 503 });
    expect(calls("/v5/media")).toBe(3);
    expect(calls("/v5/pins")).toBe(0);
  }, STALL_TEST_TIMEOUT_MS);

  it("a stalled registration body is a plain failure within the limit; no Pin is made", async () => {
    const { calls } = stub([[has("/v5/media"), stalls()]]);

    const error = errorOf(await after(DEFAULT_FETCH_TIMEOUT_MS, pinterestClient.publishVideo(ctx(pin(), "video/mp4"))));

    expect(error).not.toBeNull();
    expect(error?.code).not.toBe(PUBLISH_UNCONFIRMED_CODE);
    expect(calls("/v5/pins")).toBe(0);
  }, STALL_TEST_TIMEOUT_MS);

  it("a stalled 201 Pin body is PUBLISH_UNCONFIRMED and sent once", async () => {
    const { calls } = stub([[(url) => url === PINS, stalls(201)]]);

    const error = errorOf(
      await after(
        DEFAULT_FETCH_TIMEOUT_MS,
        withTransientRetries(() => pinterestClient.publishVideo(ctx(pin(), "image/jpeg")), { sleep: async () => {} }),
      ),
    );

    expect(error?.code).toBe(PUBLISH_UNCONFIRMED_CODE);
    expect(calls("/v5/pins")).toBe(1);
  }, STALL_TEST_TIMEOUT_MS);
});

describe("Facebook Page: a body that never ends", () => {
  const fb = () => connection("facebook_page", { refreshToken: null, accountIdentifier: "page-1", metadata: { pageName: "Acme" } });
  function twoPhotos(): PublishContext {
    const base = ctx(fb(), "image/jpeg");
    const second = { ...base.mediaItem, id: "media-2", storageLocation: "https://blob.example.com/photo-2.jpg" } as MediaItem;
    return { ...base, mediaItems: [base.mediaItem, second] };
  }

  it("a stalled body of one photo's upload (several photos) is a plain failure within the limit; no feed post", async () => {
    let uploads = 0;
    const { calls } = stub([
      [has("/page-1/photos"), (input, init) => (uploads++ === 0 ? Promise.resolve(json({ id: "photo-1" })) : stalls()(input, init))],
      [has("/page-1/feed"), answer(() => json({ id: "page-1_post-9" }))],
    ]);

    const error = errorOf(await after(DEFAULT_FETCH_TIMEOUT_MS, facebookPageClient.publishVideo(twoPhotos())));

    expect(error).not.toBeNull();
    expect(error?.code).not.toBe(PUBLISH_UNCONFIRMED_CODE);
    expect(calls("/page-1/feed")).toBe(0);
  }, STALL_TEST_TIMEOUT_MS);

  it("a single photo refused with a 400 whose body stalls fails as before, not unconfirmed", async () => {
    stub([[has("/page-1/photos"), stalls(400)]]);

    const error = errorOf(await after(DEFAULT_FETCH_TIMEOUT_MS, facebookPageClient.publishVideo(ctx(fb(), "image/jpeg"))));

    expect(error?.code).toBe("FACEBOOK_PAGE_PUBLISH_FAILED");
  }, STALL_TEST_TIMEOUT_MS);

  it("a stalled 200 feed body (several photos) is PUBLISH_UNCONFIRMED and sent once", async () => {
    let uploads = 0;
    const { calls } = stub([
      [has("/page-1/photos"), answer(() => json({ id: `photo-${++uploads}` }))],
      [has("/page-1/feed"), stalls()],
    ]);

    const error = errorOf(
      await after(DEFAULT_FETCH_TIMEOUT_MS, withTransientRetries(() => facebookPageClient.publishVideo(twoPhotos()), { sleep: async () => {} })),
    );

    expect(error?.code).toBe(PUBLISH_UNCONFIRMED_CODE);
    expect(calls("/page-1/feed")).toBe(1);
  }, STALL_TEST_TIMEOUT_MS);
});

describe("Facebook Page: a stalled refusal before a resend", () => {
  const fb = () => connection("facebook_page", { refreshToken: null, accountIdentifier: "page-1", metadata: { pageName: "Acme" } });
  const bodies: unknown[] = [];
  const recorded =
    (handler: Handler): Handler =>
    (input, init) => {
      bodies.push(init?.body);
      return handler(input, init);
    };
  beforeEach(() => {
    bodies.length = 0;
  });

  // R48 review low 3: refusedForDescription reads the 4xx from a clone. A
  // stalled one still ends within the limit, and the photo goes once more
  // without its description.
  it("a photo refused with its description and a stalled body is sent once more without it", async () => {
    let sends = 0;
    stub([
      [
        has("/page-1/photos"),
        recorded((input, init) => (sends++ === 0 ? stalls(400)(input, init) : Promise.resolve(json({ id: "photo-9", post_id: "page-1_post-9" })))),
      ],
    ]);
    const withDescription = ctx(fb(), "image/jpeg");
    const item = { ...withDescription.mediaItem, altText: "A surfer on a small wave" } as MediaItem;

    const out = await after(
      2 * DEFAULT_FETCH_TIMEOUT_MS,
      facebookPageClient.publishVideo({ ...withDescription, mediaItem: item, mediaItems: [item] }),
    );

    expect(out).toMatchObject({ value: { externalPostId: expect.any(String) } });
    expect(bodies).toHaveLength(2);
    expect(String(bodies[0])).toContain("alt_text_custom");
    expect(String(bodies[1])).not.toContain("alt_text_custom");
  }, STALL_TEST_TIMEOUT_MS);

  // refusedForThumb likewise: the video goes once more without its cover.
  it("a video refused with its cover and a stalled body is sent once more without it", async () => {
    let sends = 0;
    stub([
      [has("cover.jpg"), answer(() => new Response(new Uint8Array([7, 7])))],
      [
        has("/page-1/videos"),
        recorded((input, init) => (sends++ === 0 ? stalls(400)(input, init) : Promise.resolve(json({ id: "video-1" })))),
      ],
    ]);

    // A video's send has the video upload's limit.
    const out = await after(
      2 * FACEBOOK_VIDEO_UPLOAD_TIMEOUT_MS,
      facebookPageClient.publishVideo(ctx(fb(), "video/mp4", { cover: { timeMs: 900, imageUrl: "https://blob.example.com/cover.jpg" } })),
    );

    expect(out).toMatchObject({ value: { externalPostId: "video-1" } });
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toBeInstanceOf(FormData);
    expect(bodies[1]).toBeInstanceOf(URLSearchParams);
  }, STALL_TEST_TIMEOUT_MS);
});

describe("Google Business Profile: a body that never ends", () => {
  const gbp = () => connection("google_business_profile", { expiresAt: null, metadata: { locationName: "accounts/111/locations/999" } });
  const POSTS = "mybusiness.googleapis.com/v4/accounts/111/locations/999/localPosts";

  it("a post refused with a 400 whose body stalls is a plain failure, not unconfirmed", async () => {
    stub([[has(POSTS), stalls(400)]]);

    const error = errorOf(await after(DEFAULT_FETCH_TIMEOUT_MS, googleBusinessProfileClient.publishVideo(ctx(gbp(), "image/jpeg"))));

    expect(error).not.toBeNull();
    expect(error?.code).not.toBe(PUBLISH_UNCONFIRMED_CODE);
    expect(error?.status).toBe(400);
  }, STALL_TEST_TIMEOUT_MS);

  it("a stalled 200 post body is PUBLISH_UNCONFIRMED and sent once", async () => {
    const { calls } = stub([[has(POSTS), stalls()]]);

    const error = errorOf(
      await after(
        DEFAULT_FETCH_TIMEOUT_MS,
        withTransientRetries(() => googleBusinessProfileClient.publishVideo(ctx(gbp(), "image/jpeg")), { sleep: async () => {} }),
      ),
    );

    expect(error?.code).toBe(PUBLISH_UNCONFIRMED_CODE);
    expect(calls("localPosts")).toBe(1);
  }, STALL_TEST_TIMEOUT_MS);
});

describe("YouTube: a body that never ends", () => {
  const yt = () => connection("youtube", { expiresAt: null });
  const INSERT = "googleapis.com/upload/youtube/v3/videos";

  it("a stalled 200 insert body is PUBLISH_UNCONFIRMED and sent once", async () => {
    const { calls } = stub([
      [has("blob.example.com"), blob],
      [has(INSERT), stalls()],
    ]);

    const error = errorOf(
      await after(
        2 * 120_000,
        withTransientRetries(() => youtubeClient.publishVideo(ctx(yt(), "video/mp4")), { sleep: async () => {} }),
      ),
    );

    expect(error?.code).toBe(PUBLISH_UNCONFIRMED_CODE);
    expect(calls(INSERT)).toBe(1);
  }, STALL_TEST_TIMEOUT_MS);
});

describe("TikTok: a body that never ends", () => {
  const tt = () => connection("tiktok", { accountIdentifier: "open-id-1" });
  const tiktokCtx = () =>
    ctx(tt(), "video/mp4", {
      tiktokMetadata: { privacyLevel: "SELF_ONLY", disableComment: true, disableDuet: true, disableStitch: true },
    });
  const routes = (over: { creator?: Handler; init?: Handler; status?: Handler }): Route[] => [
    [
      has("creator_info/query"),
      over.creator ?? answer(() => json({ data: { creator_username: "acme", privacy_level_options: ["SELF_ONLY"] }, error: { code: "ok" } })),
    ],
    [has("blob.example.com"), blob],
    [
      has("video/init"),
      over.init ??
        answer(() => json({ data: { publish_id: "publish-123", upload_url: "https://upload.tiktok.example/u" }, error: { code: "ok" } })),
    ],
    [has("upload.tiktok.example"), answer(() => new Response("", { status: 201 }))],
    [has("status/fetch"), over.status ?? answer(() => json({ data: { status: "PUBLISH_COMPLETE" } }))],
  ];

  it("a stalled creator_info body is a plain failure within the limit; nothing is uploaded", async () => {
    const { calls } = stub(routes({ creator: stalls() }));

    const error = errorOf(await after(DEFAULT_FETCH_TIMEOUT_MS, tiktokClient.publishVideo(tiktokCtx())));

    expect(error).not.toBeNull();
    expect(error?.code).not.toBe(PUBLISH_UNCONFIRMED_CODE);
    expect(calls("video/init")).toBe(0);
  }, STALL_TEST_TIMEOUT_MS);

  it("a stalled video/init body is a plain failure within the limit; nothing is uploaded", async () => {
    const { calls } = stub(routes({ init: stalls() }));

    const error = errorOf(await after(DEFAULT_FETCH_TIMEOUT_MS, tiktokClient.publishVideo(tiktokCtx())));

    expect(error).not.toBeNull();
    expect(error?.code).not.toBe(PUBLISH_UNCONFIRMED_CODE);
    expect(calls("upload.tiktok.example")).toBe(0);
  }, STALL_TEST_TIMEOUT_MS);

  it("a stalled status body is a check that didn't complete: the next check confirms the post", async () => {
    let checks = 0;
    stub(
      routes({
        status: (input, init) =>
          checks++ === 0 ? stalls()(input, init) : Promise.resolve(json({ data: { status: "PUBLISH_COMPLETE" } })),
      }),
    );

    const out = await after(2 * TIKTOK_POLL_INTERVAL_MS + DEFAULT_FETCH_TIMEOUT_MS, tiktokClient.publishVideo(tiktokCtx()));

    expect(out).toEqual({ value: { externalPostId: "publish-123" } });
    expect(checks).toBe(2);
  }, STALL_TEST_TIMEOUT_MS);
});
