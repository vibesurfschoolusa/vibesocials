import { NextResponse } from "next/server";

import { LIMIT_UNCHECKED_MESSAGE } from "./limitUncheckedMessage";

export { LIMIT_UNCHECKED_MESSAGE };

/** The JSON answer: `503 { error }` with a one-minute Retry-After. */
export function limitUncheckedResponse(): NextResponse {
  return NextResponse.json({ error: LIMIT_UNCHECKED_MESSAGE }, { status: 503, headers: { "Retry-After": "60" } });
}
