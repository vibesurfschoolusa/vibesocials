"use client";

import { useEffect, useRef } from "react";

import { useAnnounce } from "@/components/ui/announcer";

/** The routes' usual count: the text as saved, trimmed. */
function trimmedLength(text: string): number {
  return text.trim().length;
}

/** A field under this rule: its text, the route's limit and how the route counts. */
export type CountedText = { text: string; max: number; count?: (text: string) => number };

function isOver({ text, max, count = trimmedLength }: CountedText): boolean {
  return count(text) > max;
}

/**
 * R45 new-customer L1: the press half of the rule, for every form with a
 * count. While a field is over, the form sends nothing (the route would only
 * refuse it, and some routes count the try first): `show` puts the route's
 * own sentence where the form shows its failures, which announces it, and the
 * field takes the focus. True when the press was refused.
 */
export function refuseOverLimit(
  fields: ReadonlyArray<CountedText & { sentence: string; field: { focus(): void } | null }>,
  show: (sentence: string) => void,
): boolean {
  const over = fields.find(isOver);
  if (!over) return false;
  show(over.sentence);
  over.field?.focus();
  return true;
}

/**
 * R43 new-customer L1, R44 L3: the one rule for a field with no maxLength, so
 * a paste is never cut short without a word (the Settings footer, the name
 * fields, /u, Add many's description, the Google post fields). This count,
 * linked to the field by aria-describedby, says when the text is over, and
 * the form's press is refused with the route's own sentence
 * (refuseOverLimit). `count` counts as the field's route does; `action` is
 * what the form's button does ("save", "create your account").
 */
export function CharacterCount({
  id,
  label,
  text,
  max,
  action,
  count = trimmedLength,
}: {
  id: string;
  label: string;
  text: string;
  max: number;
  action: string;
  count?: (text: string) => number;
}) {
  const length = count(text);
  const over = length - max;
  // Crossing the limit is said once each way through the page's announcer;
  // the count itself is read with the field, never per key.
  const announce = useAnnounce();
  const isOverNow = over > 0;
  const wasOver = useRef(isOverNow);
  useEffect(() => {
    if (wasOver.current === isOverNow) return;
    wasOver.current = isOverNow;
    announce(
      isOverNow
        ? `${label}: ${over.toLocaleString("en-US")} ${over === 1 ? "character" : "characters"} over the limit.`
        : `${label}: back under the limit.`,
    );
  }, [isOverNow, over, label, announce]);
  return (
    <p id={id} className="text-xs text-muted-foreground">
      {length.toLocaleString("en-US")} of {max.toLocaleString("en-US")} characters
      {isOverNow ? (
        <span className="text-destructive">
          {" "}
          ({over.toLocaleString("en-US")} over). Shorten it to {action}.
        </span>
      ) : null}
    </p>
  );
}
