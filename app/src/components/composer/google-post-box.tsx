"use client";

import { useRef, useState } from "react";
import { AlertTriangle, ChevronDown } from "lucide-react";

import { GooglePostSettings } from "@/components/google-post-settings";
import { cn } from "@/lib/cn";
import {
  GOOGLE_BUTTON_LABELS,
  GOOGLE_POST_TYPE_LABELS,
  parseGooglePostMetadata,
} from "@/lib/googlePostOptions";
import type { GoogleBusinessPostMetadata } from "@/server/platforms/types";

/** The one line the closed box shows: "Google post: Update, button Book". */
export function googlePostSummary(metadata: GoogleBusinessPostMetadata): string {
  const type = `Google post: ${GOOGLE_POST_TYPE_LABELS[metadata.postType]}`;
  // An offer can't carry a button, so it names none.
  if (metadata.postType === "offer") return type;
  return metadata.button ? `${type}, button ${GOOGLE_BUTTON_LABELS[metadata.button.type]}` : `${type}, no button`;
}

/**
 * Why the box may not fold right now, or null (fix round 1). A field the
 * browser or the app would refuse is never hidden: a hidden invalid url field
 * makes the browser block Publish without a word, and a bad link folded away
 * behind a fine-looking summary is never seen.
 */
export type GoogleBoxHold = "offer-or-event" | "fix-link" | null;

export function googleBoxHold(state: { metadata: GoogleBusinessPostMetadata; fieldsValid: boolean }): GoogleBoxHold {
  // An offer or an event has fields to fill in, so its box is open whatever the person chose.
  if (state.metadata.postType !== "update") return "offer-or-event";
  // An update's only field that can be refused is the button link.
  if (!state.fieldsValid || !parseGooglePostMetadata(state.metadata).ok) return "fix-link";
  return null;
}

/** Something the browser or the app would refuse: the summary carries a warning. */
function googleBoxNeedsFix(state: { metadata: GoogleBusinessPostMetadata; fieldsValid: boolean }): boolean {
  return !state.fieldsValid || !parseGooglePostMetadata(state.metadata).ok;
}

/** What a held-open box says in place of its fold control. */
export const GOOGLE_BOX_HOLD_REASONS: Record<Exclude<GoogleBoxHold, null>, string> = {
  "offer-or-event": "Open while it has an offer or event",
  "fix-link": "Open until the link is fixed",
};

export function googleBoxShowsOpen(state: { open: boolean; hold: GoogleBoxHold }): boolean {
  return state.open || state.hold !== null;
}

/**
 * Held open by a change (Offer, Event, a link to fix), the box stays open
 * after: switching back to Update or getting the link right mid-typing must
 * not snap it shut under the person's hands.
 */
export function googleBoxOpenAfterChange(
  open: boolean,
  next: { metadata: GoogleBusinessPostMetadata; fieldsValid: boolean },
): boolean {
  return open || googleBoxHold(next) !== null;
}

/** The browser's own check of every field in the box. */
export function allFieldsValid(fields: Iterable<{ validity: { valid: boolean } }>): boolean {
  for (const field of fields) if (!field.validity.valid) return false;
  return true;
}

const FIELDS = "input, select, textarea";

/** A press with a required Google field missing opens the box, so its message is seen. */
export function googleBoxOpensOnSubmit(state: { shown: boolean; metadata: GoogleBusinessPostMetadata }): boolean {
  return state.shown && !parseGooglePostMetadata(state.metadata).ok;
}

/**
 * The Google post settings behind a one-line summary (M1): open, the box sat
 * between the caption and Publish on every post. Collapsed it stays mounted
 * (only hidden), so the settings and what they send are exactly as before.
 */
export function GooglePostBox({
  metadata,
  onChange,
  open,
  onOpenChange,
}: {
  metadata: GoogleBusinessPostMetadata;
  onChange: (metadata: GoogleBusinessPostMetadata) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const settingsRef = useRef<HTMLDivElement>(null);
  // The browser's validity of the fields, read on change (a url field typed
  // as www.mysite.com is invalid to the browser before the app sees it).
  const [fieldsValid, setFieldsValid] = useState(true);
  const hold = googleBoxHold({ metadata, fieldsValid });
  const needsFix = googleBoxNeedsFix({ metadata, fieldsValid });
  const shown = googleBoxShowsOpen({ open, hold });

  // Read after the change has rendered, so a field that went away (a button
  // changed to Call) no longer counts.
  const readValidity = () => {
    requestAnimationFrame(() => {
      const box = settingsRef.current;
      if (!box) return;
      const valid = allFieldsValid(box.querySelectorAll<HTMLInputElement>(FIELDS));
      setFieldsValid(valid);
      if (!valid && !open) onOpenChange(true);
    });
  };

  const summary = (
    <span className="inline-flex items-center gap-1.5">
      {needsFix ? (
        <AlertTriangle data-google-box-warning="" aria-hidden className="h-4 w-4 shrink-0 text-warning" />
      ) : null}
      {googlePostSummary(metadata)}
      {needsFix ? <span className="sr-only"> (needs a fix)</span> : null}
    </span>
  );

  return (
    <div className="space-y-2">
      {hold !== null ? (
        // Held open: nothing to press, so no disabled button under the finger; it says why instead.
        <div className="rounded-[var(--radius)] border border-input px-3 py-2 text-sm font-medium text-foreground">
          {summary}
          <p className="text-xs font-normal text-muted-foreground">{GOOGLE_BOX_HOLD_REASONS[hold]}</p>
        </div>
      ) : (
        <button
          type="button"
          aria-expanded={shown}
          aria-controls="google-post-box-settings"
          onClick={() => onOpenChange(!open)}
          className="flex w-full items-center justify-between gap-2 rounded-[var(--radius)] border border-input px-3 py-2 text-left text-sm font-medium text-foreground outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
        >
          {summary}
          <ChevronDown aria-hidden className={cn("h-4 w-4 shrink-0 transition-transform", shown && "rotate-180")} />
        </button>
      )}
      <div
        id="google-post-box-settings"
        ref={settingsRef}
        hidden={!shown}
        onChange={readValidity}
        // The browser's own check on submit found a field it refuses: show it.
        onInvalidCapture={() => {
          setFieldsValid(false);
          if (!open) onOpenChange(true);
        }}
      >
        <GooglePostSettings
          metadata={metadata}
          onChange={(next) => {
            if (googleBoxOpenAfterChange(open, { metadata: next, fieldsValid }) !== open) onOpenChange(true);
            onChange(next);
          }}
        />
      </div>
    </div>
  );
}
