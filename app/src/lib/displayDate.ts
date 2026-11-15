/**
 * R6-pages L8: the one way Settings writes a date ("November 21, 2026"), so
 * the account, team and connect-link lines read alike. In the browser it uses
 * the viewer's time zone.
 */
export function formatDisplayDate(value: string | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
}

/**
 * R6-security M1: why a new email change is refused while the previous
 * address can still undo the last one. Shared so the server's refusal and the
 * form, which writes it again in the viewer's time zone, say the same.
 */
export function emailChangeLockedSentence(until: string | Date): string {
  return `You changed your email recently; you can change it again after ${formatDisplayDate(until)}.`;
}
