/**
 * The word beside a count: the singular for exactly 1, the plural for every
 * other number, 0 included. A missing count (shown as "—") reads as plural.
 */
export function countWord(count: number | null, one: string, many: string): string {
  return count === 1 ? one : many;
}
