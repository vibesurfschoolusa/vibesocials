import crypto from "crypto";

import { describe, expect, it, vi } from "vitest";

import {
  EMAIL_VERIFY_TTL_MS,
  PASSWORD_RESET_TTL_MS,
  generateAccountToken,
  createAccountToken,
  hashAccountToken,
  issueAccountToken,
} from "./accountToken";
import { makeFakeAccountTokenStore } from "./accountToken.fakeStore";

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

describe("createAccountToken", () => {
  function makeTx() {
    const deleteMany = vi.fn().mockResolvedValue({ count: 0 });
    const create = vi.fn().mockResolvedValue({ id: "tok_new", createdAt: new Date() });
    return { tx: { accountToken: { deleteMany, create } }, deleteMany, create };
  }

  it("creates the token without deleting any other", async () => {
    const { tx, deleteMany, create } = makeTx();
    await createAccountToken(tx, "user_1", "password_reset", new Date("2026-07-13T00:00:00.000Z"));
    expect(create).toHaveBeenCalledTimes(1);
    expect(deleteMany).not.toHaveBeenCalled();
  });

  it("password_reset: persists the sha256 hash with expiresAt = now + 60 min and returns the raw token", async () => {
    const { tx, create } = makeTx();
    const now = new Date("2026-07-13T00:00:00.000Z");

    const { raw } = await createAccountToken(tx, "user_1", "password_reset", now);

    expect(create).toHaveBeenCalledWith({
      data: {
        userId: "user_1",
        type: "password_reset",
        tokenHash: hashAccountToken(raw),
        expiresAt: new Date(now.getTime() + PASSWORD_RESET_TTL_MS),
      },
      select: { id: true, createdAt: true },
    });
    // The raw token is returned to the caller but NEVER the persisted form.
    expect(create.mock.calls[0][0].data.tokenHash).not.toBe(raw);
    expect(raw).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("email_verify: persists expiresAt = now + 7 days", async () => {
    const { tx, create } = makeTx();
    const now = new Date("2026-07-13T00:00:00.000Z");

    const { raw } = await createAccountToken(tx, "user_2", "email_verify", now);

    expect(create.mock.calls[0][0].data).toEqual({
      userId: "user_2",
      type: "email_verify",
      tokenHash: hashAccountToken(raw),
      expiresAt: new Date(now.getTime() + EMAIL_VERIFY_TTL_MS),
    });
  });

  it("defaults `now` to the current time when the argument is omitted", async () => {
    const { tx, create } = makeTx();

    const before = Date.now();
    await createAccountToken(tx, "user_3", "password_reset");
    const after = Date.now();

    const expiresAt = create.mock.calls[0][0].data.expiresAt as Date;
    expect(expiresAt.getTime()).toBeGreaterThanOrEqual(before + PASSWORD_RESET_TTL_MS);
    expect(expiresAt.getTime()).toBeLessThanOrEqual(after + PASSWORD_RESET_TTL_MS);
  });
});

// R56 new-customer L1, pages-a L4: an older unused link is retired only once
// the new one's email has been accepted.
describe("issueAccountToken", () => {
  const OLD = hashAccountToken("old-link");

  it("delivery accepted: the older unused link is retired and the new one works", async () => {
    const store = makeFakeAccountTokenStore();
    store.seed({ userId: "u1", type: "email_verify", tokenHash: OLD });
    let sent = "";
    const delivered = await issueAccountToken(store.db, "u1", "email_verify", async (raw) => {
      sent = raw;
      // The older link still works while the email is on its way.
      expect(store.hashes()).toContain(OLD);
      return true;
    });
    expect(delivered).toBe(true);
    expect(store.hashes()).toEqual([hashAccountToken(sent)]);
  });

  it("delivery refused: the older link keeps working and the new one is removed", async () => {
    const store = makeFakeAccountTokenStore();
    store.seed({ userId: "u1", type: "email_verify", tokenHash: OLD });
    const delivered = await issueAccountToken(store.db, "u1", "email_verify", async () => false);
    expect(delivered).toBe(false);
    expect(store.hashes()).toEqual([OLD]);
  });

  it("delivery throws: the new token is removed, the older one kept, and the error passes on", async () => {
    const store = makeFakeAccountTokenStore();
    store.seed({ userId: "u1", type: "password_reset", tokenHash: OLD });
    await expect(
      issueAccountToken(store.db, "u1", "password_reset", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(store.hashes()).toEqual([OLD]);
  });

  it("two sends in a row, both accepted: only the newest works", async () => {
    const store = makeFakeAccountTokenStore();
    const sent: string[] = [];
    const deliver = async (raw: string) => (sent.push(raw), true);
    await issueAccountToken(store.db, "u1", "password_reset", deliver);
    await issueAccountToken(store.db, "u1", "password_reset", deliver);
    expect(store.hashes()).toEqual([hashAccountToken(sent[1])]);
  });

  it("two concurrent sends: the older one's acceptance never retires the newer link", async () => {
    const store = makeFakeAccountTokenStore();
    let releaseFirst!: () => void;
    const firstHeld = new Promise<void>((resolve) => (releaseFirst = resolve));
    const sent: string[] = [];
    // The first send's email is accepted only after the second's.
    const first = issueAccountToken(store.db, "u1", "email_verify", async (raw) => {
      sent[0] = raw;
      await firstHeld;
      return true;
    });
    await Promise.resolve();
    const second = issueAccountToken(store.db, "u1", "email_verify", async (raw) => ((sent[1] = raw), true));
    await second;
    releaseFirst();
    await first;
    expect(store.hashes()).toEqual([hashAccountToken(sent[1])]);
  }, 5_000);

  it("a used token is never deleted, whether the send is accepted or refused", async () => {
    const used = new Date("2026-11-19T00:00:00.000Z");
    for (const accepted of [true, false]) {
      const store = makeFakeAccountTokenStore();
      store.seed({ userId: "u1", type: "email_verify", tokenHash: OLD, usedAt: used });
      await issueAccountToken(store.db, "u1", "email_verify", async () => accepted);
      expect(store.rows.find((row) => row.tokenHash === OLD)?.usedAt).toEqual(used);
    }
  });

  it("leaves another type and another person's links alone", async () => {
    const store = makeFakeAccountTokenStore();
    store.seed({ userId: "u1", type: "password_reset", tokenHash: "reset" });
    store.seed({ userId: "u2", type: "email_verify", tokenHash: "other" });
    await issueAccountToken(store.db, "u1", "email_verify", async () => true);
    expect(store.hashes()).toEqual(expect.arrayContaining(["reset", "other"]));
  });
});
