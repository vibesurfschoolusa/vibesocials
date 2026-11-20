import type { MediaItem, SocialConnection, User } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_FETCH_TIMEOUT_MS } from "@/lib/fetchWithTimeout";
import { PUBLISH_UNCONFIRMED_CODE } from "@/lib/publishOutcomes";
import { abortSignalTimeoutOnFakeClock, bodyNeverEnds } from "@/lib/stallingFetch.testkit";
import { instagramClient } from "@/server/platforms/instagramClient";
import { withTransientRetries } from "@/server/platforms/transientRetry";

// R48 platform L1 + latent pattern: every Instagram read in the publish path
// ends within its own limit, the body included. A stalled body before
// media_publish is a plain failure (nothing was posted); a stalled
// media_publish body is PUBLISH_UNCONFIRMED and never re-run; a stalled
// permalink body after the post is live just drops the link.

// A missing bound must be a quick red test, never a hung run.
const STALL_TEST_TIMEOUT_MS = 5_000;

vi.mock("@/lib/db", () => ({
  prisma: { socialConnection: { update: vi.fn(), findUnique: vi.fn() } },
}));

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

type Route = (input: string | URL, init?: RequestInit) => Promise<Response>;

function stubGraph(routes: { container?: Route; status?: Route; publish?: Route; permalink?: Route }) {
  const fetchMock = vi.fn((input: string | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("fields=permalink")) {
      return routes.permalink ? routes.permalink(input, init) : Promise.resolve(json({}));
    }
    if (url.includes("/media_publish")) {
      return routes.publish ? routes.publish(input, init) : Promise.resolve(json({ id: "media-1" }));
    }
    if (url.includes("/ig-account-1/media")) {
      return routes.container ? routes.container(input, init) : Promise.resolve(json({ id: "container-1" }));
    }
    if (url.includes("fields=status_code")) {
      return routes.status ? routes.status(input, init) : Promise.resolve(json({ status_code: "FINISHED" }));
    }
    throw new Error(`Unexpected fetch in test: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function photoCtx() {
  const mediaItem = {
    mimeType: "image/jpeg",
    storageLocation: "https://blob.example.com/m",
    metadata: null,
  } as unknown as MediaItem;
  return {
    user: { id: "user-1" } as unknown as User,
    socialConnection: {
      id: "conn-ig",
      userId: "user-1",
      workspaceId: "workspace-1",
      platform: "instagram",
      accessToken: "page-access-token",
      refreshToken: null,
      expiresAt: null,
      accountIdentifier: "ig-account-1",
      scopes: null,
      metadata: { username: "acme", pageId: "page-1" },
      needsReconnect: false,
      lastRefreshErrorCode: null,
      refreshFailedAt: null,
      reconnectEmailedAt: null,
      expiryWarnedFor: null,
      createdAt: new Date("2020-01-01T00:00:00Z"),
      updatedAt: new Date("2020-01-01T00:00:00Z"),
    } as SocialConnection,
    mediaItem,
    mediaItems: [mediaItem],
    caption: "hello",
  };
}

/** Where `promise` stands after `ms` of fake time: its value, its error, or "still waiting". */
async function settleWithin(promise: Promise<unknown>, ms: number): Promise<unknown> {
  const settled = promise.then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
  await vi.advanceTimersByTimeAsync(ms);
  return Promise.race([settled, Promise.resolve("still waiting")]);
}

beforeEach(() => {
  vi.useFakeTimers();
  abortSignalTimeoutOnFakeClock();
  for (const method of ["log", "info", "warn", "error"] as const) {
    vi.spyOn(console, method).mockImplementation(() => undefined);
  }
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Instagram publish: a body that never ends", () => {
  it("a stalled permalink body still records the live post, without a link, within 5 s", async () => {
    stubGraph({ permalink: bodyNeverEnds });

    const out = await settleWithin(instagramClient.publishVideo(photoCtx()), 5_000);

    expect(out).toEqual({ value: { externalPostId: "media-1" } });
  }, STALL_TEST_TIMEOUT_MS);

  it("a stalled container body before the post is a plain failure within the limit; nothing is published", async () => {
    const fetchMock = stubGraph({ container: bodyNeverEnds });

    const out = (await settleWithin(instagramClient.publishVideo(photoCtx()), DEFAULT_FETCH_TIMEOUT_MS)) as {
      error?: { code?: string };
    };

    expect(out.error?.code).toBe("INSTAGRAM_CONTAINER_FAILED");
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/media_publish"))).toBe(false);
  }, STALL_TEST_TIMEOUT_MS);

  it("a stalled status body counts as not ready yet, and the next check goes on to publish", async () => {
    let checks = 0;
    stubGraph({
      status: (input, init) => (checks++ === 0 ? bodyNeverEnds(input, init) : Promise.resolve(json({ status_code: "FINISHED" }))),
    });

    const out = await settleWithin(instagramClient.publishVideo(photoCtx()), 2 * DEFAULT_FETCH_TIMEOUT_MS);

    expect(out).toEqual({ value: { externalPostId: "media-1" } });
    expect(checks).toBe(2);
  }, STALL_TEST_TIMEOUT_MS);

  it("a stalled media_publish body is PUBLISH_UNCONFIRMED within the limit and is not sent again", async () => {
    const fetchMock = stubGraph({ publish: bodyNeverEnds });

    const out = (await settleWithin(
      withTransientRetries(() => instagramClient.publishVideo(photoCtx()), { sleep: () => Promise.resolve() }),
      DEFAULT_FETCH_TIMEOUT_MS,
    )) as { error?: { code?: string } };

    expect(out.error?.code).toBe(PUBLISH_UNCONFIRMED_CODE);
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes("/media_publish"))).toHaveLength(1);
  }, STALL_TEST_TIMEOUT_MS);
});
