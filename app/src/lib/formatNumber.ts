/**
 * A count as people read it, with a thousands separator ("1,388"): the same
 * format the dashboard's Google listing card uses, so the report and the
 * dashboard print the same number the same way.
 */
export function formatNumber(value: number): string {
  return value.toLocaleString("en-US");
}
