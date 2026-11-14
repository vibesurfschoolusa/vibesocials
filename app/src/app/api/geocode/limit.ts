/**
 * The geocode route's refusal once the whole app has used its paid lookups for
 * the UTC day (F5). Shared with the location box (location-autocomplete.tsx),
 * which shows the sentence while typing keeps working. No server imports: this
 * file is read by browser code.
 */
export const GEOCODE_DAILY_LIMIT_CODE = "GEOCODE_DAILY_LIMIT";

export const GEOCODE_DAILY_LIMIT_MESSAGE =
  "Place suggestions are off for the rest of today. Type the place in full; it is saved as you type it.";

/** The sentence to show under the box for this answer, or null. */
export function geocodeLimitNote(status: number, body: unknown): string | null {
  if (status !== 429 || typeof body !== "object" || body === null) return null;
  const { code, error } = body as { code?: unknown; error?: unknown };
  return code === GEOCODE_DAILY_LIMIT_CODE && typeof error === "string" ? error : null;
}
