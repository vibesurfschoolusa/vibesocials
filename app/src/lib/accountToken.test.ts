import crypto from "crypto";

import { describe, expect, it, vi } from "vitest";

import {
  EMAIL_VERIFY_TTL_MS,
  PASSWORD_RESET_TTL_MS,
  generateAccountToken,
  hashAccountToken,
  issueAccountToken,
} from "./accountToken";

describe("TTL constants", () => {
  it("PASSWORD_RESET_TTL_MS is 60 minutes in milliseconds", () => {
    expect(PASSWORD_RESET_TTL_MS).toBe(60 * 60 * 1000);
  });

  it("EMAIL_VERIFY_TTL_MS is 7 days in milliseconds", () => {
    expect(EMAIL_VERIFY_TTL_MS).toBe(7 * 24 * 60 * 60 * 1000);
  });
});

describe("generateAccountToken", () => {
  it("returns a 43-character base64url raw token (32 random bytes, unpadded)", () => {
    const { raw } = generateAccountToken();
    expect(raw).toHaveLength(43);
    expect(raw).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("returns a 64-character lowercase-hex sha256 digest of the raw token", () => {
    const { raw, hash } = generateAccountToken();
    expect(hash).toHaveLength(64);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).toBe(crypto.createHash("sha256").update(raw).digest("hex"));
  });

  it("round-trips: hashing the returned raw token reproduces the returned hash", () => {
    const { raw, hash } = generateAccountToken();
    expect(hashAccountToken(raw)).toBe(hash);
  });

  it("produces distinct raw tokens and hashes across calls", () => {
    const a = generateAccountToken();
    const b = generateAccountToken();
    expect(a.raw).not.toBe(b.raw);
    expect(a.hash).not.toBe(b.hash);
  });
});

describe("hashAccountToken", () => {
  it("equals crypto.createHash sha256 hex of the input", () => {
    const raw = "some-raw-token-value";
    expect(hashAccountToken(raw)).toBe(
      crypto.createHash("sha256").update(raw).digest("hex"),
    );
  });

  it("is deterministic for the same input and distinguishes different inputs", () => {
    expect(hashAccountToken("a")).toBe(hashAccountToken("a"));
    expect(hashAccountToken("a")).not.toBe(hashAccountToken("b"));
  });
});

describe("issueAccountToken", () => {
  function makeTx() {
    const deleteMany = vi.fn().mockResolvedValue({ count: 0 });
    const create = vi.fn().mockResolvedValue({});
    return { tx: { accountToken: { deleteMany, create } }, deleteMany, create };
  }

  it("deletes prior UNUSED tokens of the type, then creates a fresh one (in that order)", async () => {
    const { tx, deleteMany, create } = makeTx();
    const now = new Date("2026-07-13T00:00:00.000Z");

    await issueAccountToken(tx, "user_1", "password_reset", now);

    expect(deleteMany).toHaveBeenCalledWith({
      where: { userId: "user_1", type: "password_reset", usedAt: null },
    });
    expect(deleteMany).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledTimes(1);
    // deleteMany must run BEFORE create so a fresh token is never wiped.
    expect(deleteMany.mock.invocationCallOrder[0]).toBeLessThan(
      create.mock.invocationCallOrder[0],
    );
  });

  it("password_reset: persists the sha256 hash with expiresAt = now + 60 min and returns the raw token", async () => {
    const { tx, create } = makeTx();
    const now = new Date("2026-07-13T00:00:00.000Z");

    const raw = await issueAccountToken(tx, "user_1", "password_reset", now);

    expect(create).toHaveBeenCalledWith({
      data: {
        userId: "user_1",
        type: "password_reset",
        tokenHash: hashAccountToken(raw),
        expiresAt: new Date(now.getTime() + PASSWORD_RESET_TTL_MS),
      },
    });
    // The raw token is returned to the caller but NEVER the persisted form.
    expect(create.mock.calls[0][0].data.tokenHash).not.toBe(raw);
    expect(raw).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("email_verify: persists expiresAt = now + 7 days", async () => {
    const { tx, create } = makeTx();
    const now = new Date("2026-07-13T00:00:00.000Z");

    const raw = await issueAccountToken(tx, "user_2", "email_verify", now);

    expect(create).toHaveBeenCalledWith({
      data: {
        userId: "user_2",
        type: "email_verify",
        tokenHash: hashAccountToken(raw),
        expiresAt: new Date(now.getTime() + EMAIL_VERIFY_TTL_MS),
      },
    });
  });

  it("defaults `now` to the current time when the argument is omitted", async () => {
    const { tx, create } = makeTx();

    const before = Date.now();
    await issueAccountToken(tx, "user_3", "password_reset");
    const after = Date.now();

    const expiresAt = create.mock.calls[0][0].data.expiresAt as Date;
    expect(expiresAt.getTime()).toBeGreaterThanOrEqual(before + PASSWORD_RESET_TTL_MS);
    expect(expiresAt.getTime()).toBeLessThanOrEqual(after + PASSWORD_RESET_TTL_MS);
  });
});
