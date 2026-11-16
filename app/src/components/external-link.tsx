import type { ComponentPropsWithoutRef } from "react";

export const NEW_TAB_HINT = "(opens in a new tab)";

export type ExternalLinkProps = Omit<ComponentPropsWithoutRef<"a">, "target" | "rel">;

/**
 * R26 pages L6: a link that opens a new tab, with the visible hint as part of
 * its text, so the name a screen reader reads is the one people see. The hint
 * is left off a printed page, where it means nothing.
 */
export function ExternalLink({ children, ...props }: ExternalLinkProps) {
  return (
    <a {...props} target="_blank" rel="noopener noreferrer">
      {children} <span className="text-xs font-normal print:hidden">{NEW_TAB_HINT}</span>
    </a>
  );
}
