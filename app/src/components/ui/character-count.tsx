"use client";

import { useEffect, useRef } from "react";

import { useAnnounce } from "@/components/ui/announcer";

/** The routes' usual count: the text as saved, trimmed. */
function trimmedLength(text: string): number {
  return text.trim().length;
}

/**
 * R43 new-customer L1, R44 L3: the one rule for a field with no maxLength, so
 * a paste is never cut short without a word (the Settings footer and the name
 * fields). This count, linked to the field by aria-describedby, says when the
 * text is over; the button then shows the route's own sentence. `count`
 * counts as the field's route does.
 */
export function CharacterCount({
  id,
  label,
  text,
  max,
  count = trimmedLength,
}: {
  id: string;
  label: string;
  text: string;
  max: number;
  count?: (text: string) => number;
}) {
  const length = count(text);
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
