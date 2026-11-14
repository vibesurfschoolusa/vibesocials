/**
 * Dates and times in notification emails (fix round 1, F4): in the
 * recipient's own time zone (User.timeZone, sent by their browser), with the
 * zone's abbreviation, or in UTC labelled as such when it is not known.
 */

/** A longer value is never a real IANA name; it is refused before Intl sees it. */
const MAX_TIME_ZONE_LENGTH = 64;

/** `zone` when Intl knows it as a time zone, else null. */
export function usableTimeZone(zone: string | null | undefined): string | null {
  if (typeof zone !== "string" || zone.length === 0 || zone.length > MAX_TIME_ZONE_LENGTH) return null;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return zone;
  } catch {
    return null;
  }
}

/** "Fri, Nov 13, 2026, 9:30 PM EST"; "..., 2:30 AM UTC" without a known zone. */
export function emailDateTime(date: Date, timeZone: string | null | undefined): string {
  return date.toLocaleString("en-US", {
    timeZone: usableTimeZone(timeZone) ?? "UTC",
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });
}

/** "Friday, November 13, 2026"; "... (UTC)" without a known zone. */
export function emailDate(date: Date, timeZone: string | null | undefined): string {
  const zone = usableTimeZone(timeZone);
  const day = date.toLocaleDateString("en-US", {
    timeZone: zone ?? "UTC",
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });
  return zone ? day : `${day} (UTC)`;
}
