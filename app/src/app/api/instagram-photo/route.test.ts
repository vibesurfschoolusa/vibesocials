import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { instagramPhotoUrl } from "@/server/platforms/instagramPhoto";

import { GET } from "./route";

// The route Instagram fetches a photo from (server/platforms/instagramPhoto.ts).
// No database; the stored photo is served by a stubbed global fetch.
const OWN_BLOB = "https://store123.public.blob.vercel-storage.com/1-abc-photo.jpg";

beforeEach(() => {
  vi.stubEnv("NEXTAUTH_SECRET", "test-secret");
  vi.stubEnv("BLOB_READ_WRITE_TOKEN", "vercel_blob_rw_store123_secretpart");
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const get = (url: string) => GET(new Request(url));

async function photo(width: number, height: number) {
  return sharp({ create: { width, height, channels: 3, background: { r: 200, g: 180, b: 60 } } })
    .jpeg()
    .toBuffer();
}

function stubBlob(response: () => Response) {
  const fetchMock = vi.fn<typeof fetch>(() => Promise.resolve(response()));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("GET /api/instagram-photo", () => {
  it("serves a signed photo as a JPEG in Instagram's range", async () => {
    const source = await photo(768, 1024);
    const fetchMock = stubBlob(() => new Response(new Uint8Array(source), { status: 200 }));

    const response = await get(instagramPhotoUrl("https://vibesocials.wtf", OWN_BLOB));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/jpeg");
    expect(String(fetchMock.mock.calls[0][0])).toBe(OWN_BLOB);
    const metadata = await sharp(Buffer.from(await response.arrayBuffer())).metadata();
    expect({ width: metadata.width, height: metadata.height }).toEqual({ width: 768, height: 960 });
  });

  it("refuses a bad signature without fetching anything", async () => {
    const fetchMock = stubBlob(() => new Response("never"));
    const url = new URL(instagramPhotoUrl("https://vibesocials.wtf", OWN_BLOB));
    url.searchParams.set("sig", "0".repeat(64));

    expect((await get(url.toString())).status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a signed URL whose source is not this app's blob store", async () => {
    const fetchMock = stubBlob(() => new Response("never"));

    const foreign = instagramPhotoUrl("https://vibesocials.wtf", "https://evil.example.com/a.jpg");
    const otherStore = instagramPhotoUrl(
      "https://vibesocials.wtf",
      "https://otherstore.public.blob.vercel-storage.com/a.jpg",
    );

    expect((await get(foreign)).status).toBe(404);
    expect((await get(otherStore)).status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("answers 502 when the stored photo cannot be fetched", async () => {
    stubBlob(() => new Response("gone", { status: 404 }));
    expect((await get(instagramPhotoUrl("https://vibesocials.wtf", OWN_BLOB))).status).toBe(502);
  });

  it("refuses a photo larger than 50 MB by its declared size", async () => {
    stubBlob(() => new Response("x", { status: 200, headers: { "Content-Length": String(60 * 1024 * 1024) } }));
    expect((await get(instagramPhotoUrl("https://vibesocials.wtf", OWN_BLOB))).status).toBe(413);
  });

  it("answers 500 when the file is not an image", async () => {
    stubBlob(() => new Response("not an image", { status: 200 }));
    expect((await get(instagramPhotoUrl("https://vibesocials.wtf", OWN_BLOB))).status).toBe(500);
  });
});

describe("GET /api/instagram-photo - the Story copy (2026-11-10)", () => {
  it("serves fit=story uncropped", async () => {
    const source = await photo(1080, 1920);
    stubBlob(() => new Response(new Uint8Array(source), { status: 200 }));

    const response = await get(instagramPhotoUrl("https://vibesocials.wtf", OWN_BLOB, Date.now(), "story"));

    expect(response.status).toBe(200);
    const metadata = await sharp(Buffer.from(await response.arrayBuffer())).metadata();
    expect({ width: metadata.width, height: metadata.height }).toEqual({ width: 1080, height: 1920 });
  });

  it("refuses fit=story added to a feed signature without fetching anything", async () => {
    const fetchMock = stubBlob(() => new Response("never"));
    const url = new URL(instagramPhotoUrl("https://vibesocials.wtf", OWN_BLOB));
    url.searchParams.set("fit", "story");

    expect((await get(url.toString())).status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
