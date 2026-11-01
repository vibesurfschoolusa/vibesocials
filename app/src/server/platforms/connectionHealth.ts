// Roadmap Phase 4: connection health / reconnect flag.
//
// `SocialConnection.expiresAt` is only the short-lived access-token expiry
// (~1h for Google/YouTube/GBP, auto-refreshed on use; ~24h TikTok; `null` for
// X). It is NOT a health signal — the app already treats a past `expiresAt`
// as "refresh now," not "broken." The real signal that a connection is
// actually dead is a token *refresh* terminally failing (Google
// `invalid_grant`) or a platform client mapping an upstream 401 to its
// `*_RECONNECT_REQUIRED` code (Instagram/LinkedIn, which cannot refresh).
//
// This is the single, shared choke point every platform client calls on
// those terminal failures, so the flag-writing shape lives in one place.

/**
 * Mark a `SocialConnection` as needing reconnect after a terminal auth
 * failure. Writes ONLY `needsReconnect` + the two diagnostic fields — NEVER
 * `accessToken`/`refreshToken` — preserving the never-overwrite-refreshToken
 * invariant pinned in `googleTokens.ts` / `linkedinClient.ts`.
 *
 * Best-effort: a failure to persist the flag is logged, not thrown, so it
 * can never mask or replace the original auth error the caller is about to
 * throw — that error (and its code) is the outcome that actually matters to
 * the user and to `PostJobResult.errorCode`.
 */
export async function markConnectionNeedsReconnect(
  connectionId: string,
  code: string,
): Promise<void> {
  try {
    // Dynamic import (matches googleTokens.ts / linkedinClient.ts): keeps
    // `@/lib/db` out of these platform-client modules' static import graph
    // (e.g. instagramClient.ts has no DB import at module load) so it's only
    // pulled in when a failure actually needs to be persisted.
    const { prisma } = await import("@/lib/db");
    await prisma.socialConnection.update({
      where: { id: connectionId },
      data: {
        needsReconnect: true,
        lastRefreshErrorCode: code,
        refreshFailedAt: new Date(),
      },
    });
  } catch (updateError: unknown) {
    console.error(
      "[ConnectionHealth] Failed to mark connection needsReconnect",
      { connectionId, code, error: updateError },
    );
  }
}

/**
 * Is a failed OAuth refresh TERMINAL (the grant is dead; only a reconnect can
 * fix it) as opposed to transient (retry later)? The one rule every refreshing
 * client (Google, LinkedIn, TikTok) uses before calling
 * {@link markConnectionNeedsReconnect} — a rate limit or provider outage must
 * never mark a working connection dead (2026-11-01 audit):
 *  - 429 / 5xx: transient, regardless of body.
 *  - `invalid_client`: OUR client id/secret is wrong — a deployment problem,
 *    not a dead grant; flagging would mark every user's connection dead.
 *  - HTTP 400 / 401: terminal (e.g. `invalid_grant`: expired or revoked).
 *  - `invalid_grant` on any other non-5xx status (TikTok can send it with
 *    HTTP 200): terminal.
 *  - anything else (403, 404, ...): not flagged.
 * Network errors never reach this: there is no response to classify, and the
 * caller lets them propagate unflagged.
 */
export function isTerminalRefreshFailure(
  status: number,
  oauthError: string | undefined,
): boolean {
  if (oauthError === "invalid_client") return false;
  if (status === 429 || status >= 500) return false;
  if (status === 400 || status === 401) return true;
  return oauthError === "invalid_grant";
}

/**
 * The OAuth `error` code (RFC 6749 §5.2, e.g. `"invalid_grant"`) from a failed
 * token-endpoint response, or `undefined` when the body is not such JSON.
 * Reads a CLONE, so the caller can still consume the body (e.g. assertOk).
 */
export async function readOAuthErrorCode(response: Response): Promise<string | undefined> {
  const body = await response
    .clone()
    .text()
    .catch(() => "");
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed && typeof parsed === "object") {
      const error = (parsed as { error?: unknown }).error;
      if (typeof error === "string") return error;
    }
  } catch {
    // Not JSON (e.g. a proxy's HTML error page): no OAuth error code.
  }
  return undefined;
}
