import type { Location } from "./types";

/**
 * What each option in the location picker reads, keyed by the location's id.
 * The id (and store code) never appear: people only need the name. Two or more
 * locations with the same name get their address, or "location 1", "location 2"
 * in list order when there is no address (or two share one).
 */
export function locationLabels(locations: Location[]): Map<string, string> {
  const byTitle = new Map<string, Location[]>();
  for (const loc of locations) {
    byTitle.set(loc.title, [...(byTitle.get(loc.title) ?? []), loc]);
  }
  const labels = new Map<string, string>();
  for (const group of byTitle.values()) {
    group.forEach((loc, index) => {
      if (group.length === 1) {
        labels.set(loc.name, loc.title);
        return;
      }
      const address = loc.address?.trim();
      const unique = address && group.filter((other) => other.address?.trim() === address).length === 1;
      labels.set(loc.name, `${loc.title} (${unique ? address : `location ${index + 1}`})`);
    });
  }
  return labels;
}
