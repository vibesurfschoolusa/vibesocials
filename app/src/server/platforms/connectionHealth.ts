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
