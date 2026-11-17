"use client";

import { useEffect, useRef } from "react";

import { useAnnounce } from "@/components/ui/announcer";

/**
 * R44 new-customer L3, the R43 footer rule for name fields: the field has no
 * maxLength, so a paste is never cut short without a word. This count, linked
 * to the field by aria-describedby, says when the text is over; the button
 * then shows the route's own sentence. `length` is counted as the route
 * counts it.
 */
export function CharacterCount({ id, label, length, max }: { id: string; label: string; length: number; max: number }) {
  const over = length - max;
  // Crossing the limit is said once each way through the page's announcer;
  // the count itself is read with the field, never per key.
  const announce = useAnnounce();
  const isOver = over > 0;
  const wasOver = useRef(isOver);
  useEffect(() => {
    if (wasOver.current === isOver) return;
    wasOver.current = isOver;
    announce(
      isOver
        ? `${label}: ${over.toLocaleString("en-US")} ${over === 1 ? "character" : "characters"} over the limit.`
        : `${label}: back under the limit.`,
    );
  }, [isOver, over, label, announce]);
  return (
    <p id={id} className="text-xs text-muted-foreground">
      {length.toLocaleString("en-US")} of {max.toLocaleString("en-US")} characters
      {isOver ? (
        <span className="text-destructive">
          {" "}
          ({over.toLocaleString("en-US")} over). Shorten it.
        </span>
      ) : null}
    </p>
  );
}
