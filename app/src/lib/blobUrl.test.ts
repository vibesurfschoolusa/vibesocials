import { afterEach, describe, expect, it, vi } from "vitest";

import { isAllowedBlobUrl } from "./blobUrl";

describe("isAllowedBlobUrl", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("accepts Vercel Blob public URLs", () => {
    expect(
      isAllowedBlobUrl(
        "https://abc123.public.blob.vercel-storage.com/media/video.mp4",
      ),
    ).toBe(true);
  });

  it("rejects arbitrary https hosts", () => {
    expect(isAllowedBlobUrl("https://evil.example/ssrf")).toBe(false);
  });

  it("rejects non-http(s) schemes", () => {
    expect(isAllowedBlobUrl("file:///etc/passwd")).toBe(false);
    expect(isAllowedBlobUrl("ftp://blob.vercel-storage.com/x")).toBe(false);
  });

  it("rejects malformed URLs", () => {
    expect(isAllowedBlobUrl("not a url")).toBe(false);
    expect(isAllowedBlobUrl("")).toBe(false);
  });

  it("allows localhost over http outside production", () => {
    vi.stubEnv("NODE_ENV", "development");
    expect(isAllowedBlobUrl("http://localhost:3000/uploads/a.mp4")).toBe(true);
  });

  it("rejects localhost in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(isAllowedBlobUrl("http://localhost:3000/uploads/a.mp4")).toBe(false);
  });

  it("honors BLOB_ALLOWED_HOSTS", () => {
    vi.stubEnv("BLOB_ALLOWED_HOSTS", "cdn.example.com, media.myco.io");
    expect(isAllowedBlobUrl("https://cdn.example.com/x.mp4")).toBe(true);
    expect(isAllowedBlobUrl("https://media.myco.io/y.mp4")).toBe(true);
    expect(isAllowedBlobUrl("https://other.example/z.mp4")).toBe(false);
  });
});
