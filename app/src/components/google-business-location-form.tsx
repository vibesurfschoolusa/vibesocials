"use client";

import { useState } from "react";

interface Props {
  initialLocationName?: string | null;
}

interface RemoteLocation {
  resourceName: string;
  title: string | null;
  storeCode: string | null;
  address: string | null;
  accountName: string | null;
}

export function GoogleBusinessLocationForm({ initialLocationName }: Props) {
  const [locationName, setLocationName] = useState(initialLocationName ?? "");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [locations, setLocations] = useState<RemoteLocation[] | null>(null);
  const [loadingLocations, setLoadingLocations] = useState(false);
  const [locationsError, setLocationsError] = useState<string | null>(null);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setMessage(null);
    setError(null);

    const trimmed = locationName.trim();
    if (!trimmed) {
      setError("Location or store code is required.");
      return;
    }

    setSaving(true);

    try {
      const response = await fetch("/api/connections/google_business_profile/location", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ locationName: trimmed }),
      });

      const data = await response.json().catch(() => null);

      if (!response.ok) {
        setError(data?.error ?? "Failed to save location.");
        setSaving(false);
        return;
      }

      setMessage("Saved. Future posts will use this Maps location.");
      setSaving(false);
    } catch (_err) {
      setError("Unexpected error while saving location.");
      setSaving(false);
    }
  }

  async function handleFetchLocations() {
    setLocationsError(null);
    setMessage(null);
    setError(null);
    setLoadingLocations(true);

    try {
      const response = await fetch("/api/connections/google_business_profile/locations");
      const data = await response.json().catch(() => null);

      if (!response.ok) {
        setLocations(null);
        setLocationsError(data?.error ?? "Failed to load locations from Google.");
        setLoadingLocations(false);
        return;
      }

      const list = Array.isArray(data?.locations) ? (data.locations as RemoteLocation[]) : [];
      setLocations(list);
      if (list.length === 0) {
        setLocationsError("No locations found for this Google account.");
      }
      setLoadingLocations(false);
    } catch (_err) {
      setLocations(null);
      setLocationsError("Unexpected error while loading locations.");
      setLoadingLocations(false);
    }
  }

  function handleSelectLocation(event: React.ChangeEvent<HTMLSelectElement>) {
    const value = event.target.value;
    if (!value) {
      return;
    }

    setLocationName(value);
    setMessage(null);
    setError(null);
  }

  return (
    <form onSubmit={handleSubmit} className="mt-2 space-y-1 text-xs">
      <label htmlFor="gbp-location" className="block font-medium">
        Maps business location (resource or store code)
      </label>
      <input
        id="gbp-location"
        name="locationName"
        type="text"
        className="w-full rounded border border-zinc-300 px-2 py-1 text-[11px] font-mono text-gray-900 placeholder:text-gray-400 focus:outline-none focus:ring-1 focus:ring-zinc-900"
        placeholder="Store code from Advanced settings, or accounts/{accountId}/locations/{locationId}"
        value={locationName}
        onChange={(event) => setLocationName(event.target.value)}
      />
      <div className="flex items-center justify-between pt-1">
        <button
          type="button"
          disabled={loadingLocations}
          onClick={handleFetchLocations}
          className="rounded border border-zinc-300 px-2 py-1 text-[11px] font-medium text-zinc-900 hover:bg-zinc-50 disabled:opacity-70"
        >
          {loadingLocations ? "Loading locations..." : "Fetch locations from Google"}
        </button>
        {locationsError && (
          <span className="text-[11px] text-red-600">{locationsError}</span>
        )}
      </div>
      {locations && locations.length > 0 && (
        <div className="pt-1">
          <label htmlFor="gbp-location-select" className="block text-[11px] font-medium">
            Or pick a location
          </label>
          <select
            id="gbp-location-select"
            className="mt-1 w-full rounded border border-zinc-300 px-2 py-1 text-[11px] text-gray-900 focus:outline-none focus:ring-1 focus:ring-zinc-900"
            defaultValue=""
            onChange={handleSelectLocation}
          >
            <option value="">Select a location</option>
            {locations.map((loc) => {
              const parts: string[] = [];
              if (loc.title) parts.push(loc.title);
              if (loc.address) parts.push(loc.address);
              if (loc.storeCode) parts.push(`Store code: ${loc.storeCode}`);
              if (loc.accountName) parts.push(`Account: ${loc.accountName}`);
              const label = parts.join(" · ");

              return (
                <option key={loc.resourceName} value={loc.resourceName}>
                  {label || loc.resourceName}
                </option>
              );
            })}
          </select>
        </div>
      )}
      <div className="flex items-center justify-between">
        <button
          type="submit"
          disabled={saving}
          className="rounded bg-black px-2 py-1 text-[11px] font-medium text-white hover:bg-zinc-800 disabled:opacity-70"
        >
          {saving ? "Saving..." : "Save location"}
        </button>
        {message && <span className="text-[11px] text-emerald-700">{message}</span>}
        {error && <span className="text-[11px] text-red-600">{error}</span>}
      </div>
    </form>
  );
}

