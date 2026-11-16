import type { ComponentPropsWithoutRef } from "react";

export const NEW_TAB_HINT = "(opens in a new tab)";

import { cn } from "@/lib/cn";

export type ExternalLinkProps = Omit<ComponentPropsWithoutRef<"a">, "target" | "rel"> & {
  /** Where the hint sits, for a link that isn't a line of text (a thumbnail). */
  hintClassName?: string;
};

/**
 * R26 pages L6: a link that opens a new tab, with the visible hint as part of
 * its text, so the name a screen reader reads is the one people see. The hint
 * is left off a printed page, where it means nothing.
 */
export function ExternalLink({ children, hintClassName, ...props }: ExternalLinkProps) {
  return (
    <a {...props} target="_blank" rel="noopener noreferrer">
      {children} <span className={cn("text-xs font-normal print:hidden", hintClassName)}>{NEW_TAB_HINT}</span>
    </a>
  );
}
