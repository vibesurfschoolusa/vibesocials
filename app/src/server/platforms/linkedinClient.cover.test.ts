import type { SocialConnection } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  LINKEDIN_COVER_FRAME_ONLY_NOTE,
  LINKEDIN_COVER_REFUSED_NOTE,
  linkedinClient,
} from "@/server/platforms/linkedinClient";
import type { PublishContext } from "@/server/platforms/types";

vi.mock("@/lib/db", () => ({
  prisma: { socialConnection: { update: vi.fn(), findUnique: vi.fn() } },
}));
vi.mock("@/server/platforms/connectionRefresh", () => ({ refreshConnectionToken: vi.fn() }));

const REST = "https://api.linkedin.com/rest";
const COVER_URL = "https://blob.example.com/cover.jpg";
const PART_URL = "https://www.linkedin.com/dms-uploads/C5505AQH/uploadedVideo?sau=part-secret";
const THUMB_URL = "https://www.linkedin.com/dms-uploads/C5510AQH/ads-video-userUploadedThumbnail/0?ut=thumb-secret";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function stub(routes: { thumbPut?: () => Response | Promise<Response>; noThumbUrl?: boolean } = {}) {
  const fetchMock = vi.fn(async (input: string | URL) => {
    const url = String(input);
    if (url === COVER_URL) return new Response(new Uint8Array([5, 5, 5]));
    if (url.includes("blob.example.com")) return new Response(new Uint8Array([1, 2, 3, 4]));
    if (url === `${REST}/videos?action=initializeUpload`) {
      return json({
        value: {
          uploadUrlsExpireAt: Date.now() + 3_600_000,
          video: "urn:li:video:C5505AQH-oV1qvnFtKA",
          uploadInstructions: [{ uploadUrl: PART_URL, firstByte: 0, lastByte: 3 }],
          uploadToken: "",
          ...(routes.noThumbUrl ? {} : { thumbnailUploadUrl: THUMB_URL }),
        },
      });
    }
    if (url === PART_URL) return new Response(null, { status: 200, headers: { ETag: '"etag-1"' } });
    if (url === THUMB_URL) return (routes.thumbPut ?? (() => new Response(null, { status: 201 })))();
    if (url === `${REST}/videos?action=finalizeUpload`) return new Response(null, { status: 200 });
    if (url.startsWith(`${REST}/videos/urn`)) return json({ status: "AVAILABLE" });
    if (url === `${REST}/posts`) {
      return new Response(null, { status: 201, headers: { "x-restli-id": "urn:li:share:1" } });
    }
    throw new Error(`Unexpected fetch in test: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  const calls = () => fetchMock.mock.calls as unknown as Array<[string, RequestInit]>;
  return { calls };
}

function ctx(cover?: PublishContext["cover"]): PublishContext {
  const mediaItem = {
    mimeType: "video/mp4",
    storageLocation: "https://blob.example.com/m",
    originalFilename: "m.mp4",
    sizeBytes: 4,
  };
  return {
    user: { id: "user-1" },
    socialConnection: {
      id: "conn-li",
      platform: "linkedin",
      accessToken: "access-token",
      refreshToken: "refresh",
      expiresAt: new Date(Date.now() + 3_600_000),
      accountIdentifier: "acct-1",
      metadata: { organizations: [{ id: "123", name: "Acme" }] },
    } as unknown as SocialConnection,
    mediaItem,
    mediaItems: [mediaItem],
    caption: "hello",
    ...(cover ? { cover } : {}),
  } as unknown as PublishContext;
}

const initBody = (calls: Array<[string, RequestInit]>) =>
  JSON.parse(String(calls.find(([u]) => u === `${REST}/videos?action=initializeUpload`)?.[1].body));

describe("linkedinClient - a video's cover (Videos API thumbnail)", () => {
  beforeEach(() => {
    for (const level of ["log", "warn", "error"] as const) vi.spyOn(console, level).mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("no cover: uploadThumbnail false, no thumbnail PUT", async () => {
    const li = stub();
    expect(await linkedinClient.publishVideo(ctx())).toEqual({ externalPostId: "urn:li:share:1" });
    expect(initBody(li.calls()).initializeUploadRequest.uploadThumbnail).toBe(false);
    expect(li.calls().some(([u]) => u === THUMB_URL)).toBe(false);
  });

  it("an image cover: uploadThumbnail true, the image PUT to thumbnailUploadUrl before finalizeUpload", async () => {
    const li = stub();

    const result = await linkedinClient.publishVideo(ctx({ imageUrl: COVER_URL }));

    expect(result).toEqual({ externalPostId: "urn:li:share:1" });
    expect(initBody(li.calls()).initializeUploadRequest.uploadThumbnail).toBe(true);
    const urls = li.calls().map(([u]) => u);
    expect(urls.indexOf(THUMB_URL)).toBeGreaterThan(urls.indexOf(PART_URL));
    expect(urls.indexOf(THUMB_URL)).toBeLessThan(urls.indexOf(`${REST}/videos?action=finalizeUpload`));
    const put = li.calls().find(([u]) => u === THUMB_URL)?.[1];
    expect(put?.method).toBe("PUT");
    expect(put?.headers).toMatchObject({
      "media-type-family": "STILLIMAGE",
      "Content-Type": "application/octet-stream",
    });
    expect(Array.from(put?.body as Uint8Array)).toEqual([5, 5, 5]);
  });

  it("a refused thumbnail upload: the post still goes, with a note, and the URL is never logged", async () => {
    stub({ thumbPut: () => new Response("no", { status: 400 }) });

    const result = await linkedinClient.publishVideo(ctx({ imageUrl: COVER_URL }));

    expect(result).toEqual({ externalPostId: "urn:li:share:1", note: LINKEDIN_COVER_REFUSED_NOTE });
    const logged = JSON.stringify((["log", "warn", "error"] as const).map((l) => vi.mocked(console[l]).mock.calls));
    expect(logged).not.toContain("thumb-secret");
  });

  it("no thumbnailUploadUrl in the answer: the post still goes, with a note", async () => {
    stub({ noThumbUrl: true });
    expect(await linkedinClient.publishVideo(ctx({ imageUrl: COVER_URL }))).toEqual({
      externalPostId: "urn:li:share:1",
      note: LINKEDIN_COVER_REFUSED_NOTE,
    });
  });

  it("a frame without an image: uploadThumbnail false and a note", async () => {
    const li = stub();
    expect(await linkedinClient.publishVideo(ctx({ timeMs: 500 }))).toEqual({
      externalPostId: "urn:li:share:1",
      note: LINKEDIN_COVER_FRAME_ONLY_NOTE,
    });
    expect(initBody(li.calls()).initializeUploadRequest.uploadThumbnail).toBe(false);
  });
});
