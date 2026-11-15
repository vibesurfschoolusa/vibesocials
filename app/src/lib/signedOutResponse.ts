import { NextResponse } from "next/server";

import { SIGNED_OUT_ERROR } from "./signedOutMessage";

export { SIGNED_OUT_ERROR };

/**
 * R20 new-customer L2: the 401 body for a request with no session (signed
 * out in another tab, or the password changed elsewhere). Pages show a
 * route's `error` to the person as it is, so it says what happened and what to
 * do, not "Unauthorized". The 401 every API route returns when the request
 * has no session.
 */
export function signedOutResponse(): NextResponse {
  // R21 pages L3: the browser's listener (session-provider.tsx, SIGNED_OUT_HEADER)
  // sees this mark and re-reads the session, so the page shows the signed-out line.
  return NextResponse.json({ error: SIGNED_OUT_ERROR }, { status: 401, headers: { "x-signed-out": "1" } });
}
