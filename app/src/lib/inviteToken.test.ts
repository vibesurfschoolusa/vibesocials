import { describe, expect, it } from "vitest";

import { generateInviteToken, hashInviteToken, INVITE_TTL_MS } from "./inviteToken";

describe("INVITE_TTL_MS", () => {
  it("is 7 days in milliseconds", () => {
    expect(INVITE_TTL_MS).toBe(7 * 24 * 60 * 60 * 1000);
  });
});

describe("generateInviteToken", () => {
  it("returns a 43-character base64url raw token (32 random bytes, unpadded)", () => {
    const { raw } = generateInviteToken();
    expect(raw).toHaveLength(43);
    expect(raw).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("returns a hash that is a 64-character lowercase hex string (sha256 digest)", () => {
    const { hash } = generateInviteToken();
    expect(hash).toHaveLength(64);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("round-trips: hashing the returned raw token reproduces the returned hash", () => {
    const { raw, hash } = generateInviteToken();
    expect(hashInviteToken(raw)).toBe(hash);
  });

  it("produces distinct raw tokens and hashes across calls", () => {
    const a = generateInviteToken();
    const b = generateInviteToken();

    expect(a.raw).not.toBe(b.raw);
    expect(a.hash).not.toBe(b.hash);
  });
});

describe("hashInviteToken", () => {
  it("is deterministic for the same input", () => {
    const raw = "same-input-value";
    expect(hashInviteToken(raw)).toBe(hashInviteToken(raw));
  });

  it("produces different hashes for different inputs", () => {
    expect(hashInviteToken("a")).not.toBe(hashInviteToken("b"));
  });
});
