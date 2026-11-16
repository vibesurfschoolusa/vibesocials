import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { locationLabels } from "./location-labels";
import type { Location } from "./types";

interface LocationPickerProps {
  locations: Location[];
  selectedLocation: string | null;
  onChange: (locationName: string) => void;
  /** R27 lead review: the page belongs to another workspace; picks are ignored until Reload. */
  locked?: boolean;
}

/** A pick reaches `onChange` only while the picker is not locked; locked, the value stays. */
export function pickLocation(value: string, locked: boolean, onChange: (locationName: string) => void): void {
  if (!locked) onChange(value);
}

/**
 * Dropdown for choosing which business location's reviews to show.
 */
export function LocationPicker({
  locations,
  selectedLocation,
  onChange,
  locked = false,
}: LocationPickerProps) {
  const labels = locationLabels(locations);
  return (
    <div className="mb-8">
      <Label htmlFor="location-picker" className="mb-2 block">
        Select location
      </Label>
      <div className="max-w-md">
        <Select
          id="location-picker"
          value={selectedLocation || ""}
          onChange={(e) => pickLocation(e.target.value, locked, onChange)}
          // Stays focusable (aria-disabled, not disabled), so focus never drops.
          aria-disabled={locked || undefined}
          className="aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
        >
          <option value="">Choose a location...</option>
          {locations.map((loc) => (
            <option key={loc.name} value={loc.name}>
              {labels.get(loc.name)}
            </option>
          ))}
        </Select>
      </div>
    </div>
  );
}
