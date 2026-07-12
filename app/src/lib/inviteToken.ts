import crypto from "crypto";

/**
 * Owner-created join links (design doc §1). A raw 43-character base64url
 * token (32 random bytes — base64url-without-padding of 32 bytes is always
 * 43 chars) is shown to the owner exactly once, in the copied invite URL.
 * Only its SHA-256 hex digest is persisted (`WorkspaceInvite.tokenHash`) —
 * the raw value is never stored, so it cannot be recovered later (see the
 * `url: null` contract on `GET /api/workspaces/invites`).
 */

/** 7 days, matching `WorkspaceInvite.expiresAt` at creation (design doc §1). */
export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** SHA-256 hex digest of a raw invite token — the only form ever persisted. */
export function hashInviteToken(raw: string): string {
  return crypto.createHash("sha256").update(raw).digest("hex");
}

/**
 * Generates a new invite token pair: `raw` (returned to the caller exactly
 * once, for building the invite URL) and `hash` (persisted to
 * `WorkspaceInvite.tokenHash`).
 */
export function generateInviteToken(): { raw: string; hash: string } {
  const raw = crypto.randomBytes(32).toString("base64url");
  return { raw, hash: hashInviteToken(raw) };
}
