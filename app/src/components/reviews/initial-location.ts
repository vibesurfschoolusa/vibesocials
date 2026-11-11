import type { Location } from "./types";

/**
 * The location /reviews opens with: the one Settings saved for Google posts
 * when Google lists it, else the only one there is, else none (the person
 * picks). A pasted store code never matches a listed name, so it asks.
 */
export function initialLocation(locations: Location[], savedLocation: string | null): string | null {
  if (savedLocation && locations.some((loc) => loc.name === savedLocation)) return savedLocation;
  return locations.length === 1 ? locations[0].name : null;
}
