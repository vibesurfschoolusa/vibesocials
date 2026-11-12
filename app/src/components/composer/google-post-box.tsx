"use client";

import { ChevronDown } from "lucide-react";

import { GooglePostSettings } from "@/components/google-post-settings";
import { cn } from "@/lib/cn";
import {
  GOOGLE_BUTTON_LABELS,
  GOOGLE_POST_TYPE_LABELS,
  parseGooglePostMetadata,
  type GooglePostType,
} from "@/lib/googlePostOptions";
import type { GoogleBusinessPostMetadata } from "@/server/platforms/types";

/** The one line the closed box shows: "Google post: Update, button Book". */
export function googlePostSummary(metadata: GoogleBusinessPostMetadata): string {
  const type = `Google post: ${GOOGLE_POST_TYPE_LABELS[metadata.postType]}`;
  // An offer can't carry a button, so it names none.
  if (metadata.postType === "offer") return type;
  return metadata.button ? `${type}, button ${GOOGLE_BUTTON_LABELS[metadata.button.type]}` : `${type}, no button`;
}

/** An offer or an event has fields to fill in, so its box is open whatever the person chose. */
export function googleBoxShowsOpen(state: { open: boolean; postType: GooglePostType }): boolean {
  return state.open || state.postType !== "update";
}

/** Opened by Offer or Event, the box stays open when the person switches back, mid-edit. */
export function googleBoxOpenAfterChange(open: boolean, postType: GooglePostType): boolean {
  return open || postType !== "update";
}

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
  const shown = googleBoxShowsOpen({ open, postType: metadata.postType });
  const heldOpen = shown && !open;
  return (
    <div className="space-y-2">
      <button
        type="button"
        aria-expanded={shown}
        aria-controls="google-post-box-settings"
        disabled={heldOpen}
        onClick={() => onOpenChange(!open)}
        className="flex w-full items-center justify-between gap-2 rounded-[var(--radius)] border border-input px-3 py-2 text-left text-sm font-medium text-foreground outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default disabled:hover:bg-transparent"
      >
        <span>{googlePostSummary(metadata)}</span>
        {heldOpen ? null : (
          <ChevronDown aria-hidden className={cn("h-4 w-4 shrink-0 transition-transform", shown && "rotate-180")} />
        )}
      </button>
      <div id="google-post-box-settings" hidden={!shown}>
        <GooglePostSettings
          metadata={metadata}
          onChange={(next) => {
            if (googleBoxOpenAfterChange(open, next.postType) !== open) onOpenChange(true);
            onChange(next);
          }}
        />
      </div>
    </div>
  );
}
