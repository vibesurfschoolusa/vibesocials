import { BILLING_TERMS_LAST_UPDATED } from "./billingTerms";
import { LEGAL_LAST_UPDATED } from "./siteInfo";

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

/** "November 12, 2026", the way the legal pages write their date, as UTC milliseconds; NaN for anything else. */
export function legalDateValue(label: string): number {
  const match = /^([A-Z][a-z]+) (\d{1,2}), (\d{4})$/.exec(label);
  if (!match) return NaN;
  const month = MONTHS.indexOf(match[1] as (typeof MONTHS)[number]);
  const day = Number(match[2]);
  const year = Number(match[3]);
  if (month < 0) return NaN;
  const value = Date.UTC(year, month, day);
  // Date.UTC rolls "November 32" into December; refuse it instead.
  return new Date(value).getUTCDate() === day ? value : NaN;
}

/**
 * The Terms' and Privacy's "Last updated" with billing on. Those pages carry
 * the billing text and the rest of the page, so the date is the later of the
 * two. A date that cannot be read leaves the billing text's own date, so the
 * page still renders.
 */
export function billingOnLastUpdated(
  billing: string = BILLING_TERMS_LAST_UPDATED,
  legal: string = LEGAL_LAST_UPDATED,
): string {
  const billingValue = legalDateValue(billing);
  const legalValue = legalDateValue(legal);
  if (Number.isNaN(billingValue) || Number.isNaN(legalValue)) return billing;
  return legalValue > billingValue ? legal : billing;
}

/**
 * The privacy policy's own text date (F7, 2026-11-14: it now names every
 * number the app reads back, what clients send through links and what goes to
 * the AI provider). The Terms did not change, so they keep the shared date.
 * 2026-11-15 (R9-pages L3): it says how long the limits' post counts are kept.
 * 2026-11-15 (FF2 review): place search and Google Maps Platform are gone with the Location field.
 * 2026-11-16 (R36 pages note): a LinkedIn page name is read again regularly, not every day.
 * 2026-11-20 (R46 pages-a L7): TikTok names only video.publish, the scope the app asks for.
 */
export const PRIVACY_LAST_UPDATED = "November 20, 2026";

/**
 * The privacy policy's "Last updated": the latest of its own date, the shared
 * legal date and, with billing on, the billing text's date (the page carries
 * that text then). An unreadable date is skipped, so the page still renders one.
 */
export function privacyLastUpdated(
  billing: boolean,
  privacy: string = PRIVACY_LAST_UPDATED,
  legal: string = LEGAL_LAST_UPDATED,
  billingText: string = BILLING_TERMS_LAST_UPDATED,
): string {
  const candidates = billing ? [privacy, legal, billingText] : [privacy, legal];
  let latest = legal;
  let latestValue = legalDateValue(legal);
  for (const label of candidates) {
    const value = legalDateValue(label);
    if (Number.isNaN(value)) continue;
    if (Number.isNaN(latestValue) || value > latestValue) {
      latest = label;
      latestValue = value;
    }
  }
  return latest;
}
