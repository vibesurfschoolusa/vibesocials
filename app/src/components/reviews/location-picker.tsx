import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import type { Location } from "./types";

interface LocationPickerProps {
  locations: Location[];
  selectedLocation: string | null;
  onChange: (locationName: string) => void;
}

/**
 * Dropdown for choosing which business location's reviews to show.
 */
export function LocationPicker({
  locations,
  selectedLocation,
  onChange,
}: LocationPickerProps) {
  return (
    <div className="mb-8">
      <Label htmlFor="location-picker" className="mb-2 block">
        Select location
      </Label>
      <div className="max-w-md">
        <Select
          id="location-picker"
          value={selectedLocation || ""}
          onChange={(e) => onChange(e.target.value)}
        >
          <option value="">Choose a location...</option>
          {locations.map((loc) => (
            <option key={loc.name} value={loc.name}>
              {loc.title}
              {loc.storeCode && ` (${loc.storeCode})`}
            </option>
          ))}
        </Select>
      </div>
    </div>
  );
}
