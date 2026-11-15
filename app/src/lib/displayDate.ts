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

/**
 * R6-security M1: why a confirm link can't move this account to an address
 * another account's undo may still take back. Shared like the one above.
 */
export function addressHeldSentence(until: string | Date): string {
  return `This address was another Vibe Socials account's sign-in email until recently, and that account can take it back until ${formatDisplayDate(until)}, so your email is unchanged. After that, ask for the change again in Settings, Account.`;
}
