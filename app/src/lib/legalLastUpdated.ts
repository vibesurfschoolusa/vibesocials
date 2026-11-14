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
