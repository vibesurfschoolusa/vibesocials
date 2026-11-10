import type { MediaItem, SocialConnection, User } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PUBLISH_UNCONFIRMED_CODE } from "@/lib/publishOutcomes";
import type { UploadSnapshot, UploadStateStore } from "@/server/jobs/uploadState";
import {
  PINTEREST_STATUS_CHECK_INTERVAL_MS,
  PINTEREST_STATUS_MAX_CHECKS,
  PINTEREST_VIDEO_STATE_KIND,
  pinterestClient,
  refreshPinterestToken,
} from "@/server/platforms/pinterestClient";
import type { PublishContext } from "@/server/platforms/types";

// Pinterest API v5 (lib/pinterestApi.ts). What is pinned here:
// - a photo becomes a Pin by URL (POST /pins, the commit call);
// - a video is registered (POST /media), uploaded to the URL Pinterest hands
//   back, then polled across steps (GET /media/{id}) before its Pin is created;
// - a rejected token flags the connection; an unknown commit outcome is
//   PUBLISH_UNCONFIRMED and never retried;
// - the 30-day access token is refreshed with the rotating refresh token.
const { updateMock, findUniqueMock, workspaceFindUniqueMock, fetchMock } = vi.hoisted(() => ({
  updateMock: vi.fn(),
  findUniqueMock: vi.fn(),
  workspaceFindUniqueMock: vi.fn(),
  fetchMock: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    socialConnection: { update: updateMock, findUnique: findUniqueMock },
    workspace: { findUnique: workspaceFindUniqueMock },
  },
}));

vi.mock("@/lib/fetchWithTimeout", async () => {
  const actual = await vi.importActual<typeof import("@/lib/fetchWithTimeout")>(
    "@/lib/fetchWithTimeout",
  );
  return { ...actual, fetchWithTimeout: fetchMock };
});

// The per-connection refresh lock needs a database; here a refresh just runs.
vi.mock("@/server/platforms/connectionRefresh", () => ({
  refreshConnectionToken: (
    connection: SocialConnection,
    refresh: (current: SocialConnection) => Promise<SocialConnection>,
  ) => refresh(connection),
}));

const PINS_URL = "https://api.pinterest.com/v5/pins";
const MEDIA_URL = "https://api.pinterest.com/v5/media";
const TOKEN_URL = "https://api.pinterest.com/v5/oauth/token";
const UPLOAD_URL = "https://pinterest-media-upload.s3-accelerate.amazonaws.com/";
const FAR_FUTURE = new Date(Date.now() + 20 * 24 * 60 * 60 * 1000);

beforeEach(() => {
  updateMock.mockReset();
  updateMock.mockImplementation(async ({ data }: { data: Partial<SocialConnection> }) => ({
    ...makeConnection(),
    ...data,
  }));
  // By default the database still holds the tokens makeConnection() builds, so
  // the guarded reconnect flag finds them unchanged and writes.
  findUniqueMock.mockReset();
  findUniqueMock.mockResolvedValue({ accessToken: "pin-access", refreshToken: "pin-refresh" });
  workspaceFindUniqueMock.mockReset();
  workspaceFindUniqueMock.mockResolvedValue({ companyWebsite: null });
  fetchMock.mockReset();
  vi.stubEnv("PINTEREST_APP_ID", "1234567");
  vi.stubEnv("PINTEREST_APP_SECRET", "app-secret");
  vi.stubEnv("PINTEREST_REDIRECT_URI", "https://app.example.com/api/auth/pinterest/callback");
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function makeConnection(overrides: Partial<SocialConnection> = {}): SocialConnection {
  return {
    id: "conn-1",
    userId: "user-1",
    workspaceId: "workspace-1",
    platform: "pinterest",
    accessToken: "pin-access",
    refreshToken: "pin-refresh",
    expiresAt: FAR_FUTURE,
    accountIdentifier: "vibesurfschool",
    scopes: null,
    metadata: { username: "vibesurfschool", boardId: "555", boardName: "Surf lessons" },
    needsReconnect: false,
    lastRefreshErrorCode: null,
    refreshFailedAt: null,
    createdAt: new Date("2026-11-01T00:00:00Z"),
    updatedAt: new Date("2026-11-01T00:00:00Z"),
    ...overrides,
  } as SocialConnection;
}

function makeContext(
  overrides: Partial<PublishContext> = {},
  mediaOverrides: Partial<MediaItem> = {},
  connectionOverrides: Partial<SocialConnection> = {},
): PublishContext {
  return {
    user: { id: "user-1" } as User,
    socialConnection: makeConnection(connectionOverrides),
    get mediaItems() { return [this.mediaItem]; },
    mediaItem: {
      id: "media-1",
      mimeType: "image/jpeg",
      storageLocation: "https://blob.example.com/photo.jpg",
      originalFilename: "photo.jpg",
      baseCaption: "Catch your first wave.",
      ...mediaOverrides,
    } as MediaItem,
    caption: "Catch your first wave.\n\nFor more info visit www.vibesurfschool.com",
    baseCaption: "Catch your first wave.",
    ...overrides,
  };
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

/** An in-memory stand-in for the result's upload state (uploadState.ts). */
function makeStore(initial?: UploadSnapshot<unknown>): UploadStateStore & {
  saved: UploadSnapshot<unknown> | null;
  kind: string | null;
  cleared: number;
} {
  const store = {
    saved: initial ?? null,
    kind: initial ? PINTEREST_VIDEO_STATE_KIND : (null as string | null),
    cleared: 0,
    async load<D, S = never>(kind: string) {
      return kind === store.kind ? (store.saved as UploadSnapshot<D, S> | null) : null;
    },
    async save<D, S = never>(kind: string, snapshot: UploadSnapshot<D, S>) {
      store.kind = kind;
      store.saved = snapshot as UploadSnapshot<unknown>;
    },
    async clear() {
      store.saved = null;
      store.cleared += 1;
    },
  };
  return store;
}

function requestOf(call: number): { url: string; init: RequestInit & { headers: Record<string, string> } } {
  const [url, init] = fetchMock.mock.calls[call] as [string, RequestInit & { headers: Record<string, string> }];
  return { url, init };
}

async function codeOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return (error as { code?: unknown }).code;
  }
  return "(resolved)";
}

describe("pinterestClient.publishVideo: a photo", () => {
  it("creates a Pin from the photo's URL on the connected board and returns the Pin id", async () => {
    fetchMock.mockResolvedValueOnce(json(201, { id: "987654321" }));

    const result = await pinterestClient.publishVideo(makeContext());

    expect(result).toEqual({ externalPostId: "987654321" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const { url, init } = requestOf(0);
    expect(url).toBe(PINS_URL);
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bearer pin-access");
    expect(JSON.parse(init.body as string)).toEqual({
      board_id: "555",
      title: "Catch your first wave.",
      description: "Catch your first wave.\n\nFor more info visit www.vibesurfschool.com",
      media_source: { source_type: "image_url", url: "https://blob.example.com/photo.jpg" },
    });
  });

  it("links the Pin to the workspace's website when one is saved", async () => {
    workspaceFindUniqueMock.mockResolvedValue({ companyWebsite: "www.vibesurfschool.com" });
    fetchMock.mockResolvedValueOnce(json(201, { id: "1" }));

    await pinterestClient.publishVideo(makeContext());

    expect(JSON.parse(requestOf(0).init.body as string).link).toBe("https://www.vibesurfschool.com/");
  });

  it("still creates the Pin, without a link, when the website can't be read", async () => {
    workspaceFindUniqueMock.mockRejectedValue(new Error("db down"));
    fetchMock.mockResolvedValueOnce(json(201, { id: "1" }));

    const result = await pinterestClient.publishVideo(makeContext());

    expect(result.externalPostId).toBe("1");
    expect(JSON.parse(requestOf(0).init.body as string)).not.toHaveProperty("link");
  });

  it("fits the title into 100 characters and the description into 800", async () => {
    fetchMock.mockResolvedValueOnce(json(201, { id: "1" }));
    const long = `${"Surf ".repeat(40)}end.`;

    await pinterestClient.publishVideo(makeContext({ baseCaption: long, caption: "x".repeat(900) }));

    const body = JSON.parse(requestOf(0).init.body as string) as { title: string; description: string };
    expect([...body.title].length).toBeLessThanOrEqual(100);
    expect([...body.description]).toHaveLength(800);
  });

  it("keeps an emoji-heavy title within Pinterest's 100 characters", async () => {
    fetchMock.mockResolvedValueOnce(json(201, { id: "1" }));
    const family = "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F466}";

    await pinterestClient.publishVideo(makeContext({ baseCaption: `${family.repeat(60)} surf day` }));

    const body = JSON.parse(requestOf(0).init.body as string) as { title: string };
    expect([...body.title].length).toBeLessThanOrEqual(100);
  });

  // Pinterest refuses some destination links, and a refused link refuses the
  // whole Pin. A 400 means nothing was created, so one more try is safe.
  it("a Pin refused with its link is created without the link", async () => {
    workspaceFindUniqueMock.mockResolvedValue({ companyWebsite: "bit.ly/surf" });
    fetchMock
      .mockResolvedValueOnce(json(400, { code: 1, message: "Invalid link" }))
      .mockResolvedValueOnce(json(201, { id: "42" }));

    const result = await pinterestClient.publishVideo(makeContext());

    expect(result).toEqual({ externalPostId: "42" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(requestOf(0).init.body as string).link).toBe("https://bit.ly/surf");
    const second = JSON.parse(requestOf(1).init.body as string) as Record<string, unknown>;
    expect(second).not.toHaveProperty("link");
    expect(second.board_id).toBe("555");
  });

  it("a Pin refused again without its link fails once, as before", async () => {
    workspaceFindUniqueMock.mockResolvedValue({ companyWebsite: "www.vibesurfschool.com" });
    fetchMock
      .mockResolvedValueOnce(json(400, { code: 1, message: "bad" }))
      .mockResolvedValueOnce(json(400, { code: 1, message: "bad" }));

    expect(await codeOf(pinterestClient.publishVideo(makeContext()))).toBe("PINTEREST_PUBLISH_FAILED");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("a Pin that had no link is never asked for twice", async () => {
    fetchMock.mockResolvedValueOnce(json(400, { code: 1, message: "bad" }));

    expect(await codeOf(pinterestClient.publishVideo(makeContext()))).toBe("PINTEREST_PUBLISH_FAILED");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("an unknown outcome with a link is still never asked for twice", async () => {
    workspaceFindUniqueMock.mockResolvedValue({ companyWebsite: "www.vibesurfschool.com" });
    fetchMock.mockResolvedValueOnce(json(503, {}));

    expect(await codeOf(pinterestClient.publishVideo(makeContext()))).toBe(PUBLISH_UNCONFIRMED_CODE);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("a rejected token (401) flags the connection and asks for a reconnect", async () => {
    fetchMock.mockResolvedValueOnce(json(401, { code: 2, message: "Authentication failed." }));

    await expect(pinterestClient.publishVideo(makeContext())).rejects.toMatchObject({
      code: "PINTEREST_RECONNECT_REQUIRED",
    });
    expect(updateMock).toHaveBeenCalledWith({
      where: { id: "conn-1" },
      data: {
        needsReconnect: true,
        lastRefreshErrorCode: "PINTEREST_RECONNECT_REQUIRED",
        refreshFailedAt: expect.any(Date),
      },
    });
  });

  it("a 401 for tokens that were replaced meanwhile flags nothing and is a plain retryable failure", async () => {
    findUniqueMock.mockResolvedValue({ accessToken: "newer-access", refreshToken: "newer-refresh" });
    fetchMock.mockResolvedValueOnce(json(401, { code: 2, message: "Authentication failed." }));

    expect(await codeOf(pinterestClient.publishVideo(makeContext()))).toBe("CONNECTION_TOKEN_CHANGED");
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("a board that no longer exists (404) says so, without flagging the connection", async () => {
    fetchMock.mockResolvedValueOnce(json(404, { code: 40, message: "Board not found." }));

    await expect(pinterestClient.publishVideo(makeContext())).rejects.toMatchObject({
      code: "PINTEREST_BOARD_NOT_FOUND",
    });
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("any other refusal is PINTEREST_PUBLISH_FAILED with the status, never Pinterest's own text", async () => {
    fetchMock.mockResolvedValueOnce(json(400, { code: 1, message: "secret upstream detail" }));

    const error = await pinterestClient.publishVideo(makeContext()).catch((e: Error & { code: string }) => e);

    expect(error).toMatchObject({ code: "PINTEREST_PUBLISH_FAILED" });
    expect((error as Error).message).toBe("Pinterest Pin could not be created (status 400)");
  });

  it("a 429 is RATE_LIMITED, with the wait from Retry-After", async () => {
    fetchMock.mockResolvedValueOnce(json(429, { code: 8, message: "Rate limit" }, { "Retry-After": "120" }));
    const before = Date.now();

    const error = (await pinterestClient.publishVideo(makeContext()).catch((e: unknown) => e)) as {
      code: string;
      retryAt: number;
    };

    expect(error.code).toBe("RATE_LIMITED");
    expect(error.retryAt).toBeGreaterThanOrEqual(before + 120_000);
    expect(error.retryAt).toBeLessThan(before + 125_000);
  });

  it("a 5xx on POST /pins is PUBLISH_UNCONFIRMED: the Pin may exist, so it is asked for once", async () => {
    fetchMock.mockResolvedValueOnce(json(503, {}));

    expect(await codeOf(pinterestClient.publishVideo(makeContext()))).toBe(PUBLISH_UNCONFIRMED_CODE);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("a 2xx without a Pin id is PUBLISH_UNCONFIRMED too", async () => {
    fetchMock.mockResolvedValueOnce(json(201, { note: "created" }));

    expect(await codeOf(pinterestClient.publishVideo(makeContext()))).toBe(PUBLISH_UNCONFIRMED_CODE);
  });

  it("refuses, before any request, a connection with no board chosen", async () => {
    const ctx = makeContext({}, {}, { metadata: { username: "vibesurfschool" } });

    expect(await codeOf(pinterestClient.publishVideo(ctx))).toBe("PINTEREST_NO_BOARD");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses, before any request, media that is neither a photo nor a video", async () => {
    const ctx = makeContext({}, { mimeType: "application/pdf" });

    expect(await codeOf(pinterestClient.publishVideo(ctx))).toBe("PINTEREST_UNSUPPORTED_MEDIA_TYPE");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses, before any request, a connection without an access token", async () => {
    const ctx = makeContext({}, {}, { accessToken: "" });

    expect(await codeOf(pinterestClient.publishVideo(ctx))).toBe("PINTEREST_NO_ACCESS_TOKEN");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not start when the step's time is spent", async () => {
    const ctx = makeContext({ deadline: Date.now() + 1_000 });

    expect(await codeOf(pinterestClient.publishVideo(ctx))).toBe("PUBLISH_TIME_BUDGET_EXCEEDED");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("pinterestClient.publishVideo: a video", () => {
  const VIDEO = {
    mimeType: "video/mp4",
    storageLocation: "https://blob.example.com/clip.mp4",
    originalFilename: "clip.mp4",
  };
  const REGISTERED = {
    media_id: "424242",
    media_type: "video",
    upload_url: UPLOAD_URL,
    upload_parameters: {
      "x-amz-date": "20261110T120000Z",
      "x-amz-signature": "sig",
      key: "uploads/aa/bb/clip",
      policy: "cG9saWN5",
      "Content-Type": "multipart/form-data",
    },
  };

  it("step 1 registers the video, uploads the file to the URL Pinterest hands back, and waits for processing", async () => {
    const store = makeStore();
    fetchMock
      .mockResolvedValueOnce(json(201, REGISTERED))
      .mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const before = Date.now();

    const result = await pinterestClient.publishVideo(makeContext({ uploadState: store }, VIDEO));

    // No Pin yet: the run calls again once the next status check is due.
    expect(result.externalPostId).toBeUndefined();
    expect(result.continuation?.resumeAt).toBeGreaterThanOrEqual(before + PINTEREST_STATUS_CHECK_INTERVAL_MS);
    expect(fetchMock).toHaveBeenCalledTimes(3);

    const register = requestOf(0);
    expect(register.url).toBe(MEDIA_URL);
    expect(register.init.method).toBe("POST");
    expect(register.init.headers.Authorization).toBe("Bearer pin-access");
    expect(JSON.parse(register.init.body as string)).toEqual({ media_type: "video" });

    expect(requestOf(1).url).toBe("https://blob.example.com/clip.mp4");

    const upload = requestOf(2);
    expect(upload.url).toBe(UPLOAD_URL);
    expect(upload.init.method).toBe("POST");
    // Our Pinterest token must never go to the storage host.
    expect(JSON.stringify(upload.init.headers ?? {})).not.toContain("pin-access");
    const form = upload.init.body as FormData;
    const fields = [...form.keys()];
    expect(fields.slice(0, -1).sort()).toEqual(Object.keys(REGISTERED.upload_parameters).sort());
    // S3 ignores every field after the file, so the file goes last.
    expect(fields.at(-1)).toBe("file");
    expect(form.get("key")).toBe("uploads/aa/bb/clip");
    expect((form.get("file") as File).size).toBe(4);
    // A fixed name, not the user's own file name.
    expect((form.get("file") as File).name).toBe("video.mp4");

    // Only the media id crosses the step: it is no capability without the token.
    expect(store.kind).toBe(PINTEREST_VIDEO_STATE_KIND);
    expect(store.saved?.data).toEqual({ mediaId: "424242", createdAt: expect.any(String), checks: 0 });
    expect(store.saved?.secret).toBeUndefined();
  });

  it("a later step creates the Pin once Pinterest has processed the video", async () => {
    const store = makeStore({ data: { mediaId: "424242", createdAt: new Date().toISOString(), checks: 1 } });
    fetchMock
      .mockResolvedValueOnce(json(200, { media_id: "424242", media_type: "video", status: "succeeded" }))
      .mockResolvedValueOnce(json(201, { id: "777" }));

    const result = await pinterestClient.publishVideo(makeContext({ uploadState: store }, VIDEO));

    expect(result).toEqual({ externalPostId: "777" });
    expect(requestOf(0).url).toBe(`${MEDIA_URL}/424242`);
    const pin = requestOf(1);
    expect(pin.url).toBe(PINS_URL);
    expect(JSON.parse(pin.init.body as string).media_source).toEqual({
      source_type: "video_id",
      media_id: "424242",
      cover_image_key_frame_time: 1,
    });
  });

  it("a later step that finds the video still processing counts the check and waits again", async () => {
    const store = makeStore({ data: { mediaId: "424242", createdAt: new Date().toISOString(), checks: 1 } });
    fetchMock.mockResolvedValueOnce(json(200, { media_id: "424242", status: "processing" }));

    const result = await pinterestClient.publishVideo(makeContext({ uploadState: store }, VIDEO));

    expect(result.continuation).toBeDefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(store.saved?.data).toMatchObject({ mediaId: "424242", checks: 2 });
  });

  // The file is uploaded and may be minutes into processing: a check that did
  // not complete must not throw that away.
  it.each([
    ["a timeout", () => Promise.reject(Object.assign(new Error("timed out"), { code: "FETCH_TIMEOUT" }))],
    ["a dropped connection", () => Promise.reject(new TypeError("fetch failed"))],
    ["a 503", () => Promise.resolve(json(503, {}))],
  ])("a status check that did not complete (%s) counts as a check and waits again", async (_what, answer) => {
    const store = makeStore({ data: { mediaId: "424242", createdAt: new Date().toISOString(), checks: 1 } });
    fetchMock.mockImplementationOnce(answer);

    const result = await pinterestClient.publishVideo(makeContext({ uploadState: store }, VIDEO));

    expect(result.continuation).toBeDefined();
    expect(store.saved?.data).toMatchObject({ mediaId: "424242", checks: 2 });
    expect(store.cleared).toBe(0);
  });

  it("an upload Pinterest no longer knows (404) fails the publish instead of waiting", async () => {
    const store = makeStore({ data: { mediaId: "424242", createdAt: new Date().toISOString(), checks: 1 } });
    fetchMock.mockResolvedValueOnce(json(404, { code: 1, message: "Media not found" }));

    const ctx = makeContext({ uploadState: store }, VIDEO);

    expect(await codeOf(pinterestClient.publishVideo(ctx))).toBe("PINTEREST_VIDEO_STATUS_FAILED");
  });

  it("a rate limit on the status check is waited out, with the upload kept", async () => {
    const store = makeStore({ data: { mediaId: "424242", createdAt: new Date().toISOString(), checks: 1 } });
    fetchMock.mockResolvedValueOnce(json(429, {}, { "Retry-After": "60" }));

    const ctx = makeContext({ uploadState: store }, VIDEO);

    expect(await codeOf(pinterestClient.publishVideo(ctx))).toBe("RATE_LIMITED");
    expect(store.saved?.data).toMatchObject({ mediaId: "424242", checks: 1 });
    expect(store.cleared).toBe(0);
  });

  it("gives up with PINTEREST_VIDEO_TIMEOUT after the last check, with nothing posted", async () => {
    const store = makeStore({
      data: {
        mediaId: "424242",
        createdAt: new Date().toISOString(),
        checks: PINTEREST_STATUS_MAX_CHECKS - 1,
      },
    });
    fetchMock.mockResolvedValueOnce(json(200, { media_id: "424242", status: "processing" }));

    const ctx = makeContext({ uploadState: store }, VIDEO);

    expect(await codeOf(pinterestClient.publishVideo(ctx))).toBe("PINTEREST_VIDEO_TIMEOUT");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(store.cleared).toBe(1);
  });

  it("a video Pinterest could not process fails PINTEREST_VIDEO_PROCESSING_FAILED and drops the upload", async () => {
    const store = makeStore({ data: { mediaId: "424242", createdAt: new Date().toISOString(), checks: 0 } });
    fetchMock.mockResolvedValueOnce(json(200, { media_id: "424242", status: "failed" }));

    const ctx = makeContext({ uploadState: store }, VIDEO);

    expect(await codeOf(pinterestClient.publishVideo(ctx))).toBe("PINTEREST_VIDEO_PROCESSING_FAILED");
    expect(store.cleared).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("uploads again when the saved upload is too old to trust", async () => {
    const old = new Date(Date.now() - 30 * 60 * 60 * 1000).toISOString();
    const store = makeStore({ data: { mediaId: "111", createdAt: old, checks: 2 } });
    fetchMock
      .mockResolvedValueOnce(json(201, REGISTERED))
      .mockResolvedValueOnce(new Response(new Uint8Array([1]), { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));

    const result = await pinterestClient.publishVideo(makeContext({ uploadState: store }, VIDEO));

    expect(result.continuation).toBeDefined();
    expect(requestOf(0).url).toBe(MEDIA_URL);
    expect(store.saved?.data).toMatchObject({ mediaId: "424242", checks: 0 });
  });

  it("an upload the storage host refuses fails PINTEREST_VIDEO_UPLOAD_FAILED and saves nothing", async () => {
    const store = makeStore();
    fetchMock
      .mockResolvedValueOnce(json(201, REGISTERED))
      .mockResolvedValueOnce(new Response(new Uint8Array([1]), { status: 200 }))
      .mockResolvedValueOnce(new Response("<Error>AccessDenied</Error>", { status: 403 }));

    const ctx = makeContext({ uploadState: store }, VIDEO);

    expect(await codeOf(pinterestClient.publishVideo(ctx))).toBe("PINTEREST_VIDEO_UPLOAD_FAILED");
    expect(store.saved).toBeNull();
  });

  it("refuses an upload URL that isn't https before sending the file anywhere", async () => {
    const store = makeStore();
    fetchMock.mockResolvedValueOnce(json(201, { ...REGISTERED, upload_url: "http://insecure.example.com/" }));

    const ctx = makeContext({ uploadState: store }, VIDEO);

    expect(await codeOf(pinterestClient.publishVideo(ctx))).toBe("PINTEREST_VIDEO_REGISTER_FAILED");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("a rejected token while registering flags the connection", async () => {
    fetchMock.mockResolvedValueOnce(json(401, { code: 2, message: "Authentication failed." }));

    const ctx = makeContext({ uploadState: makeStore() }, VIDEO);

    expect(await codeOf(pinterestClient.publishVideo(ctx))).toBe("PINTEREST_RECONNECT_REQUIRED");
    expect(updateMock).toHaveBeenCalledTimes(1);
  });

  it("with nowhere to keep its place, it checks the status in the same step and creates the Pin", async () => {
    fetchMock
      .mockResolvedValueOnce(json(201, REGISTERED))
      .mockResolvedValueOnce(new Response(new Uint8Array([1]), { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(json(200, { media_id: "424242", status: "succeeded" }))
      .mockResolvedValueOnce(json(201, { id: "888" }));

    const result = await pinterestClient.publishVideo(makeContext({}, VIDEO));

    expect(result).toEqual({ externalPostId: "888" });
  });
});

describe("refreshPinterestToken", () => {
  it("trades the refresh token for a new access token and keeps the new refresh token Pinterest sends", async () => {
    fetchMock.mockResolvedValueOnce(
      json(200, {
        access_token: "pin-access-2",
        refresh_token: "pin-refresh-2",
        expires_in: 2_592_000,
        refresh_token_expires_in: 5_184_000,
        token_type: "bearer",
      }),
    );
    const before = Date.now();

    const refreshed = await refreshPinterestToken(makeConnection());

    const { url, init } = requestOf(0);
    expect(url).toBe(TOKEN_URL);
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe(`Basic ${Buffer.from("1234567:app-secret").toString("base64")}`);
    expect(Object.fromEntries(init.body as URLSearchParams)).toEqual({
      grant_type: "refresh_token",
      refresh_token: "pin-refresh",
    });

    const { data } = updateMock.mock.calls[0][0] as { data: Record<string, unknown> };
    expect(data).toMatchObject({
      accessToken: "pin-access-2",
      refreshToken: "pin-refresh-2",
      needsReconnect: false,
      lastRefreshErrorCode: null,
      refreshFailedAt: null,
    });
    expect((data.expiresAt as Date).getTime()).toBeGreaterThanOrEqual(before + 2_592_000_000);
    expect(refreshed.accessToken).toBe("pin-access-2");
  });

  it("leaves the stored refresh token alone when Pinterest sends none", async () => {
    fetchMock.mockResolvedValueOnce(json(200, { access_token: "pin-access-2", expires_in: 3600 }));

    await refreshPinterestToken(makeConnection());

    const { data } = updateMock.mock.calls[0][0] as { data: Record<string, unknown> };
    expect(data).not.toHaveProperty("refreshToken");
  });

  it("a refused refresh token (400) flags the connection and asks for a reconnect", async () => {
    fetchMock.mockResolvedValueOnce(json(400, { code: 283, message: "Invalid refresh token" }));

    expect(await codeOf(refreshPinterestToken(makeConnection()))).toBe("PINTEREST_RECONNECT_REQUIRED");
    expect(updateMock).toHaveBeenCalledWith({
      where: { id: "conn-1" },
      data: {
        needsReconnect: true,
        lastRefreshErrorCode: "PINTEREST_RECONNECT_REQUIRED",
        refreshFailedAt: expect.any(Date),
      },
    });
  });

  // The token endpoint authenticates the APP (Basic auth). A wrong or rotated app
  // secret must not flag every customer's connection and email every owner.
  it("a 401 from the token endpoint is not taken as a dead connection", async () => {
    fetchMock.mockResolvedValueOnce(json(401, { code: 2, message: "Authentication failed." }));

    const error = (await refreshPinterestToken(makeConnection()).catch((e: unknown) => e)) as {
      code: string;
      status: number;
    };

    expect(error.code).toBe("PINTEREST_TOKEN_REFRESH_FAILED");
    expect(error.status).toBe(401);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("an outage (503) is PINTEREST_TOKEN_REFRESH_FAILED with the status, and flags nothing", async () => {
    fetchMock.mockResolvedValueOnce(json(503, {}));

    const error = (await refreshPinterestToken(makeConnection()).catch((e: unknown) => e)) as {
      code: string;
      status: number;
    };

    expect(error.code).toBe("PINTEREST_TOKEN_REFRESH_FAILED");
    expect(error.status).toBe(503);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("a connection with no refresh token is flagged without calling Pinterest", async () => {
    findUniqueMock.mockResolvedValue({ accessToken: "pin-access", refreshToken: null });

    const connection = makeConnection({ refreshToken: null });

    expect(await codeOf(refreshPinterestToken(connection))).toBe("PINTEREST_RECONNECT_REQUIRED");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("missing app credentials is a deployment problem: nothing is flagged", async () => {
    vi.stubEnv("PINTEREST_APP_SECRET", "");

    expect(await codeOf(refreshPinterestToken(makeConnection()))).toBe("PINTEREST_MISSING_OAUTH_CREDENTIALS");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(updateMock).not.toHaveBeenCalled();
  });
});

describe("pinterestClient.publishVideo: an access token about to expire", () => {
  it("is refreshed first, and the Pin is created with the new token", async () => {
    fetchMock
      .mockResolvedValueOnce(json(200, { access_token: "pin-access-2", refresh_token: "pin-refresh-2", expires_in: 2_592_000 }))
      .mockResolvedValueOnce(json(201, { id: "999" }));

    const ctx = makeContext({}, {}, { expiresAt: new Date(Date.now() + 60_000) });
    const result = await pinterestClient.publishVideo(ctx);

    expect(result.externalPostId).toBe("999");
    expect(requestOf(0).url).toBe(TOKEN_URL);
    expect(requestOf(1).init.headers.Authorization).toBe("Bearer pin-access-2");
  });
});

describe("pinterestClient.refreshToken", () => {
  it("is the token refresh the daily health sweep calls", async () => {
    fetchMock.mockResolvedValueOnce(json(200, { access_token: "pin-access-2", expires_in: 2_592_000 }));

    const refreshed = await pinterestClient.refreshToken?.(makeConnection());

    expect(refreshed?.accessToken).toBe("pin-access-2");
  });
});
