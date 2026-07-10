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
      <label
        htmlFor="location-picker"
        className="block text-sm font-medium text-gray-700 mb-2"
      >
        Select Location
      </label>
      <select
        id="location-picker"
        value={selectedLocation || ""}
        onChange={(e) => onChange(e.target.value)}
        className="w-full max-w-md rounded-lg border border-gray-300 px-4 py-2 text-gray-900 focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 outline-none"
      >
        <option value="">Choose a location...</option>
        {locations.map((loc) => (
          <option key={loc.name} value={loc.name}>
            {loc.title}
            {loc.storeCode && ` (${loc.storeCode})`}
          </option>
        ))}
      </select>
    </div>
  );
}
