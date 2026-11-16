"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { useToast } from "@/components/ui/toast";
import { gbpSignInUrl } from "@/lib/gbpSignIn";

import { SignInAgainLink } from "./gbp-sign-in-link";

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
  // R25 (KK1): the route words an empty list itself (its `notice`); this is only
  // for an answer without one, and names no control.
  noLocations:
    "Google sent no locations for this Google account. Check in Google Business Profile that this account manages your listing.",
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
  data: { error?: string; code?: string; signIn?: unknown } | null,
  fallback: string,
  workspaceId: string,
): { message: string; reconnect: boolean; signInUrl: string | null } {
  const reconnect = data?.code === LOCATION_RECONNECT_CODE;
  return {
    message: data?.error ?? fallback,
    reconnect,
    // JJ3 lead review: the route only says to sign in again; the link names the
    // workspace this form was drawn for (lib/gbpSignIn.ts), never one from the answer.
    // R25: a reconnect answer refreshes the card to its own Reconnect button (the
    // same URL), so the form adds no second control for that step.
    signInUrl: data?.signIn === true && !reconnect ? gbpSignInUrl(workspaceId) : null,
  };
}

/** A sentence in the form's status region, with the in-place sign-in link when it is the step. */
export interface PickerStatus {
  message: string;
  signInUrl: string | null;
}

/**
 * What a loaded list says (JJ3 lead review): the route's `notice` (accounts
 * whose locations could not be read, or, R25 KK1, an empty list), else, for an
 * empty list, the form's fallback; null when there is nothing to say. The
 * in-place sign-in shows when the 200 answer says `signIn: true`, built from
 * this form's workspace, never from the answer.
 */
export function locationsLoadedStatus(
  count: number,
  data: { notice?: unknown; signIn?: unknown } | null,
  workspaceId: string,
): PickerStatus | null {
  const notice = typeof data?.notice === "string" && data.notice ? data.notice : null;
  const message = notice ?? (count === 0 ? LOCATION_MESSAGES.noLocations : null);
  if (!message) return null;
  return { message, signInUrl: data?.signIn === true ? gbpSignInUrl(workspaceId) : null };
}

/** LL2 lead review: said by the dropdown while a save runs, so a change that springs back has a reason. */
export const PICK_SAVING_STATUS = "Saving…";

/** The one sentence of the dropdown's status region: Saving… while a save runs, then a pick's failure, else nothing. */
export function pickStatusText(saving: boolean, failure: PickerStatus | null): string {
  if (saving) return PICK_SAVING_STATUS;
  return failure?.message ?? "";
}

/** Lead review: which control a save came from, so its failure shows by that control. */
export type SavePlace = "pick" | "field";

export interface SaveFailure {
  from: SavePlace;
  status: PickerStatus;
}

export function saveFailureAt(failure: SaveFailure | null, place: SavePlace): PickerStatus | null {
  return failure?.from === place ? failure.status : null;
}

/**
 * R26 new-customer L1: what the dropdown shows once a save ends. After a failed
 * pick it goes back to its placeholder, so picking the same location fires a
 * change and saves again; a save from the Advanced field leaves it there too.
 */
export function pickAfterSave(name: string, from: SavePlace, ok: boolean): string {
  return ok && from === "pick" ? name : "";
}

/**
 * The line under "Maps business location": the saved location by its Google
 * name, else (R26 new-customer L1: an Advanced save has no name) by what was
 * saved, else the first step.
 */
export function savedLocationLine(title: string | null, name: string | null): string {
  if (title) return `Posting to ${title}. Load your locations again to choose another.`;
  const saved = name?.trim();
  if (saved) return `Posting to the location you saved (${saved}). Load your locations from Google to choose by name.`;
  return "Load your locations from Google and choose the one to post to.";
}

/** R25 pages L4: one sentence of the status region, which stays until the next fetch or save. */
export function PickerStatusLine({ status }: { status: PickerStatus }) {
  return (
    <div className="flex flex-col items-start gap-2">
      <p className="text-sm text-muted-foreground">{status.message}</p>
      {status.signInUrl ? <SignInAgainLink href={status.signInUrl} /> : null}
    </div>
  );
}

export function GoogleBusinessLocationForm({ workspaceId, initialLocationName, initialLocationTitle }: Props) {
  const toast = useToast();
  const router = useRouter();
  const [locationName, setLocationName] = useState(initialLocationName ?? "");
  const [savedTitle, setSavedTitle] = useState(initialLocationTitle ?? null);
  const [savedName, setSavedName] = useState(initialLocationName ?? null);
  // R26 new-customer L1: the dropdown's value, controlled so a failed save can empty it.
  const [picked, setPicked] = useState("");
  const [saving, setSaving] = useState(false);
  const [locations, setLocations] = useState<RemoteLocation[] | null>(null);
  const [loadingLocations, setLoadingLocations] = useState(false);
  // R25 pages L4: the last fetch's failure and what the loaded list says, by
  // Fetch; the last save's failure, by the control that saved (lead review).
  // Each shows in a status region that stays, and only there (no toast), so a
  // screen reader hears it once. A save's success is still a toast.
  const [fetchFailure, setFetchFailure] = useState<PickerStatus | null>(null);
  const [listNote, setListNote] = useState<PickerStatus | null>(null);
  const [saveFailure, setSaveFailure] = useState<SaveFailure | null>(null);
  const pickFailure = saveFailureAt(saveFailure, "pick");
  const pickStatus = pickStatusText(saving, pickFailure);
  const fieldFailure = saveFailureAt(saveFailure, "field");

  // Saves a location: picked from Google's list (with its name, saved at once)
  // or typed in the Advanced field (no name). 2026-11-09 first-run check:
  // picking from the list only filled the Advanced field, so a new user's
  // choice was silently never saved.
  async function saveLocation(name: string, title: string | null, from: SavePlace) {
    setSaving(true);
    setSaveFailure(null);

    try {
      const response = await fetch("/api/connections/google_business_profile/location", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ locationName: name, locationTitle: title, workspaceId }),
      });

      const data = (await response.json().catch(() => null)) as
        | { error?: string; code?: string; signIn?: unknown }
        | null;

      if (!response.ok) {
        const failed = locationFailure(data, LOCATION_MESSAGES.saveFailed, workspaceId);
        setSaveFailure({ from, status: { message: failed.message, signInUrl: failed.signInUrl } });
        setPicked(pickAfterSave(name, from, false));
        setSaving(false);
        if (failed.reconnect) router.refresh();
        return;
      }

      setSavedTitle(title);
      setSavedName(name);
      setPicked(pickAfterSave(name, from, true));
      toast.success(
        title ? `Saved. Posts will go to ${title} on Google Maps.` : "Saved. Future posts will use this Maps location.",
      );
      setSaving(false);
      // Settings' "Connected as" label is server-rendered from the saved name.
      router.refresh();
    } catch {
      setSaveFailure({ from, status: { message: LOCATION_MESSAGES.saveOffline, signInUrl: null } });
      setPicked(pickAfterSave(name, from, false));
      setSaving(false);
    }
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();

    const trimmed = locationName.trim();
    if (!trimmed) {
      setSaveFailure({ from: "field", status: { message: "Enter a location resource name or store code.", signInUrl: null } });
      return;
    }
    await saveLocation(trimmed, null, "field");
  }

  async function handleFetchLocations() {
    setLoadingLocations(true);
    setFetchFailure(null);
    setListNote(null);
    setSaveFailure(null);

    try {
      const response = await fetch("/api/connections/google_business_profile/locations");
      const data = (await response.json().catch(() => null)) as
        | { locations?: RemoteLocation[]; error?: string; code?: string; notice?: string; signIn?: unknown }
        | null;

      if (!response.ok) {
        setLocations(null);
        const failed = locationFailure(data, LOCATION_MESSAGES.loadFailed, workspaceId);
        setFetchFailure({ message: failed.message, signInUrl: failed.signInUrl });
        setLoadingLocations(false);
        if (failed.reconnect) router.refresh();
        return;
      }

      const list: RemoteLocation[] =
        data && Array.isArray(data.locations) ? data.locations : [];
      setLocations(list);
      setListNote(locationsLoadedStatus(list.length, data, workspaceId));
      setLoadingLocations(false);
    } catch {
      setLocations(null);
      setFetchFailure({ message: LOCATION_MESSAGES.loadOffline, signInUrl: null });
      setLoadingLocations(false);
    }
  }

  function handleSelectLocation(event: React.ChangeEvent<HTMLSelectElement>) {
    const value = event.target.value;
    // The dropdown stays focusable while a save runs (R26 pages L1); a change
    // then is ignored, and the controlled value stays on the one being saved.
    if (!value || saving) {
      return;
    }
    setPicked(value);
    setLocationName(value);
    const picked = locations?.find((loc) => loc.resourceName === value);
    void saveLocation(value, picked?.title ?? null, "pick");
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Primary flow: pull the account's locations from Google and pick one. */}
      <div className="flex flex-col gap-2">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <p className="text-sm font-medium text-foreground">Maps business location</p>
            <p className="text-sm text-muted-foreground">
              {savedLocationLine(savedTitle, savedName)}
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
        {/* Live regions that stay on the page, so their sentences are announced when they appear.
            The access wording is the route's own (its `error`), never this form's. */}
        <div id="gbp-fetch-status" role="status" className="flex flex-col gap-3 empty:sr-only">
          {fetchFailure ? <PickerStatusLine status={fetchFailure} /> : null}
          {listNote ? <PickerStatusLine status={listNote} /> : null}
        </div>

        {locations && locations.length > 0 ? (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="gbp-location-select">Choose a location</Label>
            <Select
              id="gbp-location-select"
              aria-describedby="gbp-pick-status"
              value={picked}
              onChange={handleSelectLocation}
              aria-disabled={saving}
              className="aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
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
            </Select>
          </div>
        ) : null}
        {/* One live region by the dropdown, on the page from the first render; its
            one sentence changes (Saving…, the failure, or nothing), so a screen
            reader hears each change once. */}
        <div id="gbp-pick-status" role="status" className={pickStatus ? "flex flex-col items-start gap-2" : "sr-only"}>
          <p className="text-sm text-muted-foreground">{pickStatus}</p>
          {!saving && pickFailure?.signInUrl ? <SignInAgainLink href={pickFailure.signInUrl} /> : null}
        </div>
      </div>

      {/* Secondary/advanced: paste a resource name or store code directly. */}
      <form onSubmit={handleSubmit} className="flex flex-col gap-1.5 border-t border-border pt-4">
        <Label htmlFor="gbp-location">Advanced: resource name or store code</Label>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input
            id="gbp-location"
            aria-describedby="gbp-save-status"
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
        <div id="gbp-save-status" role="status" className="empty:sr-only">
          {fieldFailure ? <PickerStatusLine status={fieldFailure} /> : null}
        </div>
        <p className="text-xs text-muted-foreground">
          Choosing a location above saves it right away. You can also paste a resource name or
          store code here and save it.
        </p>
      </form>
    </div>
  );
}
