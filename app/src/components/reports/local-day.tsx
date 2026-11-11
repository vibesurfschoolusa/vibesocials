"use client";

import { useSyncExternalStore } from "react";

/** A post's date as the report writes it; without a zone, in the viewer's own. */
export function reportDayText(iso: string, timeZone?: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    ...(timeZone ? { timeZone } : {}),
  });
}

// The viewer's zone never changes while the page is open.
const noSubscription = () => () => {};

/**
 * A post's date in the viewer's own time zone, as Activity shows it. The
 * server knows no zone, so it writes the UTC date and the browser swaps in the
 * local one after hydration (useSyncExternalStore), with no mismatch. A printed
 * PDF is made from the page in the browser, so it carries the local date.
 */
export function LocalDay({ iso }: { iso: string }) {
  const text = useSyncExternalStore(
    noSubscription,
    () => reportDayText(iso),
    () => reportDayText(iso, "UTC"),
  );
  return <time dateTime={iso}>{text}</time>;
}
