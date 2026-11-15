"use client";

import { Fragment, useEffect, useState, type ReactNode } from "react";

/**
 * Settings shows the client links in two places that must agree:
 *  - Check 3 (R6 M2): "Make new client links" on the Team card replaces the
 *    client connect link, which the Connections card shows. That card reads
 *    its link once, when it mounts; settings/page.tsx wraps it so this event
 *    remounts it and it shows the new address without a reload.
 *  - R6 review low 2: the connect link card announces its own create, replace
 *    and turn off, so the Team card reads again whether it has a link to
 *    replace (its button shows or hides). That card is not remounted for its
 *    own change.
 */

export const CLIENT_LINKS_REPLACED_EVENT = "vibe:client-links-replaced";

/** Where a change came from: the Team card's replace, or the connect link card. */
export type ClientLinksChangeSource = "team" | "connect-link";

export function announceClientLinksReplaced(source: ClientLinksChangeSource = "team"): void {
  window.dispatchEvent(new CustomEvent(CLIENT_LINKS_REPLACED_EVENT, { detail: { source } }));
}

/** Calls `listener` with the source on each announce; the answer unsubscribes. */
export function subscribeClientLinksReplaced(listener: (source: ClientLinksChangeSource) => void): () => void {
  const onEvent = (event: Event) => {
    const source = (event as CustomEvent<{ source?: unknown }>).detail?.source;
    listener(source === "connect-link" ? "connect-link" : "team");
  };
  window.addEventListener(CLIENT_LINKS_REPLACED_EVENT, onEvent);
  return () => window.removeEventListener(CLIENT_LINKS_REPLACED_EVENT, onEvent);
}

/** The connect link card already shows its own change; it is remounted only for the Team card's. */
export function remountsConnectLinkCard(source: ClientLinksChangeSource): boolean {
  return source !== "connect-link";
}

/** Renders `children`, mounted afresh after each Team card replace. */
export function RemountOnClientLinksReplaced({ children }: { children: ReactNode }) {
  const [generation, setGeneration] = useState(0);
  useEffect(
    () =>
      subscribeClientLinksReplaced((source) => {
        if (remountsConnectLinkCard(source)) setGeneration((n) => n + 1);
      }),
    [],
  );
  return <Fragment key={generation}>{children}</Fragment>;
}
