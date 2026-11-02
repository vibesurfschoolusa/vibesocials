import { NextResponse } from "next/server";

import { CAPTION_TOO_LONG_CODE, captionTooLongMessage } from "@/lib/captionLimits";

/** The 400 body every JSON route returns when `readJsonObject` yields null. */
export const INVALID_JSON_BODY_ERROR = "Invalid JSON body";

/**
 * Reads a request body that a route is about to index into (`body.foo`) and
 * returns it ONLY if it is a plain JSON object.
 *
 * `request.json()` happily resolves to `null`, an array, a number, a string or
 * a boolean for perfectly valid JSON — destructuring or indexing those (e.g.
 * `const { caption } = body` on `null`) throws a TypeError and the route 500s.
 * Returns `null` for all of those AND for a body that isn't valid JSON at all
 * (or is empty), so callers need exactly one check:
 *
 *   const body = await readJsonObject(request);
 *   if (!body) return invalidJsonBodyResponse();
 *
 * Routes whose body is optional use `(await readJsonObject(request)) ?? {}`.
 */
export async function readJsonObject(
  request: Pick<Request, "json">,
): Promise<Record<string, unknown> | null> {
  let parsed: unknown;
  try {
    parsed = await request.json();
  } catch {
    return null;
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  const proto = Object.getPrototypeOf(parsed);
  if (proto !== Object.prototype && proto !== null) {
    return null;
  }
  return parsed as Record<string, unknown>;
}

/** `400 { error: "Invalid JSON body" }` — the response paired with `readJsonObject`. */
export function invalidJsonBodyResponse(): NextResponse {
  return NextResponse.json({ error: INVALID_JSON_BODY_ERROR }, { status: 400 });
}

/**
 * 2026-11-01 scale audit (jobs, event size): `400 { code: "CAPTION_TOO_LONG", error }`
 * for a caption over MAX_CAPTION_CHARS. `field` is the name
 * `findOverlongCaption` returned (`baseCaption`, `perPlatformOverrides.<platform>`).
 */
export function captionTooLongResponse(field: string): NextResponse {
  return NextResponse.json(
    { error: captionTooLongMessage(field), code: CAPTION_TOO_LONG_CODE },
    { status: 400 },
  );
}
