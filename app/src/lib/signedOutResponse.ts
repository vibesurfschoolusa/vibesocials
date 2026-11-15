import { NextResponse } from "next/server";

/**
 * R20 new-customer L2: the 401 body for a request with no session (signed
 * out in another tab, or the password changed elsewhere). Pages show a
 * route's `error` to the person as it is, so it says what happened and what to
 * do, not "Unauthorized".
 */
export const SIGNED_OUT_ERROR = "You were signed out. Sign in again.";

/** The 401 every API route returns when the request has no session. */
export function signedOutResponse(): NextResponse {
  return NextResponse.json({ error: SIGNED_OUT_ERROR }, { status: 401 });
}
