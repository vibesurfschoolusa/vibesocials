/**
 * What the location autocomplete's lookup effect should do for the current
 * input value (2026-11-01 audit).
 *
 * - `clear`  - too short to search (< 2 non-blank chars): drop any suggestions.
 * - `skip`   - the value is exactly what picking a suggestion just wrote into
 *   the field. Looking it up again re-opened the dropdown ~300ms after the
 *   selection, so it is suppressed.
 * - `search` - fetch suggestions for what the user typed.
 *
 * Pure so the rule is unit-testable without a render harness.
 */
export type LocationLookupAction = "clear" | "skip" | "search";

export function locationLookupAction(
  value: string,
  suppressedValue: string | null,
): LocationLookupAction {
  if (value.trim().length < 2) return "clear";
  if (suppressedValue !== null && value === suppressedValue) return "skip";
  return "search";
}
