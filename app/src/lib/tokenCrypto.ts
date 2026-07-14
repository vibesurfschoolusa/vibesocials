import crypto from "crypto";

/**
 * Application-level encryption for secrets persisted in Postgres
 * (primarily SocialConnection accessToken / refreshToken).
 *
 * Wire format: `enc:v1:<base64url(iv || authTag || ciphertext)>`
 * - AES-256-GCM
 * - 12-byte IV, 16-byte auth tag
 *
 * Key: `TOKEN_ENCRYPTION_KEY` — 32 raw bytes, base64- or base64url-encoded
 * (44-char standard base64 with padding, or 43-char base64url without).
 *
 * When the key is unset outside production, seal/open are identity transforms
 * so local/test keep working. In production, seal() throws if the key is
 * missing (never write plaintext OAuth tokens).
 *
 * Open accepts legacy plaintext (no `enc:v1:` prefix) so existing rows keep
 * working after rollout; the next token write re-seals them.
 */

const PREFIX = "enc:v1:";
const IV_LEN = 12;
const TAG_LEN = 16;
const KEY_LEN = 32;

let warnedMissingKey = false;

function decodeKey(raw: string): Buffer | null {
  const candidates = [raw, raw.replace(/-/g, "+").replace(/_/g, "/")];
  for (const candidate of candidates) {
    try {
      const buf = Buffer.from(candidate, "base64");
      if (buf.length === KEY_LEN) return buf;
    } catch {
      // try next
    }
  }
  return null;
}

function getKey(): Buffer | null {
  const raw = process.env.TOKEN_ENCRYPTION_KEY;
  if (!raw || raw.trim() === "") {
    return null;
  }
  const key = decodeKey(raw.trim());
  if (!key) {
    throw new Error(
      "TOKEN_ENCRYPTION_KEY must be 32 bytes encoded as base64 or base64url " +
        "(generate with: openssl rand -base64 32)",
    );
  }
  return key;
}

/** True when the value was sealed by this module. */
export function isSealedSecret(value: string): boolean {
  return value.startsWith(PREFIX);
}

/**
 * Encrypt a plaintext secret for storage. Identity when no key is configured.
 */
export function sealSecret(plaintext: string): string {
  if (plaintext === "" || isSealedSecret(plaintext)) {
    // Empty stays empty; already-sealed values are not double-encrypted
    // (defensive: callers may re-save a connection row after a read that
    // failed to open).
    return plaintext;
  }

  const key = getKey();
  if (!key) {
    // Production must never write plaintext OAuth tokens. Local/test keep the
    // identity transform so unit tests and offline dev work without a key.
    if (process.env.NODE_ENV === "production") {
      throw new Error(
        "TOKEN_ENCRYPTION_KEY is required in production to seal OAuth tokens " +
          "(generate with: openssl rand -base64 32)",
      );
    }
    if (!warnedMissingKey) {
      warnedMissingKey = true;
      console.warn(
        "[tokenCrypto] TOKEN_ENCRYPTION_KEY is unset; OAuth tokens will be stored in plaintext",
      );
    }
    return plaintext;
  }

  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  const packed = Buffer.concat([iv, tag, encrypted]);
  return PREFIX + packed.toString("base64url");
}

/**
 * Decrypt a stored secret. Passes through legacy plaintext (no prefix).
 * Throws if the value claims to be sealed but cannot be opened (wrong key /
 * tampered ciphertext).
 */
export function openSecret(stored: string): string {
  if (!stored || !isSealedSecret(stored)) {
    return stored;
  }

  const key = getKey();
  if (!key) {
    throw new Error(
      "TOKEN_ENCRYPTION_KEY is required to decrypt sealed OAuth tokens",
    );
  }

  const packed = Buffer.from(stored.slice(PREFIX.length), "base64url");
  if (packed.length < IV_LEN + TAG_LEN + 1) {
    throw new Error("Sealed secret is truncated or corrupt");
  }

  const iv = packed.subarray(0, IV_LEN);
  const tag = packed.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const ciphertext = packed.subarray(IV_LEN + TAG_LEN);

  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plain.toString("utf8");
}

type TokenFields = {
  accessToken?: string | null;
  refreshToken?: string | null;
};

/**
 * Seal accessToken / refreshToken on a Prisma write payload (create/update).
 * Leaves other fields untouched; skips undefined fields.
 */
export function sealTokenFields<T extends TokenFields>(data: T): T {
  const out = { ...data };
  if (typeof out.accessToken === "string") {
    out.accessToken = sealSecret(out.accessToken);
  }
  if (typeof out.refreshToken === "string") {
    out.refreshToken = sealSecret(out.refreshToken);
  }
  return out;
}

/**
 * Open accessToken / refreshToken on a loaded SocialConnection (or partial).
 * Leaves other fields untouched; skips null/undefined.
 */
export function openTokenFields<T extends TokenFields>(row: T): T {
  const out = { ...row };
  if (typeof out.accessToken === "string") {
    out.accessToken = openSecret(out.accessToken);
  }
  if (typeof out.refreshToken === "string") {
    out.refreshToken = openSecret(out.refreshToken);
  }
  return out;
}
