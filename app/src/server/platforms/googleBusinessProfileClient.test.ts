import type { MediaItem, SocialConnection, User } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { googleBusinessProfileClient } from "@/server/platforms/googleBusinessProfileClient";
import type { PublishContext } from "@/server/platforms/types";

// Google Business Profile photo publishing. No real Google endpoint and no
// database: every call goes through a stubbed global fetch (googleTokens.ts
// resolves prisma lazily and is not reached with a fresh token).
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
    if (url.includes("mybusiness.googleapis.com/v4/accounts/111/locations/999/media")) {
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
  it("creates the media item and returns its resource name", async () => {
    const fetchMock = stubMediaCreate(
      () => new Response(JSON.stringify({ name: "accounts/111/locations/999/media/m1" }), { status: 200 }),
    );

    await expect(googleBusinessProfileClient.publishVideo(makeContext())).resolves.toEqual({
      externalPostId: "accounts/111/locations/999/media/m1",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps the sanitized GBP_CREATE_MEDIA_FAILED for a non-limit failure", async () => {
    stubMediaCreate(() => new Response("permission denied SECRET_TOKEN", { status: 403 }));

    const error = await failure(googleBusinessProfileClient.publishVideo(makeContext()));

    expect(error?.code).toBe("GBP_CREATE_MEDIA_FAILED");
    expect(error?.status).toBe(403);
    expect(error?.message).not.toContain("SECRET_TOKEN");
  });
});

// 2026-11-01 scale audit (platform limits, V17): GBP allows 300 QPM per API and
// 10 edits/min per profile and answers an excess with HTTP 429 (Retry-After is
// not documented, so retryAt may be null).
describe("googleBusinessProfileClient.publishVideo — rate limits (RATE_LIMITED)", () => {
  it("media create 429 with Retry-After: 30 -> retryAt = now + 30 s", async () => {
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

  it("media create 429 without Retry-After -> retryAt null", async () => {
    stubMediaCreate(() => new Response("", { status: 429 }));

    const error = await failure(googleBusinessProfileClient.publishVideo(makeContext()));

    expect(error).toMatchObject({ code: "RATE_LIMITED", retryAt: null });
  });
});
