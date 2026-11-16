import type { ComponentPropsWithoutRef } from "react";

import { cn } from "@/lib/cn";

export const NEW_TAB_HINT = "(opens in a new tab)";

/**
 * R26 pages L6: the one visible hint every new-tab link carries, as part of
 * its text. Left off a printed page, where it means nothing. Links that can't
 * be an ExternalLink (the Google sign-in, Print card's next/link) use it too.
 */
export function NewTabHint({ className }: { className?: string }) {
  return <span className={cn("text-xs font-normal print:hidden", className)}>{NEW_TAB_HINT}</span>;
}

export type ExternalLinkProps = Omit<ComponentPropsWithoutRef<"a">, "target" | "rel"> & {
  /** Where the hint sits, for a link that isn't a line of text (a thumbnail, a long URL). */
  hintClassName?: string;
};

/**
 * R26 pages L6: a link that opens a new tab, with the visible hint as part of
 * its text, so the name a screen reader reads is the one people see.
 */
export function ExternalLink({ children, hintClassName, ...props }: ExternalLinkProps) {
  return (
    <a {...props} target="_blank" rel="noopener noreferrer">
      {children} <NewTabHint className={hintClassName} />
    </a>
  );
}
