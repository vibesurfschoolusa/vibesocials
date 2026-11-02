import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { canonicalBlobUrl, isAllowedBlobUrl, ownBlobStoreId } from "./blobUrl";

// Hermetic: a developer shell that exports BLOB_READ_WRITE_TOKEN must not pin
// the store for the host-agnostic tests below. Tests that want a store set it.
beforeEach(() => {
  vi.stubEnv("BLOB_READ_WRITE_TOKEN", "");
  vi.stubEnv("BLOB_STORE_ID", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

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

  it("allows localhost over http (local storage + e2e mock blob)", () => {
    expect(isAllowedBlobUrl("http://localhost:3000/uploads/a.mp4")).toBe(true);
    expect(isAllowedBlobUrl("http://localhost:9366/media/x.png")).toBe(true);
  });

  it("allows localhost over http even when NODE_ENV is production (CI e2e)", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(isAllowedBlobUrl("http://localhost:9366/?pathname=x")).toBe(true);
  });

  it("rejects non-loopback http hosts", () => {
    expect(isAllowedBlobUrl("http://evil.example/x.mp4")).toBe(false);
  });

  it("honors BLOB_ALLOWED_HOSTS", () => {
    vi.stubEnv("BLOB_ALLOWED_HOSTS", "cdn.example.com, media.myco.io");
    expect(isAllowedBlobUrl("https://cdn.example.com/x.mp4")).toBe(true);
    expect(isAllowedBlobUrl("https://media.myco.io/y.mp4")).toBe(true);
    expect(isAllowedBlobUrl("https://other.example/z.mp4")).toBe(false);
  });
});

// 2026-11-01 audit (M2): the shared-blob guard compares storageLocation
// strings, so every write path must store ONE canonical spelling per file.
describe("canonicalBlobUrl", () => {
  // Shape returned by @vercel/blob's upload(): <store>.public.blob.vercel-storage.com/<key>-<suffix>.<ext>
  const U = "https://abc123.public.blob.vercel-storage.com/1700000000000-ab12cd34-photo-Xy9Zq1.png";

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns an already-canonical URL unchanged", () => {
    expect(canonicalBlobUrl(U)).toBe(U);
  });

  it("trims surrounding whitespace", () => {
    expect(canonicalBlobUrl(` ${U}`)).toBe(U);
    expect(canonicalBlobUrl(`${U}\n`)).toBe(U);
    expect(canonicalBlobUrl(`  ${U}  `)).toBe(U);
  });

  it("rejects a query string (a distinct spelling of the same file)", () => {
    expect(canonicalBlobUrl(`${U}?x=1`)).toBeNull();
    expect(canonicalBlobUrl(`${U}?`)).toBeNull();
  });

  it("rejects a fragment", () => {
    expect(canonicalBlobUrl(`${U}#f`)).toBeNull();
    expect(canonicalBlobUrl(`${U}#`)).toBeNull();
  });

  it("lower-cases the scheme and host but leaves the (case-sensitive) path alone", () => {
    expect(
      canonicalBlobUrl("HTTPS://ABC123.PUBLIC.BLOB.VERCEL-STORAGE.COM/1700000000000-ab12cd34-Photo-Xy9Zq1.png"),
    ).toBe("https://abc123.public.blob.vercel-storage.com/1700000000000-ab12cd34-Photo-Xy9Zq1.png");
  });

  it("collapses an explicit default port (:443) to the portless spelling", () => {
    // WHATWG URL drops a default port at parse time, so `:443` cannot be told
    // apart from no port; it canonicalizes rather than being rejected.
    expect(canonicalBlobUrl("https://abc123.public.blob.vercel-storage.com:443/p.png")).toBe(
      "https://abc123.public.blob.vercel-storage.com/p.png",
    );
  });

  it("rejects a non-default explicit port on a non-local host", () => {
    expect(canonicalBlobUrl("https://abc123.public.blob.vercel-storage.com:8443/p.png")).toBeNull();
  });

  it("resolves dot segments", () => {
    expect(canonicalBlobUrl("https://abc123.public.blob.vercel-storage.com/a/./b")).toBe(
      "https://abc123.public.blob.vercel-storage.com/a/b",
    );
    expect(canonicalBlobUrl("https://abc123.public.blob.vercel-storage.com/a/c/../b")).toBe(
      "https://abc123.public.blob.vercel-storage.com/a/b",
    );
    expect(canonicalBlobUrl("https://abc123.public.blob.vercel-storage.com/a/%2e/b")).toBe(
      "https://abc123.public.blob.vercel-storage.com/a/b",
    );
  });

  it("rejects embedded credentials", () => {
    expect(canonicalBlobUrl("https://user:pw@abc123.public.blob.vercel-storage.com/p.png")).toBeNull();
    expect(canonicalBlobUrl("https://user@abc123.public.blob.vercel-storage.com/p.png")).toBeNull();
  });

  it("keeps the port on local dev hosts (the e2e mock blob server)", () => {
    expect(canonicalBlobUrl("http://localhost:9366/x.png")).toBe("http://localhost:9366/x.png");
    expect(canonicalBlobUrl("http://127.0.0.1:9366/x.png")).toBe("http://127.0.0.1:9366/x.png");
    expect(canonicalBlobUrl("http://[::1]:9366/x.png")).toBe("http://[::1]:9366/x.png");
    expect(canonicalBlobUrl("HTTP://LOCALHOST:9366/x.png")).toBe("http://localhost:9366/x.png");
  });

  it("leaves the exact URL the e2e mock blob server returns unchanged", () => {
    // mock-blob-server.mjs: `http://localhost:${PORT}/${encodeURI(pathname)}`
    // where pathname is generateBlobKey() = `${Date.now()}-${random}-${safeName}`.
    const mockUrl = `http://localhost:9366/${encodeURI("1700000000000-k3j2h1g0-e2e_clip.png")}`;
    expect(canonicalBlobUrl(mockUrl)).toBe(mockUrl);
    const spaced = `http://localhost:9366/${encodeURI("1700000000000-k3j2h1g0-my file (1).png")}`;
    expect(canonicalBlobUrl(spaced)).toBe(spaced);
  });

  it("returns null whenever isAllowedBlobUrl is false", () => {
    expect(canonicalBlobUrl("https://evil.example/ssrf")).toBeNull();
    expect(canonicalBlobUrl("http://abc123.public.blob.vercel-storage.com/p.png")).toBeNull();
    expect(canonicalBlobUrl("file:///etc/passwd")).toBeNull();
    expect(canonicalBlobUrl("not a url")).toBeNull();
    expect(canonicalBlobUrl("")).toBeNull();
    expect(canonicalBlobUrl("   ")).toBeNull();
  });

  it("canonicalizes hosts allowed through BLOB_ALLOWED_HOSTS", () => {
    vi.stubEnv("BLOB_ALLOWED_HOSTS", "cdn.example.com");
    expect(canonicalBlobUrl(" https://CDN.example.com/x.mp4")).toBe("https://cdn.example.com/x.mp4");
    expect(canonicalBlobUrl("https://cdn.example.com:8443/x.mp4")).toBeNull();
    expect(canonicalBlobUrl("https://other.example/x.mp4")).toBeNull();
  });

  it("collapses percent-encoded spellings of the same path (unreserved decoded, hex upper-cased)", () => {
    const base = "https://abc123.public.blob.vercel-storage.com";
    expect(canonicalBlobUrl(`${base}/foo%2Dbar%2e%5Fpng`)).toBe(`${base}/foo-bar._png`);
    expect(canonicalBlobUrl(`${base}/caf%c3%a9.png`)).toBe(`${base}/caf%C3%A9.png`);
    // Reserved / non-unreserved escapes stay escaped; `%25` is not double-decoded.
    expect(canonicalBlobUrl(`${base}/a%20b%2525.png`)).toBe(`${base}/a%20b%2525.png`);
  });

  it("is idempotent", () => {
    for (const input of [U, ` ${U}`, "HTTP://LOCALHOST:9366/a/./b.png", "https://ABC123.public.blob.vercel-storage.com:443/p%2dq"]) {
      const once = canonicalBlobUrl(input);
      expect(once).not.toBeNull();
      expect(canonicalBlobUrl(once as string)).toBe(once);
    }
  });
});

// 2026-11-01 audit (M2, ruling R6): the Vercel Blob API may resolve a URL by the
// token's store plus the pathname, so the same pathname under ANOTHER store's
// host must not be accepted as ours.
describe("ownBlobStoreId", () => {
  it("is null when neither BLOB_READ_WRITE_TOKEN nor BLOB_STORE_ID is set", () => {
    expect(ownBlobStoreId()).toBeNull();
  });

  it("is the 4th underscore segment of the read-write token, lower-cased", () => {
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", "vercel_blob_rw_AbC123_secretvalue");
    expect(ownBlobStoreId()).toBe("abc123");
  });

  it("trims the token", () => {
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", "  vercel_blob_rw_abc123_secretvalue \n");
    expect(ownBlobStoreId()).toBe("abc123");
  });

  it("falls back to BLOB_STORE_ID (a leading store_ is stripped) when the token has no store segment", () => {
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", "garbage");
    vi.stubEnv("BLOB_STORE_ID", "store_AbC123");
    expect(ownBlobStoreId()).toBe("abc123");
    vi.stubEnv("BLOB_STORE_ID", " abc123 ");
    expect(ownBlobStoreId()).toBe("abc123");
  });

  it("prefers the token over BLOB_STORE_ID", () => {
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", "vercel_blob_rw_fromtoken_secret");
    vi.stubEnv("BLOB_STORE_ID", "store_fromenv");
    expect(ownBlobStoreId()).toBe("fromtoken");
  });

  it("treats blank values as unknown", () => {
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", "   ");
    vi.stubEnv("BLOB_STORE_ID", "store_");
    expect(ownBlobStoreId()).toBeNull();
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", "vercel_blob_rw__secret");
    expect(ownBlobStoreId()).toBeNull();
  });
});

describe("own-store pinning (isAllowedBlobUrl / canonicalBlobUrl)", () => {
  const OWN = "https://abc123.public.blob.vercel-storage.com/1700000000000-ab12cd34-cat.png";
  const FOREIGN = "https://zzz999.public.blob.vercel-storage.com/1700000000000-ab12cd34-cat.png";

  describe("with the own store known", () => {
    beforeEach(() => {
      vi.stubEnv("BLOB_READ_WRITE_TOKEN", "vercel_blob_rw_abc123_secretvalue");
    });

    it("accepts the own store's public and private hosts, compared case-insensitively", () => {
      expect(isAllowedBlobUrl(OWN)).toBe(true);
      expect(isAllowedBlobUrl(OWN.replace("abc123.public", "abc123.private"))).toBe(true);
      expect(isAllowedBlobUrl(OWN.replace("abc123", "ABC123"))).toBe(true);
      expect(canonicalBlobUrl(OWN.replace("https://abc123", "HTTPS://AbC123"))).toBe(OWN);
    });

    it("rejects another store's Vercel Blob host, public or private", () => {
      expect(isAllowedBlobUrl(FOREIGN)).toBe(false);
      expect(isAllowedBlobUrl(FOREIGN.replace("zzz999.public", "zzz999.private"))).toBe(false);
      expect(canonicalBlobUrl(FOREIGN)).toBeNull();
    });

    it("rejects store-less Vercel Blob hosts and look-alike prefixes", () => {
      expect(isAllowedBlobUrl("https://public.blob.vercel-storage.com/x.png")).toBe(false);
      expect(isAllowedBlobUrl("https://blob.vercel-storage.com/x.png")).toBe(false);
      expect(isAllowedBlobUrl("https://xabc123.public.blob.vercel-storage.com/x.png")).toBe(false);
      expect(isAllowedBlobUrl("https://abc123.public.blob.vercel-storage.com.evil.example/x.png")).toBe(false);
      expect(isAllowedBlobUrl("https://abc123.evil.public.blob.vercel-storage.com/x.png")).toBe(false);
    });

    it("leaves local dev hosts and BLOB_ALLOWED_HOSTS unaffected", () => {
      vi.stubEnv("BLOB_ALLOWED_HOSTS", "cdn.example.com,zzz999.public.blob.vercel-storage.com");
      expect(isAllowedBlobUrl("http://localhost:9366/x.png")).toBe(true);
      expect(isAllowedBlobUrl("http://127.0.0.1:9366/x.png")).toBe(true);
      expect(isAllowedBlobUrl("https://cdn.example.com/x.mp4")).toBe(true);
      // An operator who lists a foreign Blob host explicitly keeps it.
      expect(isAllowedBlobUrl(FOREIGN)).toBe(true);
    });
  });

  it("pins from BLOB_STORE_ID too", () => {
    vi.stubEnv("BLOB_STORE_ID", "store_abc123");
    expect(isAllowedBlobUrl(OWN)).toBe(true);
    expect(isAllowedBlobUrl(FOREIGN)).toBe(false);
  });

  it("keeps today's behaviour (any Vercel Blob host) when the own store is unknown", () => {
    expect(isAllowedBlobUrl(OWN)).toBe(true);
    expect(isAllowedBlobUrl(FOREIGN)).toBe(true);
    expect(canonicalBlobUrl(FOREIGN)).toBe(FOREIGN);
  });
});
