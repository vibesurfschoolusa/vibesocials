import type { MediaItem, SocialConnection, User } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PUBLISH_UNCONFIRMED_MESSAGE } from "@/lib/publishOutcomes";
import type { UploadStateStore } from "@/server/jobs/uploadState";
import { MAX_CONTINUATIONS_PER_RESULT } from "@/server/jobs/platformSteps";
import {
  ensureFreshLinkedInToken,
  LINKEDIN_ASSET_MAX_WAIT_MS,
  LINKEDIN_ASSET_POLL_INTERVAL_MS,
  LINKEDIN_MAX_UPLOAD_RESTARTS,
  LINKEDIN_POST_MIN_WINDOW_MS,
  LINKEDIN_TRANSIENT_RESUME_DELAY_MS,
  LINKEDIN_UPLOAD_STATE_KIND,
  LINKEDIN_URL_EXPIRY_SAFETY_MS,
  linkedinClient,
  refreshLinkedInToken,
} from "@/server/platforms/linkedinClient";
import {
  LARGE_UPLOAD_CHUNK_WINDOW_MS,
  LARGE_UPLOAD_MAX_PART_BYTES,
  LARGE_VIDEO_THRESHOLD_BYTES,
} from "@/server/platforms/largeUpload";
import {
  MIN_REQUEST_WINDOW_MS,
  PUBLISH_BUDGET_EXCEEDED_CODE,
  PUBLISH_STEP_BUDGET_MS,
} from "@/server/platforms/publishBudget";
import type { PublishContext } from "@/server/platforms/types";
import { withTransientRetries } from "@/server/platforms/transientRetry";

// Mirrors googleTokens.test.ts: vi.mock + vi.hoisted are hoisted above imports,
// and refreshLinkedInToken resolves prisma via `await import("@/lib/db")` at
// call time, so it receives this mock. No real database is touched.
const { updateMock, findUniqueMock, refreshConnectionTokenMock } = vi.hoisted(() => ({
  updateMock: vi.fn(),
  findUniqueMock: vi.fn(),
  refreshConnectionTokenMock: vi.fn(),
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

// The per-connection refresh lock has its own suite (connectionRefresh.test.ts).
// Here it is a pass-through spy: the tests below assert that every refresh is
// routed through it, with the step deadline, and exercise the refresher itself.
vi.mock("@/server/platforms/connectionRefresh", () => ({
  refreshConnectionToken: refreshConnectionTokenMock,
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
  // By default the database still holds the tokens makeConnection() builds, so
  // the guarded flag finds them unchanged and writes.
  findUniqueMock.mockReset();
  findUniqueMock.mockResolvedValue({
    accessToken: "old-access-token",
    refreshToken: "refresh-abc",
  });
  refreshConnectionTokenMock.mockReset();
  refreshConnectionTokenMock.mockImplementation(
    (
      snapshot: SocialConnection,
      refresh: (current: SocialConnection) => Promise<SocialConnection>,
    ) => refresh(snapshot),
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
    findUniqueMock.mockResolvedValue({ accessToken: "old-access-token", refreshToken: null });

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
    findUniqueMock.mockResolvedValue({
      accessToken: "old-access-token",
      refreshToken: "dead-refresh-token",
    });

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

// 2026-11-01 scale audit (jobs, token refresh): the flag is guarded by the
// tokens this refresh used (LinkedIn does not rotate the refresh token, V16, but
// another process may have refreshed the ACCESS token, or the user reconnected).
describe("LinkedIn refresh — superseded by another refresh", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  const invalidGrant = () =>
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 })),
    );

  const caughtCode = (promise: Promise<unknown>) =>
    promise.then(
      () => null,
      (e: unknown) => (e as Error & { code?: string }).code ?? "no-code",
    );

  it("invalid_grant while the stored access token already changed: throws TOKEN_REFRESH_SUPERSEDED and never writes needsReconnect", async () => {
    invalidGrant();
    findUniqueMock.mockResolvedValue({
      accessToken: "another-process-access-token",
      refreshToken: "refresh-abc",
    });

    const code = await caughtCode(refreshLinkedInToken(makeConnection({ id: "conn-s" })));

    expect(code).toBe("TOKEN_REFRESH_SUPERSEDED");
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("still flags and throws LINKEDIN_RECONNECT_REQUIRED when the stored tokens are the ones that failed", async () => {
    invalidGrant();

    const code = await caughtCode(refreshLinkedInToken(makeConnection({ id: "conn-dead" })));

    expect(code).toBe("LINKEDIN_RECONNECT_REQUIRED");
    expect(updateMock).toHaveBeenCalledTimes(1);
  });

  it("ensureFreshLinkedInToken: expired with no refresh token while the stored tokens changed (a reconnect) is superseded, not flagged", async () => {
    findUniqueMock.mockResolvedValue({
      accessToken: "reconnected-access-token",
      refreshToken: "reconnected-refresh-token",
    });

    const code = await caughtCode(ensureFreshLinkedInToken(makeConnection({ refreshToken: null })));

    expect(code).toBe("TOKEN_REFRESH_SUPERSEDED");
    expect(updateMock).not.toHaveBeenCalled();
  });
});

// 2026-11-01 scale audit (jobs, token refresh): ensureFreshLinkedInToken
// serializes every refresh decision per connection (connectionRefresh.ts).
describe("ensureFreshLinkedInToken — serialized per connection", () => {
  it("routes an expired token through refreshConnectionToken with the snapshot and the step deadline", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(tokenResponse({ access_token: "fresh-token", expires_in: 5_184_000 })),
    );
    const connection = makeConnection();
    const deadline = Date.now() + 60_000;

    await ensureFreshLinkedInToken(connection, deadline);

    expect(refreshConnectionTokenMock).toHaveBeenCalledTimes(1);
    expect(refreshConnectionTokenMock.mock.calls[0][0]).toBe(connection);
    expect(refreshConnectionTokenMock.mock.calls[0][2]).toEqual({ deadline });
  });

  it("does not take the lock for a token that is still fresh", async () => {
    const connection = makeConnection({ expiresAt: new Date(Date.now() + 60 * 60 * 1000) });

    await ensureFreshLinkedInToken(connection);

    expect(refreshConnectionTokenMock).not.toHaveBeenCalled();
  });

  it("returns whatever the lock hands back (another process's refresh), without sending a request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const winner = makeConnection({ accessToken: "winner-access" });
    refreshConnectionTokenMock.mockResolvedValue(winner);

    const result = await ensureFreshLinkedInToken(makeConnection());

    expect(result).toBe(winner);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refreshes the row the lock re-read, not the stale snapshot", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(tokenResponse({ access_token: "fresh-token", expires_in: 5_184_000 }));
    vi.stubGlobal("fetch", fetchMock);
    const stored = makeConnection({ refreshToken: "stored-refresh" });
    refreshConnectionTokenMock.mockImplementation(
      (_snapshot: SocialConnection, refresh: (c: SocialConnection) => Promise<SocialConnection>) =>
        refresh(stored),
    );

    await ensureFreshLinkedInToken(makeConnection({ refreshToken: "stale-refresh" }));

    const body = new URLSearchParams(String((fetchMock.mock.calls[0][1] as RequestInit).body));
    expect(body.get("refresh_token")).toBe("stored-refresh");
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

  // 2026-11-02 scale audit (jobs, token refresh): a 401 flags the connection
  // only when the stored tokens are still the ones the rejected call sent. When
  // another process refreshed them (or the user reconnected) meanwhile, nothing is
  // flagged and the call fails with the plain, retryable CONNECTION_TOKEN_CHANGED.
  describe("401 reconnect flags are guarded by the rejected tokens", () => {
    const unauthorized = () => new Response("{}", { status: 401 });
    const rotated = { accessToken: "rotated-access-token", refreshToken: "refresh-abc" };

    it.each([
      ["image register", "image/jpeg", { register: unauthorized }],
      ["video register", "video/mp4", { register: unauthorized }],
      ["ugcPosts", "image/jpeg", { post: unauthorized }],
    ] as const)("%s 401 with unchanged tokens flags and throws LINKEDIN_RECONNECT_REQUIRED", async (_site, mime, routes) => {
      stubLinkedIn(routes);

      const error = await failure(linkedinClient.publishVideo(ctx(mime)));

      expect(error?.code).toBe("LINKEDIN_RECONNECT_REQUIRED");
      expect(updateMock).toHaveBeenCalledTimes(1);
      const arg = updateMock.mock.calls[0][0] as { where: { id: string }; data: Record<string, unknown> };
      expect(arg.where).toEqual({ id: "conn-li" });
      expect(arg.data.needsReconnect).toBe(true);
      expect(arg.data.lastRefreshErrorCode).toBe("LINKEDIN_RECONNECT_REQUIRED");
    });

    it.each([
      ["image register", "image/jpeg", { register: unauthorized }],
      ["video register", "video/mp4", { register: unauthorized }],
      ["ugcPosts", "image/jpeg", { post: unauthorized }],
    ] as const)("%s 401 with changed tokens throws CONNECTION_TOKEN_CHANGED and flags nothing", async (_site, mime, routes) => {
      findUniqueMock.mockResolvedValue(rotated);
      stubLinkedIn(routes);

      const error = await failure(linkedinClient.publishVideo(ctx(mime)));

      expect(error?.code).toBe("CONNECTION_TOKEN_CHANGED");
      expect(error?.message).toBe(
        "This connection was refreshed or reconnected while publishing. Please retry.",
      );
      expect(updateMock).not.toHaveBeenCalled();
    });

    it("compares against the tokens this publish used, read from the row it was handed", async () => {
      stubLinkedIn({ register: unauthorized });

      await failure(linkedinClient.publishVideo(ctx("image/jpeg")));

      expect(findUniqueMock).toHaveBeenCalledWith({
        where: { id: "conn-li" },
        select: { accessToken: true, refreshToken: true },
      });
    });
  });

  // 2026-11-02 scale audit (jobs): ugcPosts answers 201 with the post id in
  // the `x-restli-id` header (https://learn.microsoft.com/en-us/linkedin/compliance/integrations/shares/ugc-post-api).
  // The header wins; the body `id` is read only when the header is absent; a 2xx
  // with neither is PUBLISH_UNCONFIRMED (the platform said "created").
  describe("2xx ugcPosts id", () => {
    const ugcPostCalls = (fetchMock: ReturnType<typeof stubLinkedIn>) =>
      fetchMock.mock.calls.filter((c) => String(c[0]).includes("/v2/ugcPosts"));

    it("201 with the x-restli-id header and an EMPTY body is a success", async () => {
      stubLinkedIn({
        post: () =>
          new Response("", { status: 201, headers: { "x-restli-id": "urn:li:share:1" } }),
      });

      await expect(linkedinClient.publishVideo(ctx("image/jpeg"))).resolves.toEqual({
        externalPostId: "urn:li:share:1",
      });
    });

    it("prefers the header over a body id", async () => {
      stubLinkedIn({
        post: () =>
          new Response(JSON.stringify({ id: "urn:li:share:body" }), {
            status: 201,
            headers: { "x-restli-id": "urn:li:share:header" },
          }),
      });

      await expect(linkedinClient.publishVideo(ctx("image/jpeg"))).resolves.toEqual({
        externalPostId: "urn:li:share:header",
      });
    });

    it("falls back to the body id when the header is absent", async () => {
      stubLinkedIn({
        post: () => new Response(JSON.stringify({ id: "urn:li:share:body" }), { status: 201 }),
      });

      await expect(linkedinClient.publishVideo(ctx("image/jpeg"))).resolves.toEqual({
        externalPostId: "urn:li:share:body",
      });
    });

    it.each([
      ["no header and {}", () => new Response("{}", { status: 201 })],
      ["no header and an empty id", () => new Response(JSON.stringify({ id: "" }), { status: 201 })],
      ["no header and a numeric id", () => new Response(JSON.stringify({ id: 7 }), { status: 201 })],
      ["no header and a JSON null body", () => new Response("null", { status: 201 })],
      [
        "an empty header and {}",
        () => new Response("{}", { status: 201, headers: { "x-restli-id": "" } }),
      ],
    ] as const)("a 2xx ugcPosts with %s -> PUBLISH_UNCONFIRMED, requested once", async (_name, make) => {
      const fetchMock = stubLinkedIn({ post: make });

      const error = await failure(linkedinClient.publishVideo(ctx("image/jpeg")));

      expect(error?.code).toBe("PUBLISH_UNCONFIRMED");
      expect(error?.message).toBe(PUBLISH_UNCONFIRMED_MESSAGE);
      expect(ugcPostCalls(fetchMock)).toHaveLength(1);
    });
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

    // Final review F4 (I2): a 2xx ugcPosts means the post may be live, so a
    // success body that cannot be read or parsed is PUBLISH_UNCONFIRMED.
    it.each([
      ["invalid JSON", () => new Response("<html>ok</html>", { status: 201 })],
      [
        "a body that errors mid-read",
        () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.error(new TypeError("terminated"));
              },
            }),
            { status: 201 },
          ),
      ],
    ] as const)("a 2xx ugcPosts with %s -> PUBLISH_UNCONFIRMED, requested once", async (_name, make) => {
      const fetchMock = stubLinkedIn({ post: make });

      const error = await failure(linkedinClient.publishVideo(ctx("image/jpeg")));

      expect(error?.code).toBe("PUBLISH_UNCONFIRMED");
      expect(error?.message).toBe(PUBLISH_UNCONFIRMED_MESSAGE);
      expect(ugcPostCalls(fetchMock)).toHaveLength(1);
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

// 2026-11-02 scale audit (jobs B3): a video above 50 MiB on a platform listed in
// LARGE_UPLOAD_PLATFORMS is registered as a MULTIPART_UPLOAD, read from storage one part at a
// time (the byte ranges LinkedIn returns), PUT to LinkedIn's part URLs without a token, completed
// with the ETags, and posted only once the asset is AVAILABLE - all across steps. No real
// LinkedIn endpoint, Blob or database is touched: every request goes through a stubbed global
// `fetch`, the upload state is an in-memory store and the clock is fake.
describe("linkedinClient.publishVideo — multipart upload across steps (jobs B3)", () => {
  // The vendor values and budgets as plain numbers, so these tests check the constants instead of
  // sharing them (the first test below pins each constant to its number).
  const MINUTE = 60_000;
  const HOUR = 3_600_000;
  const NOW = Date.parse("2026-11-02T10:00:00.000Z");
  const STEP = PUBLISH_STEP_BUDGET_MS;
  const CHUNK_WINDOW = 60_000;
  const URL_SAFETY = 300_000;
  const POLL = 60_000;
  const MAX_WAIT = 600_000;
  const RESUME_DELAY = 30_000;
  const POST_WINDOW = 35_000;
  const MAX_PART = 67_108_864;
  const MULTIPART = "com.linkedin.digitalmedia.uploading.MultipartUpload";
  const API = "https://api.linkedin.com/v2";
  const VIDEO_RECIPE = "urn:li:digitalmediaRecipe:feedshare-video";

  /** 50 MiB + 5 bytes: just above the threshold. LinkedIn's answer decides the parts, not us. */
  const TOTAL = 52_428_805;
  type Range = { first: number; last: number };
  const RANGES: Range[] = [
    { first: 0, last: 19_999_999 },
    { first: 20_000_000, last: 39_999_999 },
    { first: 40_000_000, last: TOTAL - 1 },
  ];
  const ETAGS = ["e1", "e2", "e3"];

  // Recognisable capability values, so a leak into saved state, a log, a return value or an error is easy to find.
  const SECRET_FRAGMENTS = ["part-secret", "meta-secret", "upload.linkedin.example", "/dms-uploads/"];

  type LiError = Error & { code?: string; status?: number; retryAt?: number | null; cause?: unknown };
  type Call = Parameters<typeof fetch>;
  type Req = { url: string; init: RequestInit };
  type Reply = (req: Req) => Response | Promise<Response>;
  type Route = "register" | "part" | "complete" | "status" | "post" | "single";

  const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json", ...headers },
    });
  const reply =
    (status: number, body: string | null = null, headers: Record<string, string> = {}): Reply =>
    () =>
      new Response(body, { status, headers });
  const failWith =
    (error: unknown): Reply =>
    () =>
      Promise.reject(error);
  const timeoutFailure = () =>
    failWith(Object.assign(new Error("Request timed out after 120000ms"), { code: "FETCH_TIMEOUT" }));
  const connectionReset = () => failWith(new TypeError("fetch failed", { cause: { code: "ECONNRESET" } }));
  const terminated = () => failWith(new TypeError("terminated"));

  /** The clock moves while a request is in flight. */
  const advance = (ms: number) => vi.setSystemTime(Date.now() + ms);
  const after =
    (ms: number, next: Reply): Reply =>
    (req) => {
      advance(ms);
      return next(req);
    };

  // --- the fake LinkedIn ----------------------------------------------------------------------

  const assetUrn = (n = 1) => `urn:li:digitalmediaAsset:ASSET${n}`;
  const artifactUrn = (n = 1) =>
    `urn:li:digitalmediaMediaArtifact:(${assetUrn(n)},urn:li:digitalmediaMediaArtifactClass:uploadedVideo)`;
  const metadataOf = (n = 1) => `meta-secret-${n}-eyJidWNrZXQ`;
  const partUrl = (index: number, range: Range, n = 1) =>
    `https://upload.linkedin.example/dms-uploads/ASSET${n}/uploadedVideo?sau=part-secret-${n}-${index}&pn=${index + 1}&first=${range.first}`;
  const partHeaders = (index: number) => ({
    "Content-Type": "application/octet-stream",
    "x-part": String(index + 1),
  });

  type RegisterOptions = {
    n?: number;
    ranges?: Range[];
    expiresAt?: number | number[];
    /** undefined: the default; null: leave the field out. */
    metadata?: unknown;
  };
  function registerJson(opts: RegisterOptions = {}) {
    const n = opts.n ?? 1;
    const ranges = opts.ranges ?? RANGES;
    const metadata = opts.metadata === undefined ? metadataOf(n) : opts.metadata;
    return {
      value: {
        uploadMechanism: {
          [MULTIPART]: {
            partUploadRequests: ranges.map((range, index) => ({
              url: partUrl(index, range, n),
              byteRange: { firstByte: range.first, lastByte: range.last },
              headers: partHeaders(index),
              urlExpiresAt: Array.isArray(opts.expiresAt) ? opts.expiresAt[index] : (opts.expiresAt ?? NOW + HOUR),
            })),
            ...(metadata === null ? {} : { metadata }),
          },
        },
        asset: assetUrn(n),
        mediaArtifact: artifactUrn(n),
      },
    };
  }
  const registerReply =
    (opts: RegisterOptions = {}): Reply =>
    () =>
      json(registerJson(opts));
  /** The register answer, changed by `mutate` (to build the unusable ones). */
  const registerWith =
    (mutate: (body: ReturnType<typeof registerJson>) => void): Reply =>
    () => {
      const body = registerJson();
      mutate(body);
      return json(body);
    };

  const SINGLE_URL = "https://upload.linkedin.example/single?sau=single-secret";
  const singleRegisterReply: Reply = () =>
    json({
      value: {
        asset: "urn:li:digitalmediaAsset:SINGLE",
        uploadMechanism: {
          "com.linkedin.digitalmedia.uploading.MediaUploadHttpRequest": { uploadUrl: SINGLE_URL, headers: {} },
        },
      },
    });

  const pnOf = (url: string) => Number(new URL(url).searchParams.get("pn"));
  const partOk = (url: string, etag?: string) =>
    new Response(null, { status: 200, headers: { ETag: etag ?? `e${pnOf(url)}` } });
  const statusReply =
    (status: string, recipe = VIDEO_RECIPE): Reply =>
    () =>
      json({ id: "ASSET1", recipes: [{ recipe, status }], status: "ALLOWED" });
  const postOk: Reply = () => new Response(null, { status: 201, headers: { "x-restli-id": "urn:li:share:77" } });

  /** The byte the fake blob holds at absolute position `p` (constant inside each million bytes: cheap to make). */
  const byteAt = (p: number) => Math.floor(p / 1_000_000) % 251;
  const streams = { opened: 0, cancelled: 0 };

  /** Bytes `start..total-1` of the video, produced only when the reader asks (no read-ahead). */
  function lazyBlobBody(start: number, total: number) {
    let position = start;
    streams.opened += 1;
    return new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          if (position >= total) {
            controller.close();
            return;
          }
          const size = Math.min(1_000_000 - (position % 1_000_000), total - position);
          controller.enqueue(new Uint8Array(size).fill(byteAt(position)));
          position += size;
        },
        cancel() {
          streams.cancelled += 1;
        },
      },
      { highWaterMark: 0 },
    );
  }

  const headersOf = (init?: RequestInit) => (init?.headers ?? {}) as Record<string, string>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const bodyOf = (call: Call | undefined) => JSON.parse(String((call?.[1] as RequestInit).body)) as Record<string, any>;

  const labelOf = (call: Call): Route | "blob" | "?" => {
    const url = String(call[0]);
    if (url.includes("blob.example.com")) return "blob";
    if (url.includes("/dms-uploads/")) return "part";
    if (url === `${API}/assets?action=registerUpload`) return "register";
    if (url === `${API}/assets?action=completeMultiPartUpload`) return "complete";
    if (url.startsWith(`${API}/assets/`)) return "status";
    if (url === `${API}/ugcPosts`) return "post";
    if (url.startsWith("https://upload.linkedin.example/single")) return "single";
    return "?";
  };

  /** What a part PUT carried (its body is dropped from the mock afterwards: a part is megabytes). */
  type PutRecord = { url: string; headers: Record<string, string>; length: number; intact: boolean };

  /** Does `body` hold the video's bytes from absolute position `first`? Checks both ends and a spread of samples. */
  function bodyIsIntact(body: Uint8Array, first: number): boolean {
    const positions = [0, body.length - 1];
    for (let i = 99_991; i < body.length; i += 99_991) positions.push(i);
    return positions.every((i) => body[i] === byteAt(first + i));
  }

  /**
   * Fakes the blob, the Assets API and ugcPosts. Each route has a script of answers (used in order);
   * when it runs out, the route's default answers.
   */
  function stubLinkedIn(
    opts: {
      total?: number;
      register?: Reply[];
      part?: Reply[];
      complete?: Reply[];
      status?: Reply[];
      post?: Reply[];
      defaults?: Partial<Record<Route, Reply>>;
      blobStatus?: number;
      /** The blob answers after this long. */
      blobAdvance?: number;
      /** The blob's answer says it holds this many bytes. */
      blobClaimsTotal?: number;
      /** The blob's body hands out a little, then fails with this (the connection dropped mid-body). */
      blobBodyFailure?: unknown;
    } = {},
  ) {
    const total = opts.total ?? TOTAL;
    const scripts: Record<Route, Reply[]> = {
      register: [...(opts.register ?? [])],
      part: [...(opts.part ?? [])],
      complete: [...(opts.complete ?? [])],
      status: [...(opts.status ?? [])],
      post: [...(opts.post ?? [])],
      single: [],
    };
    const fallback: Record<Route, Reply> = {
      register: registerReply(),
      part: (req) => partOk(req.url),
      complete: () => json({}),
      status: statusReply("AVAILABLE"),
      post: postOk,
      single: reply(201),
      ...opts.defaults,
    };
    const puts: PutRecord[] = [];

    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      const label = labelOf([input, init]);
      if (label === "?") throw new Error(`Unexpected fetch in test: ${url}`);
      if (label === "blob") {
        if (opts.blobAdvance !== undefined) advance(opts.blobAdvance);
        if (opts.blobStatus !== undefined) return new Response(null, { status: opts.blobStatus });
        const range = /^bytes=(\d+)-$/.exec(headersOf(init)["Range"] ?? "");
        const start = range ? Number(range[1]) : 0;
        const claimed = opts.blobClaimsTotal ?? total;
        if (opts.blobBodyFailure !== undefined) {
          const bodyError = opts.blobBodyFailure;
          let sent = false;
          const body = new ReadableStream<Uint8Array>(
            {
              pull(controller) {
                if (sent) return controller.error(bodyError);
                sent = true;
                controller.enqueue(new Uint8Array(1_000));
              },
            },
            { highWaterMark: 0 },
          );
          return new Response(body, {
            status: 206,
            headers: { "Content-Range": `bytes ${start}-${claimed - 1}/${claimed}` },
          });
        }
        return range
          ? new Response(lazyBlobBody(start, total), {
              status: 206,
              headers: { "Content-Range": `bytes ${start}-${claimed - 1}/${claimed}` },
            })
          : new Response(lazyBlobBody(0, total), { status: 200, headers: { "Content-Length": String(claimed) } });
      }
      if (label === "part") {
        const body = init?.body as Uint8Array;
        puts.push({
          url,
          headers: { ...headersOf(init) },
          length: body.length,
          intact: bodyIsIntact(body, Number(new URL(url).searchParams.get("first"))),
        });
        // Let go of the megabytes: the mock keeps every request it saw.
        (init as { body?: unknown }).body = undefined;
      }
      return (scripts[label].shift() ?? fallback[label])({ url, init: init ?? {} });
    });
    vi.stubGlobal("fetch", fetchMock);

    const where = (label: string) => fetchMock.mock.calls.filter((c) => labelOf(c) === label);
    return {
      fetchMock,
      /** Every request, in order, as a label. */
      sequence: () => fetchMock.mock.calls.map(labelOf),
      blobGets: () => where("blob"),
      registers: () => where("register"),
      parts: () => where("part"),
      puts: () => puts,
      completes: () => where("complete"),
      statuses: () => where("status"),
      posts: () => where("post"),
    };
  }

  // --- the fake upload state ------------------------------------------------------------------

  type Data = {
    asset: string;
    mediaArtifact: string;
    totalBytes: number;
    partCount: number;
    nextPart: number;
    etags: string[];
    phase: "upload" | "processing";
    completedAt?: number;
    urlsExpireAt: number;
    restarts: number;
    lastStatus?: string;
  };
  type Secret = {
    parts: Array<{ url: string; firstByte: number; lastByte: number; headers: Record<string, string> }>;
    metadata: string;
  };
  type Snapshot = { data: Data; secret?: Secret };

  /** An in-memory store with the real store's rules: a kind, and a readable `data` that holds no URL. */
  function fakeStore(initial?: Snapshot) {
    let current: { kind: string; data: unknown; secret?: unknown } | null = initial
      ? { kind: LINKEDIN_UPLOAD_STATE_KIND, ...structuredClone(initial) }
      : null;
    const mocks = {
      load: vi.fn(async (kind: string) =>
        current && current.kind === kind
          ? {
              data: structuredClone(current.data),
              ...(current.secret !== undefined ? { secret: structuredClone(current.secret) } : {}),
            }
          : null,
      ),
      save: vi.fn(async (kind: string, snapshot: { data: unknown; secret?: unknown }) => {
        if ((JSON.stringify(snapshot.data) ?? "").includes("://")) {
          throw Object.assign(new Error("The upload could not be tracked."), { code: "UPLOAD_STATE_PLAINTEXT_URL" });
        }
        current = { kind, ...structuredClone(snapshot) };
      }),
      clear: vi.fn(async () => {
        current = null;
      }),
    };
    return {
      store: mocks as unknown as UploadStateStore,
      mocks,
      /** What the store holds now. */
      saved: () => current as { kind: string; data: Data; secret?: Secret } | null,
      /** Every save, in order. */
      saves: () => mocks.save.mock.calls.map((c) => c[1] as { data: Data; secret?: Secret }),
    };
  }

  /** A saved upload with `nextPart` parts behind it, registered at `NOW` (asset `n`, URLs good for an hour). */
  const uploadState = (nextPart = 0, over: Partial<Data> = {}, n = 1): Snapshot => ({
    data: {
      asset: assetUrn(n),
      mediaArtifact: artifactUrn(n),
      totalBytes: TOTAL,
      partCount: 3,
      nextPart,
      etags: ETAGS.slice(0, nextPart),
      phase: "upload",
      urlsExpireAt: NOW + HOUR,
      restarts: 0,
      ...over,
    },
    secret: {
      parts: RANGES.map((range, index) => ({
        url: partUrl(index, range, n),
        firstByte: range.first,
        lastByte: range.last,
        headers: partHeaders(index),
      })),
      metadata: metadataOf(n),
    },
  });
  /** Every part is in, the upload was completed `completedAgoMs` ago, and LinkedIn is still processing. */
  const processingState = (completedAgoMs = 0, over: Partial<Data> = {}): Snapshot => ({
    data: {
      ...uploadState(3).data,
      phase: "processing",
      completedAt: NOW - completedAgoMs,
      ...over,
    },
  });

  function bigCtx(
    store: UploadStateStore | undefined,
    overrides: Partial<PublishContext> = {},
    sizeBytes = TOTAL,
    mimeType = "video/mp4",
  ): PublishContext {
    return {
      user: { id: "user-1" } as unknown as User,
      socialConnection: makeConnection({ id: "conn-li", expiresAt: new Date(Date.now() + 3_600_000) }),
      mediaItem: {
        id: "media-1",
        mimeType,
        storageLocation: "https://blob.example.com/clip.mp4",
        sizeBytes,
        originalFilename: "clip.mp4",
      } as unknown as MediaItem,
      caption: "hello",
      uploadState: store,
      deadline: Date.now() + STEP,
      ...overrides,
    };
  }

  const run = (c: PublishContext) => linkedinClient.publishVideo(c);
  const failure = (c: PublishContext) =>
    linkedinClient.publishVideo(c).then(
      () => null,
      (e: unknown) => e as LiError,
    );
  const paused = (resumeAt: number | null = null) => ({ continuation: { resumeAt } });

  /** Every console call of the test (the logger writes through console), as one string. */
  const everythingLogged = () =>
    JSON.stringify(
      (["log", "info", "warn", "error", "debug"] as const).map((level) => vi.mocked(console[level]).mock.calls),
    );
  const describeError = (error: unknown) => {
    const e = error as LiError | null;
    return JSON.stringify({
      name: e?.name,
      message: e?.message,
      stack: e?.stack,
      code: e?.code,
      status: e?.status,
      cause: String(e?.cause),
    });
  };
  function expectNoCapabilityValues(...texts: string[]) {
    for (const text of texts) {
      for (const fragment of SECRET_FRAGMENTS) expect(text).not.toContain(fragment);
    }
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(NOW);
    vi.stubEnv("LARGE_UPLOAD_PLATFORMS", "linkedin");
    streams.opened = 0;
    streams.cancelled = 0;
    for (const level of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, level).mockImplementation(() => {});
    }
  });

  afterEach(() => {
    // The stubbed fetch keeps every request it saw.
    vi.clearAllMocks();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("pins the vendor values, the budgets and the saved-state kind", () => {
    expect(LINKEDIN_UPLOAD_STATE_KIND).toBe("linkedin_multipart");
    expect(LINKEDIN_URL_EXPIRY_SAFETY_MS).toBe(URL_SAFETY);
    expect(LINKEDIN_ASSET_POLL_INTERVAL_MS).toBe(POLL);
    expect(LINKEDIN_ASSET_MAX_WAIT_MS).toBe(MAX_WAIT);
    expect(LINKEDIN_TRANSIENT_RESUME_DELAY_MS).toBe(RESUME_DELAY);
    expect(LINKEDIN_POST_MIN_WINDOW_MS).toBe(POST_WINDOW);
    expect(LINKEDIN_MAX_UPLOAD_RESTARTS).toBe(2);
    expect(LARGE_UPLOAD_CHUNK_WINDOW_MS).toBe(CHUNK_WINDOW);
    expect(LARGE_UPLOAD_MAX_PART_BYTES).toBe(MAX_PART);
    expect(TOTAL).toBeGreaterThan(LARGE_VIDEO_THRESHOLD_BYTES);
  });

  describe("which path a post takes", () => {
    it("keeps today's whole-file upload when LinkedIn is not enabled (the default), request for request", async () => {
      vi.stubEnv("LARGE_UPLOAD_PLATFORMS", "");
      const { store, mocks } = fakeStore();
      const li = stubLinkedIn({ total: 4, register: [singleRegisterReply] });

      const result = await run(bigCtx(store));

      expect(result).toEqual({ externalPostId: "urn:li:share:77" });
      expect(mocks.save).not.toHaveBeenCalled();
      expect(li.sequence()).toEqual(["blob", "register", "single", "post"]);
      expect(headersOf(li.blobGets()[0][1])["Range"]).toBeUndefined();
      const registration = bodyOf(li.registers()[0]).registerUploadRequest;
      expect(registration).not.toHaveProperty("supportedUploadMechanism");
      expect(registration).not.toHaveProperty("fileSize");
    });

    it("keeps today's path when only other platforms are listed, for a video at or below 50 MiB, and for a caller with no store", async () => {
      vi.stubEnv("LARGE_UPLOAD_PLATFORMS", "youtube,x,tiktok");
      const { store, mocks } = fakeStore();
      const li = stubLinkedIn({ total: 4, register: [singleRegisterReply, singleRegisterReply, singleRegisterReply] });

      await run(bigCtx(store));
      vi.stubEnv("LARGE_UPLOAD_PLATFORMS", "linkedin");
      await run(bigCtx(store, {}, LARGE_VIDEO_THRESHOLD_BYTES));
      await run(bigCtx(undefined));

      expect(mocks.save).not.toHaveBeenCalled();
      expect(li.sequence()).toEqual([
        ...["blob", "register", "single", "post"],
        ...["blob", "register", "single", "post"],
        ...["blob", "register", "single", "post"],
      ]);
    });

    it("takes the multipart path for a video above 50 MiB once LinkedIn is listed", async () => {
      const { store } = fakeStore();
      const li = stubLinkedIn();

      await run(bigCtx(store));

      expect(li.sequence()[0]).toBe("register");
      expect(li.registers()).toHaveLength(1);
    });

    it("carries on an upload that has saved state even if LinkedIn was switched off meanwhile", async () => {
      vi.stubEnv("LARGE_UPLOAD_PLATFORMS", "none");
      const { store } = fakeStore(uploadState(2));
      const li = stubLinkedIn();

      const result = await run(bigCtx(store));

      expect(li.registers()).toHaveLength(0);
      expect(li.puts()).toHaveLength(1);
      expect(result).toEqual(paused(Date.now() + POLL));
    });

    it("decides between starting and resuming from the saved state alone, never from the step number", async () => {
      const resumed = fakeStore(uploadState(2));
      const first = stubLinkedIn();
      await run(bigCtx(resumed.store, { continuation: 0 }));
      expect(first.registers()).toHaveLength(0);
      expect(first.puts()).toHaveLength(1);

      vi.clearAllMocks();
      const fresh = fakeStore();
      const second = stubLinkedIn();
      await run(bigCtx(fresh.store, { continuation: 7 }));
      expect(second.registers()).toHaveLength(1);
    });

    it.each([
      ["another size", () => uploadState(1, { totalBytes: TOTAL - 1 })],
      ["a position past the last part", () => uploadState(1, { nextPart: 4 })],
      ["ETags that don't match the position", () => uploadState(2, { etags: ["e1"] })],
      ["an unknown phase", () => uploadState(1, { phase: "weird" as unknown as "upload" })],
      ["an asset that is not an asset URN", () => uploadState(1, { asset: "garbage" })],
      [
        "no sealed secret in the upload phase",
        () => {
          const state = uploadState(1);
          delete state.secret;
          return state;
        },
      ],
      [
        "parts that don't cover the video",
        () => {
          const state = uploadState(1);
          state.secret!.parts[2].lastByte -= 1;
          return state;
        },
      ],
      [
        "a processing phase that never completed",
        () => processingState(0, { completedAt: undefined }),
      ],
    ] as const)("treats saved state with %s as no state and registers a new upload", async (_label, make) => {
      const { store } = fakeStore(make());
      const li = stubLinkedIn();

      await run(bigCtx(store));

      expect(li.registers()).toHaveLength(1);
      expect(li.puts()).toHaveLength(3);
      expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).toContain("cannot be used");
    });
  });

  describe("the first step", () => {
    it("registers a MULTIPART_UPLOAD with the file size, as the organization, with the token", async () => {
      const { store } = fakeStore();
      const li = stubLinkedIn();

      await run(bigCtx(store));

      const call = li.registers()[0];
      expect(String(call[0])).toBe(`${API}/assets?action=registerUpload`);
      expect((call[1] as RequestInit).method).toBe("POST");
      expect(headersOf(call[1])).toMatchObject({
        Authorization: "Bearer old-access-token",
        "Content-Type": "application/json",
        "X-Restli-Protocol-Version": "2.0.0",
      });
      expect(bodyOf(call)).toEqual({
        registerUploadRequest: {
          recipes: [VIDEO_RECIPE],
          owner: "urn:li:organization:123",
          serviceRelationships: [{ relationshipType: "OWNER", identifier: "urn:li:userGeneratedContent" }],
          supportedUploadMechanism: ["MULTIPART_UPLOAD"],
          fileSize: TOTAL,
        },
      });
    });

    it("saves the registration at once, before the first part: progress readable, the capability values only in the secret", async () => {
      const { store, saves, mocks } = fakeStore();
      const li = stubLinkedIn();

      await run(bigCtx(store));

      expect(saves()[0]).toEqual(uploadState(0));
      const firstPart = li.fetchMock.mock.calls.findIndex((c) => labelOf(c) === "part");
      expect(mocks.save.mock.invocationCallOrder[0]).toBeLessThan(li.fetchMock.mock.invocationCallOrder[firstPart]);
      // The readable part holds no URL and none of LinkedIn's opaque values.
      expectNoCapabilityValues(JSON.stringify(saves()[0].data));
      expect(JSON.stringify(saves()[0].data)).not.toContain("://");
      expect(JSON.stringify(saves()[0].secret)).toContain("part-secret-1-0");
      expect(JSON.stringify(saves()[0].secret)).toContain("meta-secret-1");
    });

    it("takes the earliest urlExpiresAt of the parts as the time the URLs stop being good", async () => {
      const { store, saves } = fakeStore();
      stubLinkedIn({ register: [registerReply({ expiresAt: [NOW + 3 * HOUR, NOW + 2 * HOUR, NOW + 5 * HOUR] })] });

      await run(bigCtx(store));

      expect(saves()[0].data.urlsExpireAt).toBe(NOW + 2 * HOUR);
    });

    it("sorts the parts into byte order and uploads them in it", async () => {
      const { store, saves } = fakeStore();
      const li = stubLinkedIn({
        register: [
          registerWith((body) => {
            const requests = body.value.uploadMechanism[MULTIPART].partUploadRequests;
            requests.reverse();
          }),
        ],
      });

      await run(bigCtx(store));

      expect(saves()[0].secret!.parts.map((p) => p.firstByte)).toEqual(RANGES.map((r) => r.first));
      expect(li.puts().map((p) => pnOf(p.url))).toEqual([1, 2, 3]);
    });

    it("reads the blob with one ranged GET for the step and closes it", async () => {
      const { store } = fakeStore();
      const li = stubLinkedIn();

      await run(bigCtx(store));

      expect(li.blobGets()).toHaveLength(1);
      expect(headersOf(li.blobGets()[0][1])["Range"]).toBe("bytes=0-");
      expect(streams.opened).toBe(1);
      expect(streams.cancelled).toBe(1);
    });
  });

  describe("the parts", () => {
    it("PUTs exactly each part's byte range, with that part's own headers and no Authorization", async () => {
      const { store } = fakeStore();
      const li = stubLinkedIn();

      await run(bigCtx(store));

      const puts = li.puts();
      expect(puts.map((p) => p.length)).toEqual(RANGES.map((r) => r.last - r.first + 1));
      expect(puts.every((p) => p.intact)).toBe(true);
      expect(puts.map((p) => p.url)).toEqual(RANGES.map((r, i) => partUrl(i, r)));
      expect(puts.map((p) => p.headers)).toEqual([0, 1, 2].map(partHeaders));
      for (const call of li.parts()) {
        expect((call[1] as RequestInit).method).toBe("PUT");
        expect(Object.keys(headersOf(call[1])).map((k) => k.toLowerCase())).not.toContain("authorization");
      }
    });

    it("never sends an Authorization header LinkedIn put among a part's headers", async () => {
      const { store } = fakeStore();
      const li = stubLinkedIn({
        register: [
          registerWith((body) => {
            const requests = body.value.uploadMechanism[MULTIPART].partUploadRequests as Array<Record<string, unknown>>;
            requests[0].headers = { "Content-Type": "application/octet-stream", Authorization: "Bearer leaked" };
          }),
        ],
      });

      await run(bigCtx(store));

      expect(li.puts()[0].headers).toEqual({ "Content-Type": "application/octet-stream" });
    });

    it("saves the position and the ETag after every part", async () => {
      const { store, saves } = fakeStore();
      stubLinkedIn();

      await run(bigCtx(store));

      expect(saves().slice(0, 4).map((s) => [s.data.nextPart, s.data.etags])).toEqual([
        [0, []],
        [1, ["e1"]],
        [2, ["e1", "e2"]],
        [3, ["e1", "e2", "e3"]],
      ]);
      expect(saves()[3].data.phase).toBe("upload");
    });

    it("accepts a part of exactly 64 MiB", async () => {
      const total = 70_000_000;
      const { store } = fakeStore();
      const li = stubLinkedIn({
        total,
        register: [
          registerReply({
            ranges: [
              { first: 0, last: MAX_PART - 1 },
              { first: MAX_PART, last: total - 1 },
            ],
          }),
        ],
      });

      await run(bigCtx(store, {}, total));

      expect(li.puts().map((p) => p.length)).toEqual([MAX_PART, total - MAX_PART]);
      expect(li.puts().every((p) => p.intact)).toBe(true);
    });

    it("refuses a part larger than 64 MiB before reading the video or sending a byte", async () => {
      const total = 70_000_000;
      const { store, mocks } = fakeStore();
      const li = stubLinkedIn({
        total,
        register: [
          registerReply({
            ranges: [
              { first: 0, last: MAX_PART },
              { first: MAX_PART + 1, last: total - 1 },
            ],
          }),
        ],
      });

      const error = await failure(bigCtx(store, {}, total));

      expect(error?.code).toBe("LINKEDIN_VIDEO_UPLOAD_FAILED");
      expect(error?.message).toContain("64 MiB");
      expect(li.sequence()).toEqual(["register"]);
      expect(mocks.save).not.toHaveBeenCalled();
      expectNoCapabilityValues(describeError(error), everythingLogged());
    });

    it.each([
      ["no parts", () => registerReply({ ranges: [] })],
      ["no metadata", () => registerReply({ metadata: null })],
      ["an empty metadata", () => registerReply({ metadata: "" })],
      [
        "a gap between two parts",
        () =>
          registerReply({
            ranges: [RANGES[0], { first: RANGES[1].first + 1, last: RANGES[1].last }, RANGES[2]],
          }),
      ],
      ["parts that end short of the video", () => registerReply({ ranges: RANGES.slice(0, 2) })],
      [
        "parts that run past the video",
        () => registerReply({ ranges: [RANGES[0], RANGES[1], { first: RANGES[2].first, last: TOTAL }] }),
      ],
      [
        "a part that starts after its end",
        () => registerReply({ ranges: [RANGES[0], { first: 20_000_000, last: 19_999_999 }, RANGES[2]] }),
      ],
      [
        "a part URL that is not https",
        () => registerWith((body) => {
          const requests = body.value.uploadMechanism[MULTIPART].partUploadRequests as Array<Record<string, unknown>>;
          requests[1].url = "http://upload.linkedin.example/dms-uploads/ASSET1/uploadedVideo?sau=part-secret-1-1&pn=2";
        }),
      ],
      [
        "a part with no urlExpiresAt",
        () => registerWith((body) => {
          const requests = body.value.uploadMechanism[MULTIPART].partUploadRequests as Array<Record<string, unknown>>;
          delete requests[2].urlExpiresAt;
        }),
      ],
      [
        "an asset that is not an asset URN",
        () => registerWith((body) => {
          body.value.asset = "garbage";
        }),
      ],
      [
        "no media artifact",
        () => registerWith((body) => {
          (body.value as Record<string, unknown>).mediaArtifact = "";
        }),
      ],
      ["a single-request answer instead of a multipart one", () => singleRegisterReply],
      ["a body that is not JSON", () => reply(200, "<html>ok</html>")],
    ] as const)("fails LINKEDIN_VIDEO_UPLOAD_FAILED, sending and saving nothing, for a registration with %s", async (_label, make) => {
      const { store, mocks } = fakeStore();
      const li = stubLinkedIn({ register: [make() as Reply] });

      const error = await failure(bigCtx(store));

      expect(error?.code).toBe("LINKEDIN_VIDEO_UPLOAD_FAILED");
      expect(li.sequence()).toEqual(["register"]);
      expect(mocks.save).not.toHaveBeenCalled();
      expectNoCapabilityValues(describeError(error), everythingLogged());
    });
  });

  describe("across steps", () => {
    const slowPart: Reply = after(STEP - 50_000, (req) => partOk(req.url));

    it("uploads two parts in the first step (50 s left is too little for another) and the third in the next, then completes", async () => {
      const { store, saved } = fakeStore();
      const li = stubLinkedIn({ part: [(req) => partOk(req.url), slowPart] });

      const first = await run(bigCtx(store));

      expect(first).toEqual(paused(null));
      expect(li.sequence()).toEqual(["register", "blob", "part", "part"]);
      expect(saved()?.data).toMatchObject({ nextPart: 2, etags: ["e1", "e2"], phase: "upload" });

      const second = await run(bigCtx(store));

      expect(second).toEqual(paused(Date.now() + POLL));
      expect(li.sequence().slice(4)).toEqual(["blob", "part", "complete"]);
      expect(li.registers()).toHaveLength(1);
      expect(headersOf(li.blobGets()[1][1])["Range"]).toBe("bytes=40000000-");
      expect(li.puts().map((p) => pnOf(p.url))).toEqual([1, 2, 3]);
      expect(li.puts().every((p) => p.intact)).toBe(true);
      expect(saved()?.data).toMatchObject({ nextPart: 3, phase: "processing" });
    });

    it("starts a part with exactly 60 s left, and not with a millisecond less", async () => {
      const exact = fakeStore(uploadState(2));
      const exactLi = stubLinkedIn();
      await run(bigCtx(exact.store, { deadline: Date.now() + CHUNK_WINDOW }));
      expect(exactLi.puts()).toHaveLength(1);

      vi.clearAllMocks();
      const short = fakeStore(uploadState(2));
      const shortLi = stubLinkedIn();
      const result = await run(bigCtx(short.store, { deadline: Date.now() + CHUNK_WINDOW - 1 }));
      expect(result).toEqual(paused(null));
      expect(shortLi.sequence()).toEqual([]);
      expect(short.saved()?.data.nextPart).toBe(2);
    });

    it("pauses instead of failing when reading the part ran the step out of time", async () => {
      const { store, saved } = fakeStore(uploadState(1));
      const li = stubLinkedIn({ blobAdvance: STEP - 30_000 });

      const result = await run(bigCtx(store));

      expect(result).toEqual(paused(null));
      expect(li.sequence()).toEqual(["blob"]);
      expect(saved()?.data.nextPart).toBe(1);
    });

    it("pauses 30 s, with the saved place intact, when the blob's body drops part-way through (nothing was sent)", async () => {
      const { store, saved } = fakeStore(uploadState(1));
      const li = stubLinkedIn({ blobBodyFailure: new TypeError("terminated") });

      const result = await run(bigCtx(store));

      expect(result).toEqual(paused(NOW + RESUME_DELAY));
      expect(li.sequence()).toEqual(["blob"]);
      expect(saved()).toEqual({ kind: LINKEDIN_UPLOAD_STATE_KIND, ...uploadState(1) });
    });

    it("pauses at once, not 30 s later, when the blob's body is cut off by the step deadline", async () => {
      const { store, saved } = fakeStore(uploadState(1));
      const li = stubLinkedIn({
        blobAdvance: STEP - 30_000,
        blobBodyFailure: new DOMException("The operation was aborted due to timeout", "TimeoutError"),
      });

      const result = await run(bigCtx(store));

      expect(result).toEqual(paused(null));
      expect(li.puts()).toHaveLength(0);
      expect(saved()?.data.nextPart).toBe(1);
    });

    it("fails a video the blob cannot serve (nothing was sent)", async () => {
      const { store } = fakeStore(uploadState(1));
      const li = stubLinkedIn({ blobStatus: 500 });

      const error = await failure(bigCtx(store));

      expect(error?.code).toBe("BLOB_READ_FAILED");
      expect(li.puts()).toHaveLength(0);
    });

    it("fails MEDIA_SIZE_MISMATCH when the blob is not the size recorded for the media", async () => {
      const { store } = fakeStore(uploadState(1));
      const li = stubLinkedIn({ blobClaimsTotal: TOTAL + 1 });

      const error = await failure(bigCtx(store));

      expect(error?.code).toBe("MEDIA_SIZE_MISMATCH");
      expect(li.puts()).toHaveLength(0);
    });

    it("runs a 300 MiB video through to the post in a handful of steps, within the continuation limit", { timeout: 60_000 }, async () => {
      const partBytes = 4_194_304;
      const parts = 75;
      const total = parts * partBytes;
      const ranges = Array.from({ length: parts }, (_, i) => ({ first: i * partBytes, last: (i + 1) * partBytes - 1 }));
      const { store, saved } = fakeStore();
      const li = stubLinkedIn({
        total,
        register: [registerReply({ ranges })],
        // Each part takes 3 s: 56 start before the step has under 60 s left, the other 19 follow.
        defaults: { part: after(3_000, (req) => partOk(req.url)) },
        status: [statusReply("PROCESSING"), statusReply("PROCESSING")],
      });

      const results: Array<{ externalPostId?: string | null; continuation?: { resumeAt: number | null } }> = [];
      for (let step = 0; step <= MAX_CONTINUATIONS_PER_RESULT; step += 1) {
        const result = await run(bigCtx(store, {}, total));
        results.push(result);
        if (!result.continuation) break;
        const resumeAt = result.continuation.resumeAt;
        if (resumeAt !== null && resumeAt > Date.now()) vi.setSystemTime(resumeAt);
      }

      // Step 0 and the continuations after it: parts 0-55, parts 56-74 + complete, two PROCESSING checks, then AVAILABLE.
      expect(results.map((r) => (r.continuation ? "continue" : "done"))).toEqual([
        "continue",
        "continue",
        "continue",
        "continue",
        "done",
      ]);
      expect(results.length - 1).toBeLessThanOrEqual(MAX_CONTINUATIONS_PER_RESULT);
      expect(results.at(-1)).toEqual({ externalPostId: "urn:li:share:77" });
      expect(li.registers()).toHaveLength(1);
      expect(li.puts()).toHaveLength(parts);
      expect(li.puts().every((p) => p.length === partBytes && p.intact)).toBe(true);
      expect(li.completes()).toHaveLength(1);
      const etags = bodyOf(li.completes()[0]).completeMultipartUploadRequest.partUploadResponses.map(
        (r: { headers: { ETag: string } }) => r.headers.ETag,
      );
      expect(etags).toEqual(Array.from({ length: parts }, (_, i) => `e${i + 1}`));
      expect(li.statuses()).toHaveLength(3);
      expect(li.posts()).toHaveLength(1);
      expect(saved()?.data.phase).toBe("processing");
    });
  });

  describe("completing the upload", () => {
    it("sends the ETags in part order with the artifact and metadata, as the account", async () => {
      const { store } = fakeStore();
      const li = stubLinkedIn();

      await run(bigCtx(store));

      expect(li.completes()).toHaveLength(1);
      const call = li.completes()[0];
      expect(String(call[0])).toBe(`${API}/assets?action=completeMultiPartUpload`);
      expect((call[1] as RequestInit).method).toBe("POST");
      expect(headersOf(call[1])).toMatchObject({
        Authorization: "Bearer old-access-token",
        "Content-Type": "application/json",
        "X-Restli-Protocol-Version": "2.0.0",
      });
      expect(bodyOf(call)).toEqual({
        completeMultipartUploadRequest: {
          mediaArtifact: artifactUrn(),
          metadata: metadataOf(),
          partUploadResponses: [
            { headers: { ETag: "e1" }, httpStatusCode: 200 },
            { headers: { ETag: "e2" }, httpStatusCode: 200 },
            { headers: { ETag: "e3" }, httpStatusCode: 200 },
          ],
        },
      });
      // Only after the last part's answer.
      expect(li.sequence().slice(-2)).toEqual(["part", "complete"]);
    });

    it("keeps each ETag exactly as LinkedIn sent it, quotes included", async () => {
      const { store } = fakeStore();
      const li = stubLinkedIn({
        part: [1, 2, 3].map((n): Reply => (req) => partOk(req.url, `"abc-${n}"`)),
      });

      await run(bigCtx(store));

      const sent = bodyOf(li.completes()[0]).completeMultipartUploadRequest.partUploadResponses;
      expect(sent.map((r: { headers: { ETag: string } }) => r.headers.ETag)).toEqual(['"abc-1"', '"abc-2"', '"abc-3"']);
    });

    it("moves to the processing phase and drops the part URLs and metadata from the saved state", async () => {
      const { store, saves, saved } = fakeStore();
      stubLinkedIn();

      const result = await run(bigCtx(store));

      expect(result).toEqual(paused(NOW + POLL));
      const last = saves().at(-1)!;
      expect(last).toEqual({ data: processingState(0).data });
      expect(last).not.toHaveProperty("secret");
      expect(saved()?.secret).toBeUndefined();
    });

    it("does not complete, post or ask for the status before the parts are all in", async () => {
      const { store } = fakeStore();
      const li = stubLinkedIn({ part: [(req) => partOk(req.url), after(STEP - 50_000, (req) => partOk(req.url))] });

      await run(bigCtx(store));

      expect(li.completes()).toHaveLength(0);
      expect(li.statuses()).toHaveLength(0);
      expect(li.posts()).toHaveLength(0);
    });

    it("sends a complete that is not the commit call only with 60 s left; else the next step does it", async () => {
      const { store, saved } = fakeStore(uploadState(3));
      const li = stubLinkedIn();

      const result = await run(bigCtx(store, { deadline: Date.now() + CHUNK_WINDOW - 1 }));

      expect(result).toEqual(paused(null));
      expect(li.sequence()).toEqual([]);
      expect(saved()?.data).toMatchObject({ nextPart: 3, phase: "upload" });

      const next = await run(bigCtx(store));
      expect(next).toEqual(paused(Date.now() + POLL));
      expect(li.sequence()).toEqual(["complete"]);
    });

    it("a 401 flags the connection when its tokens are unchanged", async () => {
      const { store } = fakeStore(uploadState(3));
      stubLinkedIn({ complete: [reply(401, "{}")] });

      const error = await failure(bigCtx(store));

      expect(error?.code).toBe("LINKEDIN_RECONNECT_REQUIRED");
      expect(updateMock).toHaveBeenCalledTimes(1);
      const arg = updateMock.mock.calls[0][0] as { where: { id: string }; data: Record<string, unknown> };
      expect(arg.where).toEqual({ id: "conn-li" });
      expect(arg.data.needsReconnect).toBe(true);
      expect(arg.data.lastRefreshErrorCode).toBe("LINKEDIN_RECONNECT_REQUIRED");
    });

    it("a 401 flags nothing, and is the plain retryable CONNECTION_TOKEN_CHANGED, when the tokens changed meanwhile", async () => {
      findUniqueMock.mockResolvedValue({ accessToken: "rotated-access-token", refreshToken: "refresh-abc" });
      const { store } = fakeStore(uploadState(3));
      stubLinkedIn({ complete: [reply(401, "{}")] });

      const error = await failure(bigCtx(store));

      expect(error?.code).toBe("CONNECTION_TOKEN_CHANGED");
      expect(updateMock).not.toHaveBeenCalled();
    });

    it("a 4xx fails LINKEDIN_VIDEO_UPLOAD_FAILED before any post (the unconfirmed /v2 completeMultiPartUpload)", async () => {
      const { store, saved } = fakeStore(uploadState(3));
      const li = stubLinkedIn({ complete: [reply(400, JSON.stringify({ message: "bad request" }))] });

      const error = await failure(bigCtx(store));

      expect(error).toMatchObject({ code: "LINKEDIN_VIDEO_UPLOAD_FAILED", status: 400 });
      expect(li.posts()).toHaveLength(0);
      expect(saved()?.data.phase).toBe("upload");
      expectNoCapabilityValues(describeError(error));
    });

    it("a refusal logs only the HTTP status: LinkedIn's body, which could quote the metadata, reaches no log or error", async () => {
      const { store } = fakeStore(uploadState(3));
      const body = JSON.stringify({
        message: `invalid metadata ${metadataOf()}`,
        detail: partUrl(0, RANGES[0]),
      });
      stubLinkedIn({ complete: [reply(400, body)] });

      const error = await failure(bigCtx(store));

      expect(error).toMatchObject({ code: "LINKEDIN_VIDEO_UPLOAD_FAILED", status: 400 });
      expect(error?.message).toBe("LinkedIn video upload could not be completed (status 400)");
      const logged = everythingLogged();
      expect(logged).not.toContain("invalid metadata");
      expectNoCapabilityValues(describeError(error), logged);
      expect(logged).toContain('"status":400');
    });

    it("a 404 fails LINKEDIN_VIDEO_UPLOAD_FAILED too (nothing is posted)", async () => {
      const { store } = fakeStore(uploadState(3));
      const li = stubLinkedIn({ complete: [reply(404, "")] });

      expect((await failure(bigCtx(store)))?.code).toBe("LINKEDIN_VIDEO_UPLOAD_FAILED");
      expect(li.posts()).toHaveLength(0);
    });

    it("a 429 saves the position, then is RATE_LIMITED with LinkedIn's wait", async () => {
      const { store, saved } = fakeStore(uploadState(3));
      stubLinkedIn({ complete: [reply(429, "", { "Retry-After": "120" })] });

      const error = await failure(bigCtx(store));

      expect(error).toMatchObject({ code: "RATE_LIMITED", platform: "linkedin" });
      expect(error?.retryAt).toBe(NOW + 120_000);
      expect(saved()?.data).toMatchObject({ nextPart: 3, phase: "upload" });
      expect(saved()?.secret).toBeDefined();
    });

    it.each([
      ["a 503", reply(503, "busy")],
      ["a timeout", timeoutFailure()],
      ["a dropped connection", connectionReset()],
      ["a body that ends early", terminated()],
    ] as const)("%s pauses 30 s and asks again in the next step, still posting nothing", async (_label, bad) => {
      const { store, saved } = fakeStore(uploadState(3));
      const li = stubLinkedIn({ complete: [bad as Reply] });

      const result = await run(bigCtx(store));

      expect(result).toEqual(paused(NOW + RESUME_DELAY));
      expect(saved()?.data).toMatchObject({ nextPart: 3, phase: "upload" });
      expect(li.posts()).toHaveLength(0);

      const next = await run(bigCtx(store));
      expect(next).toEqual(paused(Date.now() + POLL));
      expect(li.completes()).toHaveLength(2);
    });

    it("surfaces a TypeError that is not a network failure", async () => {
      const { store } = fakeStore(uploadState(3));
      const bug = new TypeError("Cannot read properties of undefined (reading 'x')");
      stubLinkedIn({ complete: [failWith(bug)] });

      expect(await failure(bigCtx(store))).toBe(bug);
    });
  });

  describe("waiting for the asset", () => {
    it("asks GET /v2/assets/{id} with the token and continues a minute later while the asset is PROCESSING", async () => {
      const { store, saved } = fakeStore(processingState(0));
      const li = stubLinkedIn({ status: [statusReply("PROCESSING")] });

      const result = await run(bigCtx(store));

      expect(result).toEqual(paused(NOW + POLL));
      expect(li.sequence()).toEqual(["status"]);
      const call = li.statuses()[0];
      expect(String(call[0])).toBe(`${API}/assets/ASSET1`);
      expect((call[1] as RequestInit).method).toBe("GET");
      expect(headersOf(call[1])).toMatchObject({
        Authorization: "Bearer old-access-token",
        "X-Restli-Protocol-Version": "2.0.0",
      });
      expect(li.posts()).toHaveLength(0);
      expect(saved()?.data).toEqual({ ...processingState(0).data, lastStatus: "PROCESSING" });
    });

    it("posts once, in the same step, when the asset is AVAILABLE", async () => {
      const { store } = fakeStore(processingState(3 * MINUTE));
      const li = stubLinkedIn();

      const result = await run(bigCtx(store));

      expect(result).toEqual({ externalPostId: "urn:li:share:77" });
      expect(li.sequence()).toEqual(["status", "post"]);
      const call = li.posts()[0];
      expect(String(call[0])).toBe(`${API}/ugcPosts`);
      expect(headersOf(call[1])).toMatchObject({ Authorization: "Bearer old-access-token" });
      const content = bodyOf(call).specificContent["com.linkedin.ugc.ShareContent"];
      expect(bodyOf(call).author).toBe("urn:li:organization:123");
      expect(content.shareMediaCategory).toBe("VIDEO");
      expect(content.media[0].media).toBe(assetUrn());
      expect(content.shareCommentary.text).toBe("hello");
    });

    it("runs PROCESSING then AVAILABLE across two steps and posts exactly once", async () => {
      const { store } = fakeStore(processingState(0));
      const li = stubLinkedIn({ status: [statusReply("PROCESSING")] });

      const first = await run(bigCtx(store));
      vi.setSystemTime(NOW + POLL);
      const second = await run(bigCtx(store));

      expect(first).toEqual(paused(NOW + POLL));
      expect(second).toEqual({ externalPostId: "urn:li:share:77" });
      expect(li.sequence()).toEqual(["status", "status", "post"]);
    });

    it("reads the feedshare-video recipe, not another one", async () => {
      const other = "urn:li:digitalmediaRecipe:ads-video";
      const waiting = fakeStore(processingState(0));
      const li = stubLinkedIn({
        status: [
          () =>
            json({
              recipes: [
                { recipe: other, status: "AVAILABLE" },
                { recipe: VIDEO_RECIPE, status: "PROCESSING" },
              ],
            }),
        ],
      });
      expect(await run(bigCtx(waiting.store))).toEqual(paused(NOW + POLL));
      expect(li.posts()).toHaveLength(0);

      vi.clearAllMocks();
      const ready = fakeStore(processingState(0));
      const second = stubLinkedIn({
        status: [
          () =>
            json({
              recipes: [
                { recipe: other, status: "CLIENT_ERROR" },
                { recipe: VIDEO_RECIPE, status: "AVAILABLE" },
              ],
            }),
        ],
      });
      expect(await run(bigCtx(ready.store))).toEqual({ externalPostId: "urn:li:share:77" });
      expect(second.posts()).toHaveLength(1);
    });

    it.each(["CLIENT_ERROR", "SERVER_ERROR", "INCOMPLETE"])(
      "%s fails LINKEDIN_VIDEO_PROCESSING_FAILED and posts nothing",
      async (status) => {
        const { store } = fakeStore(processingState(0));
        const li = stubLinkedIn({ status: [statusReply(status)] });

        const error = await failure(bigCtx(store));

        expect(error?.code).toBe("LINKEDIN_VIDEO_PROCESSING_FAILED");
        expect(li.posts()).toHaveLength(0);
        expectNoCapabilityValues(describeError(error), everythingLogged());
      },
    );

    /** Runs steps like the run loop does: a continuation's resumeAt becomes "now" for the next step. Ends on a post or a failure. */
    async function untilDone(store: UploadStateStore, maxSteps = 80) {
      for (let step = 1; step <= maxSteps; step += 1) {
        try {
          const result = await run(bigCtx(store));
          if (!result.continuation) return { result, error: null as LiError | null, steps: step };
          const resumeAt = result.continuation.resumeAt;
          if (resumeAt !== null && resumeAt > Date.now()) vi.setSystemTime(resumeAt);
        } catch (error) {
          return { result: null, error: error as LiError, steps: step };
        }
      }
      throw new Error("the upload did not end");
    }

    /** Status answers that tell us nothing about the asset. */
    const UNUSABLE_STATUS_ANSWERS = [
      ["a 404 (the unconfirmed /v2 status read)", reply(404, "")],
      ["a body that is not JSON", reply(200, "<html>ok</html>")],
      ["an answer with no recipes", () => json({ id: "ASSET1" })],
      ["an answer with no feedshare-video recipe", statusReply("AVAILABLE", "urn:li:digitalmediaRecipe:other")],
      ["a recipe status that is not a string", () => json({ recipes: [{ recipe: VIDEO_RECIPE, status: 3 }] })],
    ] as const;

    it.each(["NEW", "PROCESSING", "WAITING_UPLOAD", "MUTATING"])(
      "%s keeps waiting, and is remembered as the last readable status",
      async (status) => {
        const { store, saved } = fakeStore(processingState(0));
        const li = stubLinkedIn({ status: [statusReply(status)] });

        expect(await run(bigCtx(store))).toEqual(paused(NOW + POLL));
        expect(li.posts()).toHaveLength(0);
        expect(saved()?.data.lastStatus).toBe(status);
        expect(JSON.stringify(saved()?.data)).not.toContain("://");
      },
    );

    it("keeps waiting on a status nobody documented, and forgets the last readable one", async () => {
      const { store, saved } = fakeStore(processingState(0, { lastStatus: "PROCESSING" }));
      const li = stubLinkedIn({ status: [statusReply("A_STATUS_NOBODY_DOCUMENTED")] });

      expect(await run(bigCtx(store))).toEqual(paused(NOW + POLL));
      expect(li.posts()).toHaveLength(0);
      expect(saved()?.data).not.toHaveProperty("lastStatus");
    });

    it("still PROCESSING at the 10-minute cap posts, with a warning (and not a millisecond sooner)", async () => {
      const late = fakeStore(processingState(MAX_WAIT));
      const lateLi = stubLinkedIn({ status: [statusReply("PROCESSING")] });
      expect(await run(bigCtx(late.store))).toEqual({ externalPostId: "urn:li:share:77" });
      expect(lateLi.sequence()).toEqual(["status", "post"]);
      expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).toMatch(/posting anyway/i);

      vi.clearAllMocks();
      const early = fakeStore(processingState(MAX_WAIT - 1));
      const earlyLi = stubLinkedIn({ status: [statusReply("PROCESSING")] });
      expect(await run(bigCtx(early.store))).toEqual(paused(NOW + POLL));
      expect(earlyLi.posts()).toHaveLength(0);
    });

    it.each(["NEW", "WAITING_UPLOAD", "MUTATING", "A_STATUS_NOBODY_DOCUMENTED"])(
      "%s at the 10-minute cap fails LINKEDIN_VIDEO_UPLOAD_FAILED and posts nothing",
      async (status) => {
        const { store } = fakeStore(processingState(MAX_WAIT));
        const li = stubLinkedIn({ status: [statusReply(status)] });

        const error = await failure(bigCtx(store));

        expect(error?.code).toBe("LINKEDIN_VIDEO_UPLOAD_FAILED");
        expect(li.sequence()).toEqual(["status"]);
        expectNoCapabilityValues(describeError(error), everythingLogged());
      },
    );

    it("a status that is not PROCESSING at the cap fails even when PROCESSING was seen earlier", async () => {
      const { store } = fakeStore(processingState(MAX_WAIT, { lastStatus: "PROCESSING" }));
      const li = stubLinkedIn({ status: [statusReply("WAITING_UPLOAD")] });

      expect((await failure(bigCtx(store)))?.code).toBe("LINKEDIN_VIDEO_UPLOAD_FAILED");
      expect(li.posts()).toHaveLength(0);
    });

    it("the same statuses one millisecond before the cap keep waiting", async () => {
      const { store } = fakeStore(processingState(MAX_WAIT - 1));
      const li = stubLinkedIn({ status: [statusReply("WAITING_UPLOAD")] });

      expect(await run(bigCtx(store))).toEqual(paused(NOW + POLL));
      expect(li.posts()).toHaveLength(0);
    });

    it("a 10-minute wait does not post over an asset that failed", async () => {
      const { store } = fakeStore(processingState(MAX_WAIT + MINUTE));
      const li = stubLinkedIn({ status: [statusReply("CLIENT_ERROR")] });

      expect((await failure(bigCtx(store)))?.code).toBe("LINKEDIN_VIDEO_PROCESSING_FAILED");
      expect(li.posts()).toHaveLength(0);
    });

    it.each(UNUSABLE_STATUS_ANSWERS)(
      "%s is no answer: pause 30 s and ask again, posting nothing and keeping the last readable status",
      async (_label, bad) => {
        const { store, saved } = fakeStore(processingState(0, { lastStatus: "NEW" }));
        const li = stubLinkedIn({ status: [bad as Reply] });

        const result = await run(bigCtx(store));

        expect(result).toEqual(paused(NOW + RESUME_DELAY));
        expect(li.sequence()).toEqual(["status"]);
        expect(saved()?.data.lastStatus).toBe("NEW");
      },
    );

    it.each(UNUSABLE_STATUS_ANSWERS)(
      "%s until the 10-minute cap fails LINKEDIN_VIDEO_UPLOAD_FAILED with no ugcPosts call",
      async (_label, bad) => {
        const { store } = fakeStore(processingState(MAX_WAIT));
        const li = stubLinkedIn({ status: [bad as Reply] });

        const error = await failure(bigCtx(store));

        expect(error?.code).toBe("LINKEDIN_VIDEO_UPLOAD_FAILED");
        expect(li.sequence()).toEqual(["status"]);
        expectNoCapabilityValues(describeError(error), everythingLogged());
      },
    );

    it("an unusable answer at the cap still posts when PROCESSING was the last readable status", async () => {
      const { store } = fakeStore(processingState(MAX_WAIT, { lastStatus: "PROCESSING" }));
      const li = stubLinkedIn({ status: [reply(404, "")] });

      expect(await run(bigCtx(store))).toEqual({ externalPostId: "urn:li:share:77" });
      expect(li.sequence()).toEqual(["status", "post"]);
    });

    describe("across the whole wait", () => {
      it("PROCESSING seen, then no answer until the cap: posts exactly once", async () => {
        const { store } = fakeStore(processingState(0));
        const li = stubLinkedIn({
          status: [statusReply("PROCESSING")],
          defaults: { status: reply(503, "busy") },
        });

        const { result, error, steps } = await untilDone(store);

        expect(error).toBeNull();
        expect(result).toEqual({ externalPostId: "urn:li:share:77" });
        expect(li.posts()).toHaveLength(1);
        // One PROCESSING check at +60 s, then a check every 30 s until 10 minutes have passed.
        expect(steps).toBe(20);
        expect(Date.now() - NOW).toBe(MAX_WAIT);
      });

      it("a 404 until the cap: UPLOAD_FAILED, no ugcPosts call", async () => {
        const { store } = fakeStore(processingState(0));
        const li = stubLinkedIn({ defaults: { status: reply(404, "") } });

        const { result, error, steps } = await untilDone(store);

        expect(result).toBeNull();
        expect(error?.code).toBe("LINKEDIN_VIDEO_UPLOAD_FAILED");
        expect(li.posts()).toHaveLength(0);
        expect(steps).toBe(21);
        expect(Date.now() - NOW).toBe(MAX_WAIT);
      });

      it("WAITING_UPLOAD until the cap: UPLOAD_FAILED, no ugcPosts call", async () => {
        const { store } = fakeStore(processingState(0));
        const li = stubLinkedIn({ defaults: { status: statusReply("WAITING_UPLOAD") } });

        const { result, error } = await untilDone(store);

        expect(result).toBeNull();
        expect(error?.code).toBe("LINKEDIN_VIDEO_UPLOAD_FAILED");
        expect(li.posts()).toHaveLength(0);
        expect(li.statuses()).toHaveLength(11);
      });

      it("PROCESSING until the cap: posts exactly once", async () => {
        const { store } = fakeStore(processingState(0));
        const li = stubLinkedIn({ defaults: { status: statusReply("PROCESSING") } });

        const { result, error } = await untilDone(store);

        expect(error).toBeNull();
        expect(result).toEqual({ externalPostId: "urn:li:share:77" });
        expect(li.posts()).toHaveLength(1);
      });

      it("stays inside the continuation limit even when every check is answered with an error", async () => {
        const { store } = fakeStore(processingState(0));
        stubLinkedIn({ defaults: { status: reply(503, "busy") } });

        const { error, steps } = await untilDone(store);

        expect(error?.code).toBe("LINKEDIN_VIDEO_UPLOAD_FAILED");
        expect(steps).toBeLessThanOrEqual(MAX_CONTINUATIONS_PER_RESULT);
      });
    });

    it.each([
      ["an address", "https://upload.linkedin.example/dms-uploads/ASSET1?sau=part-secret-1-0"],
      ["a status nobody documented", "A_STATUS_NOBODY_DOCUMENTED"],
      ["a failure status", "CLIENT_ERROR"],
      ["something that is not text", 7],
    ])("saved state whose lastStatus is %s is still used, with the last status taken as absent", async (_label, lastStatus) => {
      const { store } = fakeStore(processingState(MAX_WAIT, { lastStatus: lastStatus as string }));
      const li = stubLinkedIn({ status: [reply(503, "busy")] });

      const error = await failure(bigCtx(store));

      // The state was kept (no new registration); with no readable PROCESSING the cap fails.
      expect(li.registers()).toHaveLength(0);
      expect(error?.code).toBe("LINKEDIN_VIDEO_UPLOAD_FAILED");
      expect(li.posts()).toHaveLength(0);
    });

    it.each([
      ["an address", "https://upload.linkedin.example/dms-uploads/ASSET1?sau=part-secret-1-0"],
      ["a status nobody documented", "A_STATUS_NOBODY_DOCUMENTED"],
      ["something that is not text", 7],
    ])("saved state whose lastStatus is %s is not written back (an address would never reach the readable data)", async (_label, lastStatus) => {
      const { store, saved } = fakeStore(processingState(0, { lastStatus: lastStatus as string }));
      stubLinkedIn({ status: [reply(503, "busy")] });

      const result = await run(bigCtx(store));

      expect(result).toEqual(paused(NOW + RESUME_DELAY));
      expect(saved()?.data).not.toHaveProperty("lastStatus");
      expectNoCapabilityValues(JSON.stringify(saved()?.data));
    });

    it.each([400, 403, 422])("a %i fails LINKEDIN_VIDEO_UPLOAD_FAILED before any post", async (status) => {
      const { store } = fakeStore(processingState(0));
      const li = stubLinkedIn({ status: [reply(status, "{}")] });

      const error = await failure(bigCtx(store));

      expect(error).toMatchObject({ code: "LINKEDIN_VIDEO_UPLOAD_FAILED", status });
      expect(li.posts()).toHaveLength(0);
    });

    it("a 401 flags the connection when its tokens are unchanged, and nothing when they changed", async () => {
      const flagged = fakeStore(processingState(0));
      stubLinkedIn({ status: [reply(401, "{}")] });
      expect((await failure(bigCtx(flagged.store)))?.code).toBe("LINKEDIN_RECONNECT_REQUIRED");
      expect(updateMock).toHaveBeenCalledTimes(1);

      updateMock.mockClear();
      findUniqueMock.mockResolvedValue({ accessToken: "rotated-access-token", refreshToken: "refresh-abc" });
      const superseded = fakeStore(processingState(0));
      stubLinkedIn({ status: [reply(401, "{}")] });
      expect((await failure(bigCtx(superseded.store)))?.code).toBe("CONNECTION_TOKEN_CHANGED");
      expect(updateMock).not.toHaveBeenCalled();
    });

    it("a 429 is RATE_LIMITED, with the position kept", async () => {
      const { store, saved } = fakeStore(processingState(0));
      const li = stubLinkedIn({ status: [reply(429, "", { "Retry-After": "90" })] });

      const error = await failure(bigCtx(store));

      expect(error).toMatchObject({ code: "RATE_LIMITED", platform: "linkedin" });
      expect(error?.retryAt).toBe(NOW + 90_000);
      expect(saved()?.data).toEqual(processingState(0).data);
      expect(li.posts()).toHaveLength(0);
    });

    it.each([
      ["a 503", reply(503, "busy")],
      ["a timeout", timeoutFailure()],
      ["a dropped connection", connectionReset()],
      ["a body that ends early", () => new Response(new ReadableStream({ start: (c) => c.error(new TypeError("terminated")) }), { status: 200 })],
    ] as const)("%s pauses 30 s and asks again while the wait is not over", async (_label, bad) => {
      const { store } = fakeStore(processingState(0));
      const li = stubLinkedIn({ status: [bad as Reply] });

      const result = await run(bigCtx(store));

      expect(result).toEqual(paused(NOW + RESUME_DELAY));
      expect(li.posts()).toHaveLength(0);
    });

    it("no answer at the cap posts when PROCESSING was the last readable status, and fails otherwise", async () => {
      const seen = fakeStore(processingState(MAX_WAIT, { lastStatus: "PROCESSING" }));
      const seenLi = stubLinkedIn({ status: [reply(503, "busy")] });
      expect(await run(bigCtx(seen.store))).toEqual({ externalPostId: "urn:li:share:77" });
      expect(seenLi.sequence()).toEqual(["status", "post"]);
      expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).toMatch(/posting anyway/i);

      vi.clearAllMocks();
      const never = fakeStore(processingState(MAX_WAIT));
      const neverLi = stubLinkedIn({ status: [reply(503, "busy")] });
      expect((await failure(bigCtx(never.store)))?.code).toBe("LINKEDIN_VIDEO_UPLOAD_FAILED");
      expect(neverLi.sequence()).toEqual(["status"]);

      vi.clearAllMocks();
      const other = fakeStore(processingState(MAX_WAIT, { lastStatus: "NEW" }));
      const otherLi = stubLinkedIn({ status: [timeoutFailure()] });
      expect((await failure(bigCtx(other.store)))?.code).toBe("LINKEDIN_VIDEO_UPLOAD_FAILED");
      expect(otherLi.posts()).toHaveLength(0);
    });

    it("does not start a check with under 60 s left; the next step does", async () => {
      const { store } = fakeStore(processingState(0));
      const li = stubLinkedIn();

      const result = await run(bigCtx(store, { deadline: Date.now() + CHUNK_WINDOW - 1 }));

      expect(result).toEqual(paused(null));
      expect(li.sequence()).toEqual([]);
    });

    it("posts only with 35 s of the step left after the check; else continues at once and asks again", async () => {
      const enough = fakeStore(processingState(0));
      const enoughLi = stubLinkedIn({ status: [after(STEP - POST_WINDOW, statusReply("AVAILABLE"))] });
      expect(await run(bigCtx(enough.store))).toEqual({ externalPostId: "urn:li:share:77" });
      expect(enoughLi.posts()).toHaveLength(1);

      vi.clearAllMocks();
      vi.setSystemTime(NOW);
      const short = fakeStore(processingState(0));
      const shortLi = stubLinkedIn({ status: [after(STEP - POST_WINDOW + 1, statusReply("AVAILABLE"))] });
      expect(await run(bigCtx(short.store))).toEqual(paused(null));
      expect(shortLi.posts()).toHaveLength(0);

      const next = await run(bigCtx(short.store));
      expect(next).toEqual({ externalPostId: "urn:li:share:77" });
    });
  });

  describe("the post (the commit call)", () => {
    it("is PUBLISH_UNCONFIRMED, never sent twice, after a 5xx", async () => {
      const { store } = fakeStore(processingState(0));
      const li = stubLinkedIn({ post: [reply(503, "busy")] });

      const error = await failure(bigCtx(store));

      expect(error?.code).toBe("PUBLISH_UNCONFIRMED");
      expect(li.posts()).toHaveLength(1);
    });

    it("is RATE_LIMITED on a real 429", async () => {
      const { store } = fakeStore(processingState(0));
      stubLinkedIn({ post: [reply(429, "", { "Retry-After": "300" })] });

      const error = await failure(bigCtx(store));

      expect(error).toMatchObject({ code: "RATE_LIMITED", platform: "linkedin" });
    });

    it("is never a rate limit when it answered 2xx, whatever headers come with it", async () => {
      const { store } = fakeStore(processingState(0));
      const li = stubLinkedIn({
        post: [
          () =>
            new Response(null, {
              status: 201,
              headers: { "x-restli-id": "urn:li:share:88", "Retry-After": "30", "x-ratelimit-remaining": "0" },
            }),
        ],
      });

      expect(await run(bigCtx(store))).toEqual({ externalPostId: "urn:li:share:88" });
      expect(li.posts()).toHaveLength(1);
    });

    it("a 401 flags the connection through the same guard", async () => {
      const { store } = fakeStore(processingState(0));
      stubLinkedIn({ post: [reply(401, "{}")] });

      expect((await failure(bigCtx(store)))?.code).toBe("LINKEDIN_RECONNECT_REQUIRED");
      expect(updateMock).toHaveBeenCalledTimes(1);
    });

    it("a 201 with neither the header nor a body id is PUBLISH_UNCONFIRMED", async () => {
      const { store } = fakeStore(processingState(0));
      stubLinkedIn({ post: [() => new Response("{}", { status: 201 })] });

      expect((await failure(bigCtx(store)))?.code).toBe("PUBLISH_UNCONFIRMED");
    });
  });

  describe("part URLs that are about to expire", () => {
    it("registers again and starts over when the earliest URL has under 5 minutes left and parts remain", async () => {
      const { store, saves, saved } = fakeStore(uploadState(1, { urlsExpireAt: NOW + URL_SAFETY - 1 }));
      const li = stubLinkedIn({ register: [registerReply({ n: 2 })] });

      const result = await run(bigCtx(store));

      expect(li.registers()).toHaveLength(1);
      expect(li.sequence().slice(0, 3)).toEqual(["register", "blob", "part"]);
      expect(headersOf(li.blobGets()[0][1])["Range"]).toBe("bytes=0-");
      expect(saves()[0]).toEqual(uploadState(0, { restarts: 1 }, 2));
      expect(li.puts()).toHaveLength(3);
      expect(li.puts().every((p) => p.url.includes("ASSET2") && p.intact)).toBe(true);
      expect(li.puts().some((p) => p.url.includes("ASSET1"))).toBe(false);
      const sent = bodyOf(li.completes()[0]).completeMultipartUploadRequest;
      expect(sent.mediaArtifact).toBe(artifactUrn(2));
      expect(sent.metadata).toBe(metadataOf(2));
      // Nothing was posted: the old asset is just left behind.
      expect(li.posts()).toHaveLength(0);
      expect(result).toEqual(paused(NOW + POLL));
      expect(saved()?.data).toMatchObject({ asset: assetUrn(2), phase: "processing", restarts: 1 });
      expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).toMatch(/about to expire/i);
    });

    it("keeps uploading with exactly 5 minutes left", async () => {
      const { store } = fakeStore(uploadState(1, { urlsExpireAt: NOW + URL_SAFETY }));
      const li = stubLinkedIn();

      await run(bigCtx(store));

      expect(li.registers()).toHaveLength(0);
      expect(li.puts().map((p) => pnOf(p.url))).toEqual([2, 3]);
    });

    it("does not start over when every part is already in (completing does not use the part URLs)", async () => {
      const { store } = fakeStore(uploadState(3, { urlsExpireAt: NOW - HOUR }));
      const li = stubLinkedIn();

      await run(bigCtx(store));

      expect(li.sequence()).toEqual(["complete"]);
    });

    it("does not start over while processing", async () => {
      const { store } = fakeStore(processingState(0, { urlsExpireAt: NOW - HOUR }));
      const li = stubLinkedIn();

      await run(bigCtx(store));

      expect(li.sequence()).toEqual(["status", "post"]);
    });

    it("does not start over twice in one step for URLs it has just been given", async () => {
      const { store } = fakeStore();
      const li = stubLinkedIn({ register: [registerReply({ expiresAt: NOW + 1_000 })] });

      await run(bigCtx(store));

      expect(li.registers()).toHaveLength(1);
      expect(li.puts()).toHaveLength(3);
    });

    it("fails LINKEDIN_VIDEO_UPLOAD_FAILED, sending nothing, once it has already started over twice", async () => {
      const { store, saved } = fakeStore(uploadState(1, { urlsExpireAt: NOW + 1_000, restarts: 2 }));
      const li = stubLinkedIn();

      const error = await failure(bigCtx(store));

      expect(error?.code).toBe("LINKEDIN_VIDEO_UPLOAD_FAILED");
      expect(li.sequence()).toEqual([]);
      expect(saved()?.data.restarts).toBe(2);
      expectNoCapabilityValues(describeError(error));
    });

    it("starts over a first and a second time", async () => {
      const first = fakeStore(uploadState(1, { urlsExpireAt: NOW + 1_000, restarts: 1 }));
      const li = stubLinkedIn({ register: [registerReply({ n: 3 })] });

      await run(bigCtx(first.store));

      expect(li.registers()).toHaveLength(1);
      expect(first.saves()[0].data.restarts).toBe(2);
    });

    it("pauses, with the saved state untouched, when there is too little of the step left to register again", async () => {
      const { store, saved } = fakeStore(uploadState(1, { urlsExpireAt: NOW + 1_000 }));
      const li = stubLinkedIn();

      const result = await run(bigCtx(store, { deadline: Date.now() + CHUNK_WINDOW - 1 }));

      expect(result).toEqual(paused(null));
      expect(li.sequence()).toEqual([]);
      expect(saved()).toEqual({ kind: LINKEDIN_UPLOAD_STATE_KIND, ...uploadState(1, { urlsExpireAt: NOW + 1_000 }) });
    });

    it.each([
      ["a timeout", timeoutFailure()],
      ["a dropped connection", connectionReset()],
      ["a body that ends early", terminated()],
      ["the step budget running out", failWith(Object.assign(new Error("budget"), { code: PUBLISH_BUDGET_EXCEEDED_CODE }))],
      ["a 503", reply(503, "busy")],
    ] as const)(
      "%s on the new registration keeps the restart pending: pause 30 s with the old state, no restart counted",
      async (_label, bad) => {
        const { store, saved } = fakeStore(uploadState(1, { urlsExpireAt: NOW + 1_000 }));
        const li = stubLinkedIn({ register: [bad as Reply, registerReply({ n: 2 })] });

        const result = await run(bigCtx(store));

        expect(result).toEqual(paused(NOW + RESUME_DELAY));
        expect(li.sequence()).toEqual(["register"]);
        expect(saved()).toEqual({ kind: LINKEDIN_UPLOAD_STATE_KIND, ...uploadState(1, { urlsExpireAt: NOW + 1_000 }) });

        // The next step registers again, and the restart is counted once.
        const next = await run(bigCtx(store));
        expect(li.registers()).toHaveLength(2);
        expect(next).toEqual(paused(Date.now() + POLL));
        expect(li.puts().every((p) => p.url.includes("ASSET2"))).toBe(true);
        expect(li.completes()).toHaveLength(1);
        expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).toMatch(/registration/i);
      },
    );

    it("a restart whose registration keeps getting no answer is never counted twice", async () => {
      const { store, saved, saves } = fakeStore(uploadState(1, { urlsExpireAt: NOW + 1_000, restarts: 1 }));
      const li = stubLinkedIn({
        register: [timeoutFailure(), connectionReset(), registerReply({ n: 2 })],
      });

      expect(await run(bigCtx(store))).toEqual(paused(NOW + RESUME_DELAY));
      expect(await run(bigCtx(store))).toEqual(paused(NOW + RESUME_DELAY));
      expect(saved()?.data.restarts).toBe(1);
      await run(bigCtx(store));

      expect(li.registers()).toHaveLength(3);
      expect(saves().find((s) => s.data.asset === assetUrn(2))?.data.restarts).toBe(2);
    });

    it("a restart's registration refused for good (a 400, a bug) still fails rather than pausing", async () => {
      const refused = fakeStore(uploadState(1, { urlsExpireAt: NOW + 1_000 }));
      stubLinkedIn({ register: [reply(400, "{}")] });
      expect((await failure(bigCtx(refused.store)))?.code).toBe("LINKEDIN_VIDEO_UPLOAD_FAILED");

      vi.clearAllMocks();
      const bug = new TypeError("Invalid state: the stream is locked");
      const broken = fakeStore(uploadState(1, { urlsExpireAt: NOW + 1_000 }));
      stubLinkedIn({ register: [failWith(bug)] });
      expect(await failure(bigCtx(broken.store))).toBe(bug);
    });

    it("the very first registration of a fresh upload still fails on a timeout (nothing was uploaded yet)", async () => {
      const { store, mocks } = fakeStore();
      const li = stubLinkedIn({ register: [timeoutFailure()] });

      const error = await failure(bigCtx(store));

      expect(error?.code).toBe("FETCH_TIMEOUT");
      expect(li.sequence()).toEqual(["register"]);
      expect(mocks.save).not.toHaveBeenCalled();
    });

    it("a rate limit on the new registration leaves the old state in place", async () => {
      const { store, saved } = fakeStore(uploadState(1, { urlsExpireAt: NOW + 1_000 }));
      stubLinkedIn({ register: [reply(429, "", { "Retry-After": "60" })] });

      const error = await failure(bigCtx(store));

      expect(error?.code).toBe("RATE_LIMITED");
      expect(saved()?.data.asset).toBe(assetUrn(1));
      expect(saved()?.data.restarts).toBe(0);
    });
  });

  describe("a part that fails", () => {
    it("pauses 30 s on a 5xx, keeps the position, and sends the same part again in the next step", async () => {
      const { store, saved } = fakeStore(uploadState(1));
      const li = stubLinkedIn({ part: [reply(503, "busy")] });

      const result = await run(bigCtx(store));

      expect(result).toEqual(paused(NOW + RESUME_DELAY));
      expect(li.sequence()).toEqual(["blob", "part"]);
      expect(saved()?.data).toMatchObject({ nextPart: 1, etags: ["e1"] });
      expect(streams.cancelled).toBe(1);

      const next = await run(bigCtx(store));
      expect(next).toEqual(paused(Date.now() + POLL));
      expect(li.puts().map((p) => pnOf(p.url))).toEqual([2, 2, 3]);
      expect(li.puts().every((p) => p.intact)).toBe(true);
      expect(bodyOf(li.completes()[0]).completeMultipartUploadRequest.partUploadResponses).toHaveLength(3);
    });

    it.each([
      ["a timeout", timeoutFailure()],
      ["a dropped connection", connectionReset()],
      ["a body that ends early", terminated()],
    ] as const)("pauses 30 s after %s, nothing lost", async (_label, bad) => {
      const { store, saved } = fakeStore(uploadState(1));
      stubLinkedIn({ part: [bad as Reply] });

      const result = await run(bigCtx(store));

      expect(result).toEqual(paused(NOW + RESUME_DELAY));
      expect(saved()?.data).toMatchObject({ nextPart: 1, etags: ["e1"] });
    });

    it("pauses when the request itself ran into the step deadline", async () => {
      const { store, saved } = fakeStore(uploadState(1));
      stubLinkedIn({
        part: [
          (req) => {
            advance(STEP - 30_000);
            return timeoutFailure()(req);
          },
        ],
      });

      const result = await run(bigCtx(store));

      expect(result).toEqual(paused(Date.now() + RESUME_DELAY));
      expect(saved()?.data.nextPart).toBe(1);
    });

    it("surfaces a TypeError that is not a network failure", async () => {
      const { store } = fakeStore(uploadState(1));
      const bug = new TypeError("Invalid state: the stream is locked");
      stubLinkedIn({ part: [failWith(bug)] });

      expect(await failure(bigCtx(store))).toBe(bug);
    });

    it("treats a 403 as an expired part URL: pauses with the restart pending, then registers again and starts over", async () => {
      const { store, saved, saves } = fakeStore(uploadState(1));
      const li = stubLinkedIn({ part: [reply(403, "expired")], register: [registerReply({ n: 2 })] });

      const first = await run(bigCtx(store));

      expect(first).toEqual(paused(null));
      expect(li.sequence()).toEqual(["blob", "part"]);
      // The position is kept; only the URLs' good-until time says they are spent. Nothing is counted yet.
      expect(saved()?.data).toMatchObject({ nextPart: 1, etags: ["e1"], restarts: 0, urlsExpireAt: NOW });
      expect(streams.cancelled).toBe(1);

      const second = await run(bigCtx(store));

      expect(li.registers()).toHaveLength(1);
      expect(saves().find((s) => s.data.asset === assetUrn(2))).toEqual(uploadState(0, { restarts: 1 }, 2));
      expect(li.puts().slice(1).every((p) => p.url.includes("ASSET2") && p.intact)).toBe(true);
      expect(li.puts().slice(1)).toHaveLength(3);
      expect(second).toEqual(paused(Date.now() + POLL));
      expect(li.posts()).toHaveLength(0);
      expectNoCapabilityValues(everythingLogged());
    });

    it("a 403 starts over twice at most, then fails as a 403 always did", async () => {
      const { store, saved } = fakeStore();
      const li = stubLinkedIn({
        register: [registerReply({ n: 1 }), registerReply({ n: 2 }), registerReply({ n: 3 })],
        part: [reply(403, "x"), reply(403, "x"), reply(403, "x")],
      });

      expect(await run(bigCtx(store))).toEqual(paused(null));
      expect(await run(bigCtx(store))).toEqual(paused(null));
      expect(saved()?.data).toMatchObject({ asset: assetUrn(2), restarts: 1 });

      const error = await failure(bigCtx(store));

      expect(li.registers()).toHaveLength(3);
      expect(error).toMatchObject({ code: "LINKEDIN_VIDEO_UPLOAD_FAILED", status: 403 });
      expect(error?.message).toMatch(/part 1 of 3/);
      expect(li.posts()).toHaveLength(0);
      expectNoCapabilityValues(describeError(error), everythingLogged());
    });

    it("a 403 with no restart left fails at once, without pausing or registering again", async () => {
      const { store, saved } = fakeStore(uploadState(1, { restarts: 2 }));
      const li = stubLinkedIn({ part: [reply(403, "expired")] });

      const error = await failure(bigCtx(store));

      expect(error).toMatchObject({ code: "LINKEDIN_VIDEO_UPLOAD_FAILED", status: 403 });
      expect(li.registers()).toHaveLength(0);
      expect(saved()?.data.urlsExpireAt).toBe(NOW + HOUR);
    });

    it.each([400, 413])("fails LINKEDIN_VIDEO_UPLOAD_FAILED on a %i, naming the part and the status but no URL", async (status) => {
      const { store, saved } = fakeStore(uploadState(1));
      stubLinkedIn({ part: [reply(status, "denied")] });

      const error = await failure(bigCtx(store));

      expect(error).toMatchObject({ code: "LINKEDIN_VIDEO_UPLOAD_FAILED", status });
      expect(error?.message).toContain(`status ${status}`);
      expect(error?.message).toMatch(/part 2 of 3/);
      expect(saved()?.data.nextPart).toBe(1);
      expectNoCapabilityValues(describeError(error), everythingLogged());
    });

    it("fails LINKEDIN_VIDEO_UPLOAD_FAILED when a 2xx carries no ETag, keeping the position of the part before it", async () => {
      const { store, saved } = fakeStore(uploadState(1));
      stubLinkedIn({ part: [reply(200)] });

      const error = await failure(bigCtx(store));

      expect(error?.code).toBe("LINKEDIN_VIDEO_UPLOAD_FAILED");
      expect(error?.message).toContain("ETag");
      expect(saved()?.data).toMatchObject({ nextPart: 1, etags: ["e1"] });
    });

    it("accepts any 2xx that carries an ETag", async () => {
      const { store } = fakeStore(uploadState(2));
      const li = stubLinkedIn({ part: [() => new Response(null, { status: 201, headers: { ETag: "e3" } })] });

      expect(await run(bigCtx(store))).toEqual(paused(Date.now() + POLL));
      expect(li.completes()).toHaveLength(1);
    });

    it("a 429 saves the position, then is RATE_LIMITED with LinkedIn's wait", async () => {
      const { store, saved } = fakeStore(uploadState(1));
      stubLinkedIn({ part: [reply(429, "", { "Retry-After": "120" })] });

      const error = await failure(bigCtx(store));

      expect(error).toMatchObject({ code: "RATE_LIMITED", platform: "linkedin" });
      expect(error?.retryAt).toBe(NOW + 120_000);
      expect(saved()?.data).toMatchObject({ nextPart: 1, etags: ["e1"] });
      expect(saved()?.secret).toBeDefined();
    });
  });

  describe("the registration", () => {
    it("a 429 is RATE_LIMITED with nothing to save", async () => {
      const { store, mocks } = fakeStore();
      const li = stubLinkedIn({ register: [reply(429, "", { "Retry-After": "60" })] });

      const error = await failure(bigCtx(store));

      expect(error).toMatchObject({ code: "RATE_LIMITED", platform: "linkedin" });
      expect(mocks.save).not.toHaveBeenCalled();
      expect(li.sequence()).toEqual(["register"]);
    });

    it("a 401 flags the connection when its tokens are unchanged, and nothing when they changed", async () => {
      const flagged = fakeStore();
      stubLinkedIn({ register: [reply(401, "{}")] });
      expect((await failure(bigCtx(flagged.store)))?.code).toBe("LINKEDIN_RECONNECT_REQUIRED");
      expect(updateMock).toHaveBeenCalledTimes(1);

      updateMock.mockClear();
      findUniqueMock.mockResolvedValue({ accessToken: "rotated-access-token", refreshToken: "refresh-abc" });
      const superseded = fakeStore();
      stubLinkedIn({ register: [reply(401, "{}")] });
      expect((await failure(bigCtx(superseded.store)))?.code).toBe("CONNECTION_TOKEN_CHANGED");
      expect(updateMock).not.toHaveBeenCalled();
    });

    it("a 400 (say, MULTIPART_UPLOAD refused for this size) is LINKEDIN_VIDEO_UPLOAD_FAILED; a 5xx carries its status", async () => {
      const refused = fakeStore();
      const li = stubLinkedIn({ register: [reply(400, JSON.stringify({ message: "unsupported upload mechanism" }))] });
      expect(await failure(bigCtx(refused.store))).toMatchObject({
        code: "LINKEDIN_VIDEO_UPLOAD_FAILED",
        status: 400,
      });
      expect(li.sequence()).toEqual(["register"]);

      vi.clearAllMocks();
      const busy = fakeStore();
      stubLinkedIn({ register: [reply(503, "busy")] });
      expect(await failure(bigCtx(busy.store))).toMatchObject({
        code: "LINKEDIN_VIDEO_UPLOAD_FAILED",
        status: 503,
      });
    });
  });

  describe("capability values", () => {
    it("keeps every part URL and the metadata out of saved data, logs and return values across a whole upload", async () => {
      const { store, saves } = fakeStore();
      stubLinkedIn({
        part: [(req) => partOk(req.url), reply(503, "busy")],
        complete: [reply(503, "busy")],
        status: [statusReply("PROCESSING")],
      });

      const results: unknown[] = [];
      for (let step = 0; step < 12; step += 1) {
        const result = await run(bigCtx(store));
        results.push(result);
        if (!result.continuation) break;
        const resumeAt = result.continuation.resumeAt;
        if (resumeAt !== null && resumeAt > Date.now()) vi.setSystemTime(resumeAt);
      }

      expect(results.at(-1)).toEqual({ externalPostId: "urn:li:share:77" });
      expect(saves().length).toBeGreaterThan(5);
      for (const save of saves()) {
        const readable = JSON.stringify(save.data);
        expectNoCapabilityValues(readable);
        expect(readable).not.toContain("://");
      }
      expectNoCapabilityValues(JSON.stringify(results), everythingLogged());
    });

    it("keeps them out of every error the upload can end in", async () => {
      const errors: unknown[] = [];
      const attempts: Array<() => Promise<unknown>> = [
        () => {
          stubLinkedIn({ register: [reply(400, "{}")] });
          return failure(bigCtx(fakeStore().store));
        },
        () => {
          // With no restart left, a 403 is a plain failure.
          stubLinkedIn({ part: [reply(403, "denied")] });
          return failure(bigCtx(fakeStore(uploadState(1, { restarts: 2 })).store));
        },
        () => {
          stubLinkedIn({ part: [reply(200)] });
          return failure(bigCtx(fakeStore(uploadState(1)).store));
        },
        () => {
          stubLinkedIn({ complete: [reply(400, "{}")] });
          return failure(bigCtx(fakeStore(uploadState(3)).store));
        },
        () => {
          stubLinkedIn({ status: [reply(403, "{}")] });
          return failure(bigCtx(fakeStore(processingState(0)).store));
        },
        () => {
          stubLinkedIn({ status: [statusReply("SERVER_ERROR")] });
          return failure(bigCtx(fakeStore(processingState(0)).store));
        },
        () => {
          stubLinkedIn({ part: [reply(429, "", { "Retry-After": "60" })] });
          return failure(bigCtx(fakeStore(uploadState(1)).store));
        },
        () => {
          stubLinkedIn({ complete: [reply(401, "{}")] });
          return failure(bigCtx(fakeStore(uploadState(3)).store));
        },
      ];
      for (const attempt of attempts) errors.push(await attempt());

      expect(errors.every((e) => e !== null)).toBe(true);
      expectNoCapabilityValues(...errors.map(describeError), everythingLogged());
    });

    it("still refuses a state whose readable part holds a URL, as the real store does (the registration puts none there)", async () => {
      const { store, saves } = fakeStore();
      stubLinkedIn();

      await run(bigCtx(store));

      for (const save of saves()) expect(JSON.stringify(save.data)).not.toContain("://");
    });
  });

  describe("the whole-file path", () => {
    it("no longer logs the register answer, so no upload URL reaches the logs", async () => {
      vi.stubEnv("LARGE_UPLOAD_PLATFORMS", "");
      stubLinkedIn({ total: 4, register: [singleRegisterReply] });

      await run(bigCtx(undefined));

      const logged = everythingLogged();
      expect(logged).not.toContain("single-secret");
      expect(logged).not.toContain("upload.linkedin.example");
      expect(logged).toContain("urn:li:digitalmediaAsset:SINGLE");
    });
  });
});
