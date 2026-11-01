import { NextResponse } from "next/server";
import type { Platform } from "@prisma/client";

import { getCurrentUser } from "@/lib/auth";
import { logger } from "@/lib/logger";

/**
 * `/settings?error=` code for a callback whose signed-in user is not the user
 * who started the connect flow. Not platform-prefixed: the copy in
 * lib/oauthResult.ts is the same for every platform.
 */
export const OAUTH_SESSION_MISMATCH = "oauth_session_mismatch";

/**
 * Connection-CSRF guard for the platform OAuth callbacks.
 *
 * The signed `state` (or X's `OAuthHandshake` row) says WHO started the flow,
 * but anyone can finish it: an attacker can start a connect in their own
 * account and get a victim to open the provider's authorize URL, and the
 * victim's approval would then connect the victim's social account to the
 * attacker's workspace. So every callback also requires the browser's own
 * session (NextAuth's cookie is SameSite=Lax, so it rides the provider's
 * top-level GET redirect back) to be that same user.
 *
 * Returns `null` when the signed-in user (via `getCurrentUser()`, which also
 * enforces `sessionVersion`) is `stateUserId`: the caller proceeds. Otherwise
 * returns the redirect the caller must return as-is, BEFORE the code exchange
 * and before writing anything:
 * - no (or stale) session: `/login?callbackUrl=%2Fsettings`
 * - a different user: `/settings?error=oauth_session_mismatch`
 *
 * A session-lookup failure (DB) is thrown, not swallowed: callers run this
 * inside the try whose catch is {@link oauthCallbackFailed}.
 */
export async function guardOAuthCallbackSession({
  platform,
  stateUserId,
  baseUrl,
}: {
  platform: Platform;
  stateUserId: string;
  /** Base for the redirect: the callback's own request URL/origin, or NEXTAUTH_URL. */
  baseUrl: string | URL;
}): Promise<NextResponse | null> {
  const user = await getCurrentUser();

  if (!user) {
    const loginUrl = new URL("/login", baseUrl);
    loginUrl.searchParams.set("callbackUrl", "/settings");
    return NextResponse.redirect(loginUrl);
  }

  if (user.id !== stateUserId) {
    logger.warn("[OAuth callback] Signed-in user is not the user who started the connect flow", {
      platform,
      stateUserId,
      sessionUserId: user.id,
    });
    const settingsUrl = new URL("/settings", baseUrl);
    settingsUrl.searchParams.set("error", OAUTH_SESSION_MISMATCH);
    return NextResponse.redirect(settingsUrl);
  }

  return null;
}

/**
 * V8's JSON.parse messages (and so `stack`) quote a window of the input, and
 * in a callback that input is a provider response that can hold tokens
 * (e.g. `..."ss_token":EAAB-secre"...`). The logger only redacts by key, so
 * log just the error kind for a parse failure.
 */
function loggableError(error: unknown): unknown {
  if (error instanceof SyntaxError) {
    return { name: error.name, message: "Provider response was not valid JSON" };
  }
  return error;
}

/**
 * The one unexpected-error exit for every OAuth callback (network failure,
 * unparseable provider JSON, DB error, handshake lookup): log it and send the
 * user to `/settings?error=<platform>_connect_failed` instead of a 500.
 * Callers pass only the caught error; never a token, code or secret.
 */
export function oauthCallbackFailed({
  platform,
  baseUrl,
  error,
}: {
  platform: Platform;
  baseUrl: string | URL;
  error: unknown;
}): NextResponse {
  logger.error("[OAuth callback] Unexpected error while connecting", {
    platform,
    error: loggableError(error),
  });
  const settingsUrl = new URL("/settings", baseUrl);
  settingsUrl.searchParams.set("error", `${platform}_connect_failed`);
  return NextResponse.redirect(settingsUrl);
}
