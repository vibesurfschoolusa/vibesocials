import { readFileSync } from "node:fs";

import type { MediaItem, SocialConnection, User } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { publishErrorMessage, sentenceForRecipient } from "@/lib/publishFailureText";
import type { UploadSnapshot, UploadStateStore } from "@/server/jobs/uploadState";

import { INSTAGRAM_NO_CONTAINER_ID_MESSAGE, instagramClient } from "./instagramClient";
import type { PublishContext } from "./types";

vi.mock("@/lib/db", () => ({
  prisma: { socialConnection: { update: vi.fn(), findUnique: vi.fn() } },
}));

// R20 publishing L2: Meta answering 2xx without a usable container id used to
// reach the card and the email as "Instagram container creation failed (no
// container id in the answer)". Nothing was posted; the person reads that and
// what to do, whatever the post was.
const PLAIN = "Instagram didn't answer as expected, so nothing was posted. Try again.";

function connection(): SocialConnection {
  return {
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
  } as SocialConnection;
}

function makeStore() {
  const kept = new Map<string, UploadSnapshot<unknown, unknown>>();
  return {
    load: vi.fn(async (kind: string) => kept.get(kind) ?? null),
    save: vi.fn(async (kind: string, snapshot: UploadSnapshot<unknown, unknown>) => {
      kept.set(kind, snapshot);
    }),
    clear: vi.fn(async () => {
      kept.clear();
    }),
  } as unknown as UploadStateStore;
}

function item(mimeType: string, i = 0): MediaItem {
  return {
    mimeType,
    storageLocation: `https://blob.example.com/m${i}`,
    metadata: null,
    baseCaption: "",
    perPlatformOverrides: null,
  } as unknown as MediaItem;
}

function ctx(kind: "photo" | "reel" | "story" | "carousel"): PublishContext {
  const mediaItems =
    kind === "carousel" ? [item("image/jpeg", 0), item("image/jpeg", 1)] : [item(kind === "photo" ? "image/jpeg" : "video/mp4")];
  return {
    user: { id: "user-1" } as unknown as User,
    socialConnection: connection(),
    mediaItem: mediaItems[0],
    mediaItems,
    caption: "hello",
    uploadState: makeStore(),
    ...(kind === "story" ? { instagramMetadata: { placement: "story" as const } } : {}),
  };
}

/** Graph stub: a carousel's children get ids; the post's own container answers `body`. */
function stubGraph(body: string) {
  let children = 0;
  const calls = { publish: 0 };
  vi.stubGlobal(
    "fetch",
    vi.fn((input: string | URL) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/media_publish")) {
        calls.publish += 1;
        return Promise.resolve(new Response(JSON.stringify({ id: "media-1" }), { status: 200 }));
      }
      if (url.pathname.endsWith("/ig-account-1/media")) {
        if (url.searchParams.get("is_carousel_item") === "true") {
          children += 1;
          return Promise.resolve(new Response(JSON.stringify({ id: `child-${children}` }), { status: 200 }));
        }
        return Promise.resolve(new Response(body, { status: 200 }));
      }
      throw new Error(`Unexpected fetch in test: ${url}`);
    }),
  );
  return calls;
}

const SHAPES: [string, string][] = [
  ["no id", "{}"],
  ["an empty id", JSON.stringify({ id: "" })],
  ["a numeric id", JSON.stringify({ id: 17 })],
  ["a null id", JSON.stringify({ id: null })],
  ["a JSON null body", "null"],
  ["a body that is not JSON", "<html>ok</html>"],
];

describe("instagramClient - a container answer without a usable id", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubEnv("NEXTAUTH_URL", "https://vibesocials.wtf");
    vi.stubEnv("NEXTAUTH_SECRET", "test-secret");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("the sentence is the plain one", () => {
    expect(INSTAGRAM_NO_CONTAINER_ID_MESSAGE).toBe(PLAIN);
  });

  for (const kind of ["photo", "reel", "story", "carousel"] as const) {
    it.each(SHAPES)(`${kind}, %s: INSTAGRAM_CONTAINER_FAILED, the plain sentence on the card and in the email`, async (_l, body) => {
      const calls = stubGraph(body);

      const error = (await instagramClient.publishVideo(ctx(kind)).then(
        () => null,
        (e: unknown) => e,
      )) as (Error & { code?: string; status?: number }) | null;

      expect(error?.code).toBe("INSTAGRAM_CONTAINER_FAILED");
      expect(error?.status).toBeUndefined();
      expect(calls.publish).toBe(0);
      const stored = publishErrorMessage("instagram", error!);
      expect(stored).toBe(PLAIN);
      expect(sentenceForRecipient(stored, "instagram", "owner")).toBe(PLAIN);
      expect(sentenceForRecipient(stored, "instagram", "member")).toBe(PLAIN);
    });
  }
});

// R20 publishing L1: Instagram never sent a location_id; the client no longer
// reads a post's place or logs its coordinates.
describe("instagramClient - no location", () => {
  const source = readFileSync(new URL("./instagramClient.ts", import.meta.url), "utf8");

  it("reads no location and sends no location_id", () => {
    expect(source).not.toMatch(/location_id|locationId|Location coordinates|metadata as \{ location/);
  });
});
