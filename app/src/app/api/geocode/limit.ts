/**
 * The geocode route's refusals that the location box shows under the field
 * (location-autocomplete.tsx) while typing the place keeps working (F5). No
 * server imports: this file is read by browser code.
 */
export const GEOCODE_DAILY_LIMIT_CODE = "GEOCODE_DAILY_LIMIT";
export const GEOCODE_USER_LIMIT_CODE = "GEOCODE_USER_LIMIT";
export const GEOCODE_USER_DAY_LIMIT_CODE = "GEOCODE_USER_DAY_LIMIT";
export const GEOCODE_UNAVAILABLE_CODE = "GEOCODE_UNAVAILABLE";

export const GEOCODE_DAILY_LIMIT_MESSAGE =
  "Place suggestions are off for the rest of today. Type the place in full; it is saved as you type it.";
export const GEOCODE_USER_LIMIT_MESSAGE = "Too many place lookups. Wait a minute or type the place.";
export const GEOCODE_USER_DAY_LIMIT_MESSAGE =
  "You have used today's place suggestions. Type the place in full; it is saved as you type it.";
export const GEOCODE_UNAVAILABLE_MESSAGE = "Place suggestions aren't available right now. Type the place.";

const SHOWN = new Map<number, string[]>([
  [429, [GEOCODE_DAILY_LIMIT_CODE, GEOCODE_USER_LIMIT_CODE, GEOCODE_USER_DAY_LIMIT_CODE]],
  [503, [GEOCODE_UNAVAILABLE_CODE]],
]);

/** The sentence to show under the box for this answer, or null. */
export function geocodeLimitNote(status: number, body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const { code, error } = body as { code?: unknown; error?: unknown };
  const codes = SHOWN.get(status) ?? [];
  return typeof code === "string" && codes.includes(code) && typeof error === "string" ? error : null;
}
