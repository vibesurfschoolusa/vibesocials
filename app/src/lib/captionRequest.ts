/**
 * R24 new-customer L3: Create's "Improve caption" and "Caption from media"
 * showed the browser's raw "Failed to fetch" / "Load failed" when the request
 * never left. One request for both, whose failure is a sentence the person can
 * act on, the way requestDisconnect does it for Connections.
 */

import { fetchOrNoAnswer } from "./requestNoAnswer";

export const CAPTION_OFFLINE_MESSAGE =
  "We couldn't reach Vibe Socials, so your caption is unchanged. Check your connection and try again.";
export const CAPTION_FAILED_MESSAGE =
  "Something went wrong on our side, so your caption is unchanged. Please try again in a minute.";

/** A 200 with no caption in it: the box keeps what it had. */
export const CAPTION_EMPTY_MESSAGE =
  "The AI sent back no caption, so your caption is unchanged. Try again, or write it yourself.";

export type CaptionRequestResult = { ok: true; caption: string } | { ok: false; error: string };

/**
 * POSTs `body` as JSON to a caption route. Success gives the answer's `field`
 * when it is text that is not blank;
 * a refusal gives the route's own `error` text; no answer, or one that is not
 * JSON, gives ours.
 */
export async function requestCaption(
  url: string,
  body: unknown,
  field: string,
  fetchImpl: typeof fetch = fetch,
): Promise<CaptionRequestResult> {
  let response: Response;
  try {
    response = await fetchOrNoAnswer(
      url,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
      fetchImpl,
    );
  } catch {
    return { ok: false, error: CAPTION_OFFLINE_MESSAGE };
  }
  const data = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (!response.ok) {
    const error = data?.error;
    return { ok: false, error: typeof error === "string" && error ? error : CAPTION_FAILED_MESSAGE };
  }
  if (data === null || typeof data !== "object") return { ok: false, error: CAPTION_FAILED_MESSAGE };
  const caption = data[field];
  if (typeof caption !== "string" || !caption.trim()) return { ok: false, error: CAPTION_EMPTY_MESSAGE };
  return { ok: true, caption };
}
