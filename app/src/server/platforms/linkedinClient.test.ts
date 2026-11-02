import type { SocialConnection } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PUBLISH_UNCONFIRMED_MESSAGE } from "@/lib/publishOutcomes";
import {
  ensureFreshLinkedInToken,
  linkedinClient,
  refreshLinkedInToken,
} from "@/server/platforms/linkedinClient";
import {
  MIN_REQUEST_WINDOW_MS,
  PUBLISH_BUDGET_EXCEEDED_CODE,
  PUBLISH_STEP_BUDGET_MS,
} from "@/server/platforms/publishBudget";
import { withTransientRetries } from "@/server/platforms/transientRetry";

// Mirrors googleTokens.test.ts: vi.mock + vi.hoisted are hoisted above imports,
// and refreshLinkedInToken resolves prisma via `await import("@/lib/db")` at
// call time, so it receives this mock. No real database is touched.
const { updateMock } = vi.hoisted(() => ({ updateMock: vi.fn() }));

vi.mock("@/lib/db", () => ({
  prisma: {
    socialConnection: {
      update: updateMock,
    },
  },
}));

function makeConnection(
  overrides: Partial<SocialConnection> = {},
): SocialConnection {
  return {
    id: "conn-1",
    userId: "user-1",
    workspaceId: "workspace-1",
    platform: "linkedin",
    accessToken: "old-access-token",
    refreshToken: "refresh-abc",
    // Default to already-expired so the ensure* tests exercise the expiry path.
    expiresAt: new Date("2020-01-01T00:00:00Z"),
    accountIdentifier: "acct-1",
    scopes: "w_organization_social",
    metadata: { organizations: [{ id: "123", name: "Acme" }] },
    needsReconnect: false,
    lastRefreshErrorCode: null,
    refreshFailedAt: null,
    createdAt: new Date("2020-01-01T00:00:00Z"),
    updatedAt: new Date("2020-01-01T00:00:00Z"),
    ...overrides,
  };
}

function tokenResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  updateMock.mockReset();
  updateMock.mockImplementation(
    (args: { data: Record<string, unknown> }) =>
      Promise.resolve({ ...makeConnection(), ...args.data }),
  );
  vi.stubEnv("LINKEDIN_CLIENT_ID", "test-client-id");
  vi.stubEnv("LINKEDIN_CLIENT_SECRET", "test-client-secret");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("refreshLinkedInToken", () => {
  it("updates ONLY accessToken and expiresAt, never refreshToken or metadata, and computes expiry", async () => {
    const expiresIn = 5_184_000; // 60 days
    const fetchMock = vi.fn().mockResolvedValue(
      tokenResponse({
        access_token: "new-access-token",
        expires_in: expiresIn,
        // LinkedIn commonly ALSO returns a rotated refresh_token here; the
        // discipline is to ignore it and never write refreshToken.
        refresh_token: "rotated-refresh-token",
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const connection = makeConnection({ id: "conn-42", refreshToken: "refresh-xyz" });

    const before = Date.now();
    await refreshLinkedInToken(connection);
    const after = Date.now();

    expect(updateMock).toHaveBeenCalledTimes(1);
    const arg = updateMock.mock.calls[0][0] as {
      where: { id: string };
      data: Record<string, unknown>;
    };

    expect(arg.where).toEqual({ id: "conn-42" });

    // The success write persists the new token + expiry and clears the
    // reconnect-health flags. It must NEVER touch refreshToken or metadata.
    expect(Object.keys(arg.data).sort()).toEqual([
      "accessToken",
      "expiresAt",
      "lastRefreshErrorCode",
      "needsReconnect",
      "refreshFailedAt",
    ]);
    expect(arg.data).not.toHaveProperty("refreshToken");
    expect(arg.data).not.toHaveProperty("metadata");
    expect(arg.data.needsReconnect).toBe(false);
    expect(arg.data.accessToken).toBe("new-access-token");

    // Expiry math: now + expires_in seconds.
    const expiresMs = (arg.data.expiresAt as Date).getTime();
    expect(expiresMs).toBeGreaterThanOrEqual(before + expiresIn * 1000);
    expect(expiresMs).toBeLessThanOrEqual(after + expiresIn * 1000);
  });

  it("falls back to a ~60-day default expiry when expires_in is missing, and still omits refreshToken", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      tokenResponse({
        access_token: "new-access-token",
        // expires_in intentionally omitted.
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const connection = makeConnection({ id: "conn-99", refreshToken: "refresh-xyz" });

    const before = Date.now();
    await refreshLinkedInToken(connection);
    const after = Date.now();

    expect(updateMock).toHaveBeenCalledTimes(1);
    const arg = updateMock.mock.calls[0][0] as {
      data: Record<string, unknown>;
    };

    const expiresAt = arg.data.expiresAt as Date;
    const defaultTtlMs = 5_184_000 * 1000;
    expect(expiresAt instanceof Date && !isNaN(expiresAt.getTime())).toBe(true);
    expect(expiresAt.getTime()).toBeGreaterThanOrEqual(before + defaultTtlMs);
    expect(expiresAt.getTime()).toBeLessThanOrEqual(after + defaultTtlMs);
    expect(arg.data).not.toHaveProperty("refreshToken");
  });

  it("throws LINKEDIN_NO_REFRESH_TOKEN and never touches the network or database when no refresh token", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const connection = makeConnection({ refreshToken: null });

    const error = await refreshLinkedInToken(connection)
      .then(() => null)
      .catch((e: unknown) => e as Error & { code?: string });

    expect(error?.code).toBe("LINKEDIN_NO_REFRESH_TOKEN");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("throws LINKEDIN_MISSING_OAUTH_CREDENTIALS when client env vars are absent", async () => {
    vi.stubEnv("LINKEDIN_CLIENT_ID", "");
    vi.stubEnv("LINKEDIN_CLIENT_SECRET", "");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const error = await refreshLinkedInToken(makeConnection())
      .then(() => null)
      .catch((e: unknown) => e as Error & { code?: string });

    expect(error?.code).toBe("LINKEDIN_MISSING_OAUTH_CREDENTIALS");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("throws sanitized LINKEDIN_TOKEN_REFRESH_FAILED without leaking the upstream body or updating (transient 503)", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const upstreamBody = "upstream unavailable SECRET123";
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(upstreamBody, { status: 503, statusText: "Service Unavailable" }));
    vi.stubGlobal("fetch", fetchMock);

    const error = await refreshLinkedInToken(makeConnection())
      .then(() => null)
      .catch((e: unknown) => e as Error & { code?: string; status?: number });

    expect(error?.code).toBe("LINKEDIN_TOKEN_REFRESH_FAILED");
    expect(error?.status).toBe(503);
    expect(error?.message).not.toContain(upstreamBody);
    expect(error?.message).toContain("503");
    expect(updateMock).not.toHaveBeenCalled();
    // Raw upstream body reaches the server logs, not the user-facing message.
    expect(JSON.stringify(consoleSpy.mock.calls)).toContain(upstreamBody);
  });

  it("flags needsReconnect and throws LINKEDIN_RECONNECT_REQUIRED on a terminal 400 invalid_grant (sanitized cause)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const upstreamBody = JSON.stringify({ error: "invalid_grant", error_description: "SECRET123 revoked" });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(upstreamBody, { status: 400 })));

    const error = await refreshLinkedInToken(makeConnection({ id: "conn-77" }))
      .then(() => null)
      .catch((e: unknown) => e as Error & { code?: string; cause?: Error & { code?: string } });

    expect(error?.code).toBe("LINKEDIN_RECONNECT_REQUIRED");
    expect(error?.cause?.code).toBe("LINKEDIN_TOKEN_REFRESH_FAILED");
    expect(error?.message).not.toContain("SECRET123");
    expect(error?.cause?.message).not.toContain("SECRET123");
    expect(updateMock).toHaveBeenCalledTimes(1);
    const arg = updateMock.mock.calls[0][0] as { where: { id: string }; data: Record<string, unknown> };
    expect(arg.where).toEqual({ id: "conn-77" });
    expect(arg.data.needsReconnect).toBe(true);
    expect(arg.data).not.toHaveProperty("accessToken");
    expect(arg.data).not.toHaveProperty("refreshToken");
  });
});

describe("ensureFreshLinkedInToken", () => {
  it("returns the connection unchanged without any network or DB call when the token is still fresh", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const future = new Date(Date.now() + 60 * 60 * 1000); // 1 hour ahead
    const connection = makeConnection({ expiresAt: future });

    const result = await ensureFreshLinkedInToken(connection);

    expect(result).toBe(connection);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("throws LINKEDIN_RECONNECT_REQUIRED (no network) and marks needsReconnect (flag fields only, no tokens) when expired and there is no refresh token", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const connection = makeConnection({ id: "conn-55", refreshToken: null }); // expiresAt past by default

    const error = await ensureFreshLinkedInToken(connection)
      .then(() => null)
      .catch((e: unknown) => e as Error & { code?: string });

    expect(error?.code).toBe("LINKEDIN_RECONNECT_REQUIRED");
    expect(error?.message).toContain("reconnect");
    expect(fetchMock).not.toHaveBeenCalled();

    // Roadmap Phase 4: this is the common non-partner-app case — mark before
    // throwing. Flag fields only, never accessToken/refreshToken.
    expect(updateMock).toHaveBeenCalledTimes(1);
    const arg = updateMock.mock.calls[0][0] as {
      where: { id: string };
      data: Record<string, unknown>;
    };
    expect(arg.where).toEqual({ id: "conn-55" });
    expect(Object.keys(arg.data).sort()).toEqual([
      "lastRefreshErrorCode",
      "needsReconnect",
      "refreshFailedAt",
    ]);
    expect(arg.data.needsReconnect).toBe(true);
    expect(arg.data.lastRefreshErrorCode).toBe("LINKEDIN_RECONNECT_REQUIRED");
    expect(arg.data).not.toHaveProperty("accessToken");
    expect(arg.data).not.toHaveProperty("refreshToken");
  });

  it("refreshes and returns the updated connection when expired and a refresh token is present", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      tokenResponse({ access_token: "fresh-token", expires_in: 5_184_000 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const connection = makeConnection({ refreshToken: "refresh-xyz" });

    const result = await ensureFreshLinkedInToken(connection);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(updateMock).toHaveBeenCalledTimes(1);
    const arg = updateMock.mock.calls[0][0] as { data: Record<string, unknown> };
    expect(Object.keys(arg.data).sort()).toEqual([
      "accessToken",
      "expiresAt",
      "lastRefreshErrorCode",
      "needsReconnect",
      "refreshFailedAt",
    ]);
    expect(arg.data).not.toHaveProperty("refreshToken");
    expect(result.accessToken).toBe("fresh-token");
  });

  it("maps a refresh failure to LINKEDIN_RECONNECT_REQUIRED, preserving the original error as cause, and marks needsReconnect (flag fields only, no tokens)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response("invalid_grant", { status: 400 }));
    vi.stubGlobal("fetch", fetchMock);

    const connection = makeConnection({ id: "conn-66", refreshToken: "dead-refresh-token" });

    const error = await ensureFreshLinkedInToken(connection)
      .then(() => null)
      .catch((e: unknown) => e as Error & { code?: string; cause?: { code?: string } });

    expect(error?.code).toBe("LINKEDIN_RECONNECT_REQUIRED");
    expect(error?.cause?.code).toBe("LINKEDIN_TOKEN_REFRESH_FAILED");

    // Roadmap Phase 4: the wrapping guard marks on the actionable
    // LINKEDIN_RECONNECT_REQUIRED outcome — flag fields only, never
    // accessToken/refreshToken (refreshLinkedInToken's own failed attempt
    // above never touched the database either).
    expect(updateMock).toHaveBeenCalledTimes(1);
    const arg = updateMock.mock.calls[0][0] as {
      where: { id: string };
      data: Record<string, unknown>;
    };
    expect(arg.where).toEqual({ id: "conn-66" });
    expect(Object.keys(arg.data).sort()).toEqual([
      "lastRefreshErrorCode",
      "needsReconnect",
      "refreshFailedAt",
    ]);
    expect(arg.data.needsReconnect).toBe(true);
    expect(arg.data.lastRefreshErrorCode).toBe("LINKEDIN_RECONNECT_REQUIRED");
    expect(arg.data).not.toHaveProperty("accessToken");
    expect(arg.data).not.toHaveProperty("refreshToken");
  });
});

// 2026-11-01 audit (Task 4 item 2): a refresh failure flags needsReconnect
// ONLY when it is terminal (HTTP 400/401, e.g. invalid_grant — the shared
// isTerminalRefreshFailure rule). Rate limits, LinkedIn outages, network blips
// and our own config problems must leave a working connection unflagged.
describe("ensureFreshLinkedInToken — non-terminal refresh failures", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  async function ensureError(connection = makeConnection()) {
    return ensureFreshLinkedInToken(connection)
      .then(() => null)
      .catch((e: unknown) => e as Error & { code?: string; status?: number });
  }

  it.each([
    ["429 rate limited", 429, { error: "rate_limited" }],
    ["500", 500, "<html>oops</html>"],
    ["503", 503, { error: "temporarily_unavailable" }],
    ["401 invalid_client (our OAuth client, not the user's grant)", 401, { error: "invalid_client" }],
  ] as const)("%s: rethrows the status-carrying refresh error WITHOUT flagging", async (_l, status, body) => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(typeof body === "string" ? body : JSON.stringify(body), { status }),
      ),
    );

    const error = await ensureError();

    expect(error?.code).toBe("LINKEDIN_TOKEN_REFRESH_FAILED");
    // status is carried so withTransientRetries can retry 429/5xx in-step.
    expect(error?.status).toBe(status);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("propagates a network failure unchanged and does not flag", async () => {
    const networkError = new TypeError("fetch failed");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(networkError));

    const error = await ensureError();

    expect(error).toBe(networkError);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("does not flag when OUR OAuth credentials are missing (deployment problem, not the user's grant)", async () => {
    vi.stubEnv("LINKEDIN_CLIENT_ID", "");
    vi.stubEnv("LINKEDIN_CLIENT_SECRET", "");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const error = await ensureError();

    expect(error?.code).toBe("LINKEDIN_MISSING_OAUTH_CREDENTIALS");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(updateMock).not.toHaveBeenCalled();
  });
});


// 2026-11-01 scale audit (platform limits, V16): LinkedIn rate-limits with HTTP
// 429. Every publish-path call (register image/video, upload PUT, ugcPosts) is
// classified before the client builds its own *_FAILED error; the token
// endpoint's existing transient handling is untouched.
describe("linkedinClient.publishVideo — rate limits (RATE_LIMITED)", () => {
  type LimitedError = Error & { code?: string; kind?: string; retryAt?: number | null; platform?: string };

  const UPLOAD_URL = "https://upload.linkedin.example/u";
  const registered = () =>
    new Response(
      JSON.stringify({
        value: {
          asset: "urn:li:digitalmediaAsset:1",
          uploadMechanism: {
            "com.linkedin.digitalmedia.uploading.MediaUploadHttpRequest": { uploadUrl: UPLOAD_URL },
          },
        },
      }),
      { status: 200 },
    );
  const limited = (headers: Record<string, string> = {}) => new Response("", { status: 429, headers });

  function ctx(mimeType: string) {
    return {
      user: { id: "user-1" },
      socialConnection: makeConnection({ id: "conn-li", expiresAt: new Date(Date.now() + 3_600_000) }),
      mediaItem: {
        mimeType,
        storageLocation: "https://blob.example.com/m",
        originalFilename: "m",
      },
      caption: "hello",
    } as unknown as Parameters<typeof linkedinClient.publishVideo>[0];
  }

  function stubLinkedIn(routes: { register?: () => Response; upload?: () => Response; post?: () => Response }) {
    const fetchMock = vi.fn((input: string | URL) => {
      const url = String(input);
      if (url.includes("blob.example.com")) return Promise.resolve(new Response(new Uint8Array([1, 2, 3, 4])));
      if (url.includes("assets?action=registerUpload")) return Promise.resolve((routes.register ?? registered)());
      if (url === UPLOAD_URL) return Promise.resolve((routes.upload ?? (() => new Response("", { status: 201 })))());
      if (url.includes("/v2/ugcPosts")) {
        return Promise.resolve((routes.post ?? (() => new Response(JSON.stringify({ id: "urn:li:share:1" }), { status: 201 })))());
      }
      throw new Error(`Unexpected fetch in test: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  const failure = (promise: Promise<unknown>) =>
    promise.then(
      () => null,
      (e: unknown) => e as LimitedError,
    );

  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("ugcPosts 429 -> RATE_LIMITED, not LINKEDIN_POST_CREATION_FAILED", async () => {
    stubLinkedIn({ post: () => limited({ "Retry-After": "300" }) });

    const error = await failure(linkedinClient.publishVideo(ctx("image/jpeg")));

    expect(error).toMatchObject({ code: "RATE_LIMITED", platform: "linkedin", kind: "rate_limited" });
    expect(error?.message).toBe("LinkedIn is limiting requests right now.");
    expect(error?.retryAt).toBeGreaterThan(Date.now());
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("ugcPosts 429 without Retry-After -> retryAt null (the run's backoff applies)", async () => {
    stubLinkedIn({ post: () => limited() });
    expect((await failure(linkedinClient.publishVideo(ctx("image/jpeg"))))?.retryAt).toBeNull();
  });

  it("a non-429 ugcPosts failure keeps LINKEDIN_POST_CREATION_FAILED", async () => {
    stubLinkedIn({ post: () => new Response("{}", { status: 422 }) });
    expect((await failure(linkedinClient.publishVideo(ctx("image/jpeg"))))?.code).toBe(
      "LINKEDIN_POST_CREATION_FAILED",
    );
  });

  it("image registerUpload 429 -> RATE_LIMITED, not LINKEDIN_IMAGE_REGISTRATION_FAILED", async () => {
    stubLinkedIn({ register: () => limited() });
    expect((await failure(linkedinClient.publishVideo(ctx("image/jpeg"))))?.code).toBe("RATE_LIMITED");
  });

  it("image upload PUT 429 -> RATE_LIMITED, not LINKEDIN_IMAGE_UPLOAD_FAILED", async () => {
    stubLinkedIn({ upload: () => limited() });
    expect((await failure(linkedinClient.publishVideo(ctx("image/jpeg"))))?.code).toBe("RATE_LIMITED");
  });

  it("video registerUpload 429 -> RATE_LIMITED, not LINKEDIN_VIDEO_REGISTRATION_FAILED", async () => {
    stubLinkedIn({ register: () => limited() });
    expect((await failure(linkedinClient.publishVideo(ctx("video/mp4"))))?.code).toBe("RATE_LIMITED");
  });

  it("video upload PUT 429 -> RATE_LIMITED, not LINKEDIN_VIDEO_UPLOAD_FAILED", async () => {
    stubLinkedIn({ upload: () => limited() });
    expect((await failure(linkedinClient.publishVideo(ctx("video/mp4"))))?.code).toBe("RATE_LIMITED");
  });

  // 2026-11-01 scale audit (jobs H6, Review Focus 5): `POST /v2/ugcPosts` is the
  // commit call. A 5xx, a timeout or a dropped connection there may already have
  // created the post, so it is PUBLISH_UNCONFIRMED and is never re-run. The
  // register / upload calls before it publish nothing and are untouched.
  describe("commit call (POST /v2/ugcPosts)", () => {
    const ugcPostCalls = (fetchMock: ReturnType<typeof stubLinkedIn>) =>
      fetchMock.mock.calls.filter((c) => String(c[0]).includes("/v2/ugcPosts"));

    /** Every call succeeds except ugcPosts, which `post` answers (or rejects). */
    function stubUgcPostRejecting(error: unknown) {
      vi.stubGlobal(
        "fetch",
        vi.fn((input: string | URL) => {
          const url = String(input);
          if (url.includes("blob.example.com")) return Promise.resolve(new Response(new Uint8Array([1, 2, 3, 4])));
          if (url.includes("assets?action=registerUpload")) return Promise.resolve(registered());
          if (url === UPLOAD_URL) return Promise.resolve(new Response("", { status: 201 }));
          if (url.includes("/v2/ugcPosts")) return Promise.reject(error);
          throw new Error(`Unexpected fetch in test: ${url}`);
        }),
      );
    }

    it("ugcPosts 503 -> PUBLISH_UNCONFIRMED, requested once", async () => {
      const fetchMock = stubLinkedIn({ post: () => new Response("busy", { status: 503 }) });

      const error = await failure(linkedinClient.publishVideo(ctx("image/jpeg")));

      expect(error?.code).toBe("PUBLISH_UNCONFIRMED");
      expect(error?.message).toBe(PUBLISH_UNCONFIRMED_MESSAGE);
      expect(ugcPostCalls(fetchMock)).toHaveLength(1);
      expect(updateMock).not.toHaveBeenCalled();
    });

    it("ugcPosts 503 is not re-run by the in-step retry: one registration, one post", async () => {
      const fetchMock = stubLinkedIn({ post: () => new Response("busy", { status: 503 }) });

      await expect(
        withTransientRetries(() => linkedinClient.publishVideo(ctx("image/jpeg")), { sleep: async () => {} }),
      ).rejects.toMatchObject({ code: "PUBLISH_UNCONFIRMED" });
      expect(ugcPostCalls(fetchMock)).toHaveLength(1);
      expect(fetchMock.mock.calls.filter((c) => String(c[0]).includes("registerUpload"))).toHaveLength(1);
    });

    it("a ugcPosts timeout -> PUBLISH_UNCONFIRMED", async () => {
      stubUgcPostRejecting(Object.assign(new Error("Request timed out after 30000ms"), { code: "FETCH_TIMEOUT" }));

      expect((await failure(linkedinClient.publishVideo(ctx("image/jpeg"))))?.code).toBe("PUBLISH_UNCONFIRMED");
    });

    it("a connection dropped after ugcPosts was sent -> PUBLISH_UNCONFIRMED", async () => {
      stubUgcPostRejecting(new TypeError("fetch failed", { cause: { code: "ECONNRESET" } }));

      expect((await failure(linkedinClient.publishVideo(ctx("image/jpeg"))))?.code).toBe("PUBLISH_UNCONFIRMED");
    });

    it("a ugcPosts that never connected is rethrown unchanged (provably not sent)", async () => {
      const neverConnected = new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } });
      stubUgcPostRejecting(neverConnected);

      expect(await failure(linkedinClient.publishVideo(ctx("image/jpeg")))).toBe(neverConnected);
    });

    it("ugcPosts 401 keeps the reconnect error and flags the connection", async () => {
      stubLinkedIn({ post: () => new Response("{}", { status: 401 }) });

      const error = await failure(linkedinClient.publishVideo(ctx("image/jpeg")));

      expect(error?.code).toBe("LINKEDIN_RECONNECT_REQUIRED");
      expect(updateMock).toHaveBeenCalledTimes(1);
    });

    it("a 5xx on an earlier call (the image upload PUT) is NOT unconfirmed", async () => {
      stubLinkedIn({ upload: () => new Response("busy", { status: 503 }) });

      const error = await failure(linkedinClient.publishVideo(ctx("image/jpeg")));

      expect(error?.code).toBe("LINKEDIN_IMAGE_UPLOAD_FAILED");
    });
  });
});

// 2026-11-01 scale audit (step budget, Task 7): every LinkedIn request - the token
// refresh, the media download, register, upload and ugcPosts - ends by the step
// deadline, and none is started with under 5 s left.
describe("linkedinClient — step deadline", () => {
  const NOW = Date.parse("2026-11-01T12:00:00Z");
  const UPLOAD_URL = "https://upload.linkedin.example/u";
  type CodedError = Error & { code?: string };

  const registered = () =>
    new Response(
      JSON.stringify({
        value: {
          asset: "urn:li:digitalmediaAsset:1",
          uploadMechanism: {
            "com.linkedin.digitalmedia.uploading.MediaUploadHttpRequest": { uploadUrl: UPLOAD_URL },
          },
        },
      }),
      { status: 200 },
    );
  const blobOk = () => new Response(new Uint8Array([1, 2, 3, 4]));
  const uploadOk = () => new Response("", { status: 201 });
  const postOk = () => new Response(JSON.stringify({ id: "urn:li:share:1" }), { status: 201 });

  function ctx(mimeType: string, deadline?: number) {
    return {
      user: { id: "user-1" },
      socialConnection: makeConnection({ id: "conn-li", expiresAt: new Date(Date.now() + 3_600_000) }),
      mediaItem: {
        mimeType,
        storageLocation: "https://blob.example.com/m",
        originalFilename: "m",
      },
      caption: "hello",
      deadline,
    } as unknown as Parameters<typeof linkedinClient.publishVideo>[0];
  }

  const failure = (promise: Promise<unknown>) =>
    promise.then(
      () => null,
      (e: unknown) => e as CodedError,
    );

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
  function stubRoutes(overrides: { blob?: Route; register?: Route; upload?: Route; post?: Route } = {}) {
    const fetchMock = vi.fn<typeof fetch>((input, init) => {
      const url = String(input);
      if (url.includes("blob.example.com")) return (overrides.blob ?? (async () => blobOk()))(init);
      if (url.includes("assets?action=registerUpload")) {
        return (overrides.register ?? (async () => registered()))(init);
      }
      if (url === UPLOAD_URL) return (overrides.upload ?? (async () => uploadOk()))(init);
      if (url.includes("/v2/ugcPosts")) return (overrides.post ?? (async () => postOk()))(init);
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
  });

  describe("publishVideo", () => {
    it.each([
      ["video", "video/mp4"],
      ["image", "image/jpeg"],
    ])("refuses to start a %s publish once the step budget is spent (no request at all)", async (_label, mimeType) => {
      const fetchMock = stubRoutes();

      const error = await failure(
        linkedinClient.publishVideo(ctx(mimeType, Date.now() + MIN_REQUEST_WINDOW_MS - 1)),
      );

      expect(error?.code).toBe(PUBLISH_BUDGET_EXCEEDED_CODE);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("refuses to refresh an expired token with under 5 s left (no token request)", async () => {
      const fetchMock = stubRoutes();
      const expired = { ...ctx("video/mp4", Date.now() + MIN_REQUEST_WINDOW_MS - 1) };
      expired.socialConnection = makeConnection({ expiresAt: new Date("2020-01-01T00:00:00Z") });

      const error = await failure(linkedinClient.publishVideo(expired));

      expect(error?.code).toBe(PUBLISH_BUDGET_EXCEEDED_CODE);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(updateMock).not.toHaveBeenCalled();
    });

    it("clamps every request of a video publish to the time left (download, register, upload, ugcPosts <= 12 s)", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(NOW);
      const fetchMock = stubRoutes();
      const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
      const abortTimeoutSpy = vi.spyOn(AbortSignal, "timeout");

      await expect(linkedinClient.publishVideo(ctx("video/mp4", NOW + 12_000))).resolves.toEqual({
        externalPostId: "urn:li:share:1",
      });

      expect(fetchMock).toHaveBeenCalledTimes(4);
      const timeouts = setTimeoutSpy.mock.calls.map((c) => c[1] as number);
      expect(timeouts).toHaveLength(4);
      for (const timeout of timeouts) {
        expect(timeout).toBeLessThanOrEqual(12_000);
        expect(timeout).toBeGreaterThanOrEqual(MIN_REQUEST_WINDOW_MS);
      }
      // The download also carries a whole-transfer bound (its body is read after the headers).
      expect(abortTimeoutSpy).toHaveBeenCalledTimes(1);
      expect(abortTimeoutSpy.mock.calls[0][0]).toBeLessThanOrEqual(12_000);
    });

    it("clamps every request of an image publish to the time left (register, download, upload, ugcPosts <= 12 s)", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(NOW);
      const fetchMock = stubRoutes();
      const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
      const abortTimeoutSpy = vi.spyOn(AbortSignal, "timeout");

      await expect(linkedinClient.publishVideo(ctx("image/jpeg", NOW + 12_000))).resolves.toEqual({
        externalPostId: "urn:li:share:1",
      });

      expect(fetchMock).toHaveBeenCalledTimes(4);
      const timeouts = setTimeoutSpy.mock.calls.map((c) => c[1] as number);
      expect(timeouts).toHaveLength(4);
      for (const timeout of timeouts) {
        expect(timeout).toBeLessThanOrEqual(12_000);
        expect(timeout).toBeGreaterThanOrEqual(MIN_REQUEST_WINDOW_MS);
      }
      expect(abortTimeoutSpy).toHaveBeenCalledTimes(1);
      expect(abortTimeoutSpy.mock.calls[0][0]).toBeLessThanOrEqual(12_000);
    });

    it("worst case: slow download + register and a hung upload PUT still settle by the step deadline", async () => {
      vi.useFakeTimers();
      const start = Date.now();
      const deadline = start + PUBLISH_STEP_BUDGET_MS;
      const fetchMock = stubRoutes({
        blob: slow(118_000, blobOk),
        register: slow(25_000, registered),
        upload: hang,
      });

      let settledAt = 0;
      const promise = failure(linkedinClient.publishVideo(ctx("video/mp4", deadline))).then((e) => {
        settledAt = Date.now();
        return e;
      });
      await vi.advanceTimersByTimeAsync(400_000);
      const error = await promise;

      // The video downloaded and registered by 143 s; the upload hung and was
      // cut off at the deadline (unclamped it would run to 143 + 120 = 263 s).
      expect(error?.code).toBe("FETCH_TIMEOUT");
      expect(callsTo(fetchMock, UPLOAD_URL)).toHaveLength(1);
      expect(callsTo(fetchMock, "/v2/ugcPosts")).toHaveLength(0);
      expect(settledAt).toBeLessThanOrEqual(deadline);
      expect(settledAt - start).toBeLessThan(240_000);
    });

    it("worst case: a hung ugcPosts commit is cut off by the deadline and reported PUBLISH_UNCONFIRMED", async () => {
      vi.useFakeTimers();
      const start = Date.now();
      const deadline = start + PUBLISH_STEP_BUDGET_MS;
      stubRoutes({
        blob: slow(118_000, blobOk),
        register: slow(25_000, registered),
        upload: slow(60_000, uploadOk),
        post: hang,
      });

      let settledAt = 0;
      const promise = failure(linkedinClient.publishVideo(ctx("video/mp4", deadline))).then((e) => {
        settledAt = Date.now();
        return e;
      });
      await vi.advanceTimersByTimeAsync(400_000);
      const error = await promise;

      // 118 + 25 + 60 = 203 s elapsed; ugcPosts gets the 22 s left, not 30 s.
      expect(error?.code).toBe("PUBLISH_UNCONFIRMED");
      expect(settledAt).toBeLessThanOrEqual(deadline);
    });

    it("a ugcPosts that would start with under 5 s left is refused (retry-safe), never reported unconfirmed", async () => {
      vi.useFakeTimers();
      const start = Date.now();
      // The upload answers after 22 s of the 26 s: ugcPosts would get 4 s.
      const fetchMock = stubRoutes({ upload: slow(22_000, uploadOk) });

      const promise = failure(linkedinClient.publishVideo(ctx("image/jpeg", start + 26_000)));
      await vi.advanceTimersByTimeAsync(30_000);
      const error = await promise;

      expect(error?.code).toBe(PUBLISH_BUDGET_EXCEEDED_CODE);
      expect(callsTo(fetchMock, "/v2/ugcPosts")).toHaveLength(0);
    });
  });

  describe("token refresh", () => {
    const refreshOk = () =>
      vi.fn().mockResolvedValue(tokenResponse({ access_token: "fresh-access-token", expires_in: 5_184_000 }));
    const expiredConnection = () => makeConnection({ expiresAt: new Date("2020-01-01T00:00:00Z") });

    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(NOW);
    });

    it("refreshLinkedInToken clamps the token request to the time left (a deadline 8 s away -> <= 8 s)", async () => {
      vi.stubGlobal("fetch", refreshOk());
      const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");

      await refreshLinkedInToken(makeConnection(), { deadline: NOW + 8_000 });

      const timeouts = setTimeoutSpy.mock.calls.map((c) => c[1] as number);
      expect(timeouts).toHaveLength(1);
      expect(timeouts[0]).toBeLessThanOrEqual(8_000);
      expect(timeouts[0]).toBeGreaterThanOrEqual(MIN_REQUEST_WINDOW_MS);
    });

    it("refreshLinkedInToken keeps the 30 s default without a deadline", async () => {
      vi.stubGlobal("fetch", refreshOk());
      const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");

      await refreshLinkedInToken(makeConnection());

      expect(setTimeoutSpy.mock.calls.map((c) => c[1])).toEqual([30_000]);
    });

    it("refreshLinkedInToken refuses to start with under 5 s left: no request, no write, no reconnect flag", async () => {
      const fetchMock = refreshOk();
      vi.stubGlobal("fetch", fetchMock);

      const error = await failure(
        refreshLinkedInToken(makeConnection(), { deadline: NOW + MIN_REQUEST_WINDOW_MS - 1 }),
      );

      expect(error?.code).toBe(PUBLISH_BUDGET_EXCEEDED_CODE);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(updateMock).not.toHaveBeenCalled();
    });

    it("ensureFreshLinkedInToken passes its deadline to the refresh (8 s away -> request <= 8 s)", async () => {
      vi.stubGlobal("fetch", refreshOk());
      const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");

      const refreshed = await ensureFreshLinkedInToken(expiredConnection(), NOW + 8_000);

      expect(refreshed.accessToken).toBe("fresh-access-token");
      const timeouts = setTimeoutSpy.mock.calls.map((c) => c[1] as number);
      expect(timeouts).toHaveLength(1);
      expect(timeouts[0]).toBeLessThanOrEqual(8_000);
    });

    it("ensureFreshLinkedInToken refuses to refresh with under 5 s left", async () => {
      const fetchMock = refreshOk();
      vi.stubGlobal("fetch", fetchMock);

      const error = await failure(
        ensureFreshLinkedInToken(expiredConnection(), NOW + MIN_REQUEST_WINDOW_MS - 1),
      );

      expect(error?.code).toBe(PUBLISH_BUDGET_EXCEEDED_CODE);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("ensureFreshLinkedInToken leaves a fresh token alone even with the budget spent", async () => {
      const fetchMock = refreshOk();
      vi.stubGlobal("fetch", fetchMock);
      const fresh = makeConnection({ expiresAt: new Date(NOW + 3_600_000) });

      await expect(ensureFreshLinkedInToken(fresh, NOW - 1)).resolves.toBe(fresh);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });
});
