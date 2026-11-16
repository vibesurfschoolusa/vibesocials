import type { Location } from "./types";

/**
 * The location /reviews opens with: the one Settings saved for Google posts
 * when Google lists it, else the only one there is, else none (the person
 * picks). A saved store code (R27 client-journey L2: Settings' Advanced field)
 * opens the one listed location with that code; two sharing it ask.
 */
export function initialLocation(locations: Location[], savedLocation: string | null): string | null {
  if (savedLocation && locations.some((loc) => loc.name === savedLocation)) return savedLocation;
  if (savedLocation) {
    const byCode = locations.filter((loc) => loc.storeCode === savedLocation);
    if (byCode.length === 1) return byCode[0].name;
  }
  return locations.length === 1 ? locations[0].name : null;
}
