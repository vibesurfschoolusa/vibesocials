"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { useToast } from "@/components/ui/toast";

interface Props {
  /** The workspace this page was rendered for; the route refuses any other (F3). */
  workspaceId: string;
  initialLocationName?: string | null;
  /** The saved location's name, from Google's list (null for a pasted store code). */
  initialLocationTitle?: string | null;
}

interface RemoteLocation {
  resourceName: string;
  title: string | null;
  storeCode: string | null;
  address: string | null;
  accountName: string | null;
}

/** What the form says when something didn't work (R5 new-customer L8, pages L8). */
export const LOCATION_MESSAGES = {
  noLocations:
    "This Google account has no business listing we can post to. Press Switch account above and sign in with the Google account that manages your listing (an owner or manager in Google Business Profile).",
  saveFailed: "The location wasn't saved. Please try again in a minute.",
  saveOffline:
    "We couldn't reach Vibe Socials, so the location wasn't saved. Check your internet connection and try again.",
  loadFailed: "Google didn't send the list of locations. Please press Fetch locations from Google again in a minute.",
  loadOffline:
    "We couldn't reach Vibe Socials, so the locations weren't loaded. Check your internet connection and try again.",
} as const;

/**
 * The code both location routes send when the Google grant is dead (gbpLocations.ts,
 * GBP_RECONNECT_CODE). This file is client code, so it is repeated here; a test
 * keeps the two equal.
 */
export const LOCATION_RECONNECT_CODE = "RECONNECT_REQUIRED";

/**
 * What a failed answer shows: the route's own text, else `fallback`. `reconnect`
 * (R24 platform-clients L1) means the card should refresh so its server-rendered
 * Reconnect state shows without a manual reload.
 */
export function locationFailure(
  data: { error?: string; code?: string } | null,
  fallback: string,
): { message: string; reconnect: boolean } {
  return { message: data?.error ?? fallback, reconnect: data?.code === LOCATION_RECONNECT_CODE };
}

export function GoogleBusinessLocationForm({ workspaceId, initialLocationName, initialLocationTitle }: Props) {
  const toast = useToast();
  const router = useRouter();
  const [locationName, setLocationName] = useState(initialLocationName ?? "");
  const [savedTitle, setSavedTitle] = useState(initialLocationTitle ?? null);
  const [saving, setSaving] = useState(false);
  const [locations, setLocations] = useState<RemoteLocation[] | null>(null);
  const [loadingLocations, setLoadingLocations] = useState(false);

  // Saves a location: picked from Google's list (with its name, saved at once)
  // or typed in the Advanced field (no name). 2026-11-09 first-run check:
  // picking from the list only filled the Advanced field, so a new user's
  // choice was silently never saved.
  async function saveLocation(name: string, title: string | null) {
    setSaving(true);

    try {
      const response = await fetch("/api/connections/google_business_profile/location", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ locationName: name, locationTitle: title, workspaceId }),
      });

      const data = (await response.json().catch(() => null)) as { error?: string; code?: string } | null;

      if (!response.ok) {
        const failure = locationFailure(data, LOCATION_MESSAGES.saveFailed);
        toast.error(failure.message);
        setSaving(false);
        if (failure.reconnect) router.refresh();
        return;
      }

      setSavedTitle(title);
      toast.success(
        title ? `Saved. Posts will go to ${title} on Google Maps.` : "Saved. Future posts will use this Maps location.",
      );
      setSaving(false);
      // Settings' "Connected as" label is server-rendered from the saved name.
      router.refresh();
    } catch {
      toast.error(LOCATION_MESSAGES.saveOffline);
      setSaving(false);
    }
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();

    const trimmed = locationName.trim();
    if (!trimmed) {
      toast.error("Enter a location resource name or store code.");
      return;
    }
    await saveLocation(trimmed, null);
  }

  async function handleFetchLocations() {
    setLoadingLocations(true);

    try {
      const response = await fetch("/api/connections/google_business_profile/locations");
      const data = (await response.json().catch(() => null)) as
        | { locations?: RemoteLocation[]; error?: string; code?: string }
        | null;

      if (!response.ok) {
        setLocations(null);
        const failure = locationFailure(data, LOCATION_MESSAGES.loadFailed);
        toast.error(failure.message);
        setLoadingLocations(false);
        if (failure.reconnect) router.refresh();
        return;
      }

      const list: RemoteLocation[] =
        data && Array.isArray(data.locations) ? data.locations : [];
      setLocations(list);
      if (list.length === 0) {
        toast.info(LOCATION_MESSAGES.noLocations);
      }
      setLoadingLocations(false);
    } catch {
      setLocations(null);
      toast.error(LOCATION_MESSAGES.loadOffline);
      setLoadingLocations(false);
    }
  }

  function handleSelectLocation(event: React.ChangeEvent<HTMLSelectElement>) {
    const value = event.target.value;
    if (!value) {
      return;
    }
    setLocationName(value);
    const picked = locations?.find((loc) => loc.resourceName === value);
    void saveLocation(value, picked?.title ?? null);
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Primary flow: pull the account's locations from Google and pick one. */}
      <div className="flex flex-col gap-2">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <p className="text-sm font-medium text-foreground">Maps business location</p>
            <p className="text-sm text-muted-foreground">
              {savedTitle
                ? `Posting to ${savedTitle}. Load your locations again to choose another.`
                : "Load your locations from Google and choose the one to post to."}
            </p>
          </div>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={handleFetchLocations}
            loading={loadingLocations}
            className="shrink-0"
          >
            {loadingLocations ? "Loading…" : "Fetch locations from Google"}
          </Button>
        </div>

        {locations && locations.length > 0 ? (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="gbp-location-select">Choose a location</Label>
            <Select id="gbp-location-select" defaultValue="" onChange={handleSelectLocation} disabled={saving}>
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
            </Select>
          </div>
        ) : null}
      </div>

      {/* Secondary/advanced: paste a resource name or store code directly. */}
      <form onSubmit={handleSubmit} className="flex flex-col gap-1.5 border-t border-border pt-4">
        <Label htmlFor="gbp-location">Advanced: resource name or store code</Label>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input
            id="gbp-location"
            name="locationName"
            className="font-mono text-xs"
            placeholder="accounts/{accountId}/locations/{locationId}, or a store code"
            value={locationName}
            onChange={(event) => setLocationName(event.target.value)}
          />
          <Button type="submit" size="sm" loading={saving} className="shrink-0 sm:w-auto">
            {saving ? "Saving…" : "Save location"}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          Choosing a location above saves it right away. You can also paste a resource name or
          store code here and save it.
        </p>
      </form>
    </div>
  );
}
