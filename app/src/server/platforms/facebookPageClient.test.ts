import type { MediaItem, SocialConnection, User } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
const { updateMock, fetchMock } = vi.hoisted(() => ({
  updateMock: vi.fn(),
  fetchMock: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    socialConnection: {
      update: updateMock,
    },
  },
}));

vi.mock("@/lib/fetchWithTimeout", () => ({
  fetchWithTimeout: fetchMock,
}));

beforeEach(() => {
  updateMock.mockReset();
  updateMock.mockResolvedValue({});
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

  it("rejects non-image media with FACEBOOK_PAGE_UNSUPPORTED_MEDIA_TYPE before any network call", async () => {
    const error = await facebookPageClient
      .publishVideo(makeContext({}, { mimeType: "video/mp4" }))
      .then(() => null)
      .catch((e: unknown) => e as Error & { code?: string });

    expect(error?.code).toBe("FACEBOOK_PAGE_UNSUPPORTED_MEDIA_TYPE");
    expect(fetchMock).not.toHaveBeenCalled();
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
