import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  isSealedSecret,
  openSecret,
  openTokenFields,
  sealSecret,
  sealTokenFields,
} from "./tokenCrypto";

const TEST_KEY = Buffer.alloc(32, 7).toString("base64");

describe("tokenCrypto", () => {
  const prev = process.env.TOKEN_ENCRYPTION_KEY;

  beforeEach(() => {
    process.env.TOKEN_ENCRYPTION_KEY = TEST_KEY;
  });

  afterEach(() => {
    if (prev === undefined) {
      delete process.env.TOKEN_ENCRYPTION_KEY;
    } else {
      process.env.TOKEN_ENCRYPTION_KEY = prev;
    }
  });

  it("round-trips a secret", () => {
    const sealed = sealSecret("super-secret-token");
    expect(isSealedSecret(sealed)).toBe(true);
    expect(sealed).not.toContain("super-secret-token");
    expect(openSecret(sealed)).toBe("super-secret-token");
  });

  it("produces different ciphertexts for the same plaintext (random IV)", () => {
    const a = sealSecret("same");
    const b = sealSecret("same");
    expect(a).not.toBe(b);
    expect(openSecret(a)).toBe("same");
    expect(openSecret(b)).toBe("same");
  });

  it("passes through legacy plaintext on open", () => {
    expect(openSecret("legacy-plain-token")).toBe("legacy-plain-token");
  });

  it("does not double-seal", () => {
    const once = sealSecret("tok");
    expect(sealSecret(once)).toBe(once);
  });

  it("is identity when the key is unset outside production", () => {
    vi.stubEnv("NODE_ENV", "test");
    delete process.env.TOKEN_ENCRYPTION_KEY;
    expect(sealSecret("plain")).toBe("plain");
    expect(openSecret("plain")).toBe("plain");
    vi.unstubAllEnvs();
    process.env.TOKEN_ENCRYPTION_KEY = TEST_KEY;
  });

  it("throws in production when the key is unset on seal", () => {
    vi.stubEnv("NODE_ENV", "production");
    delete process.env.TOKEN_ENCRYPTION_KEY;
    expect(() => sealSecret("plain")).toThrow(/TOKEN_ENCRYPTION_KEY is required in production/);
    vi.unstubAllEnvs();
    process.env.TOKEN_ENCRYPTION_KEY = TEST_KEY;
  });

  it("sealTokenFields / openTokenFields cover both token columns", () => {
    const sealed = sealTokenFields({
      accessToken: "access",
      refreshToken: "refresh",
      other: "keep",
    } as { accessToken: string; refreshToken: string; other: string });
    expect(isSealedSecret(sealed.accessToken)).toBe(true);
    expect(isSealedSecret(sealed.refreshToken)).toBe(true);
    expect(sealed.other).toBe("keep");

    const opened = openTokenFields(sealed);
    expect(opened.accessToken).toBe("access");
    expect(opened.refreshToken).toBe("refresh");
  });

  it("throws when sealed value cannot be opened with wrong key", () => {
    const sealed = sealSecret("secret");
    process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64");
    expect(() => openSecret(sealed)).toThrow();
  });
});
