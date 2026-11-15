"use client";

import { Fragment, useEffect, useState, type ReactNode } from "react";

/**
 * Check 3 (R6 M2): "Make new client links" on the Team card replaces the
 * client connect link, which the Connections card shows on the same page.
 * That card reads its link once, when it mounts; this event remounts it
 * (settings/page.tsx wraps it), so it shows the new address without a reload.
 */

export const CLIENT_LINKS_REPLACED_EVENT = "vibe:client-links-replaced";

export function announceClientLinksReplaced(): void {
  window.dispatchEvent(new Event(CLIENT_LINKS_REPLACED_EVENT));
}

/** Calls `listener` on each announce; the answer unsubscribes. */
export function subscribeClientLinksReplaced(listener: () => void): () => void {
  window.addEventListener(CLIENT_LINKS_REPLACED_EVENT, listener);
  return () => window.removeEventListener(CLIENT_LINKS_REPLACED_EVENT, listener);
}

/** Renders `children`, mounted afresh after each announce. */
export function RemountOnClientLinksReplaced({ children }: { children: ReactNode }) {
  const [generation, setGeneration] = useState(0);
  useEffect(() => subscribeClientLinksReplaced(() => setGeneration((n) => n + 1)), []);
  return <Fragment key={generation}>{children}</Fragment>;
}
