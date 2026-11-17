import { useEffect } from "react";

/**
 * Unconfirmed in R7-new-customer, R36 new-customer: Back from a page this one
 * left (Stripe, a platform's sign-in) can restore it from the browser's
 * back-forward cache with a button still busy (the page was leaving when it
 * was pressed). `reset` runs when the page is shown again that way. Answers
 * the function that stops listening.
 */
export function onReturnFromCache(
  target: Pick<Window, "addEventListener" | "removeEventListener">,
  reset: () => void,
): () => void {
  const listener = (event: PageTransitionEvent) => {
    if (event.persisted) reset();
  };
  target.addEventListener("pageshow", listener);
  return () => target.removeEventListener("pageshow", listener);
}

/** For a control that sets a busy state and then leaves the page: back to `idle` on a return from the cache. */
export function useResetOnReturnFromCache<T>(setBusy: (value: T) => void, idle: T): void {
  useEffect(() => onReturnFromCache(window, () => setBusy(idle)), [setBusy, idle]);
}
