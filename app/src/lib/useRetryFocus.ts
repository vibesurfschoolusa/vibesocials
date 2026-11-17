import { useCallback, useEffect, useRef, type RefObject } from "react";

import { focusFirstOf } from "./focusAfter";

/**
 * R39 lead review: a Try again that the load removes drops keyboard focus to
 * the page body. After the press (`pressed()`), focus goes to the loading
 * status line while `loading`, then, once the load settles, to the first of
 * `results` on the page (the list, or the new error). Focus the person moved
 * meanwhile is never pulled back. `results` are refs, so the effect reads
 * them when it runs.
 */
export function useRetryFocus(
  loading: boolean,
  statusRef: RefObject<HTMLElement | null>,
  results: RefObject<HTMLElement | null>[],
): () => void {
  const pressedRef = useRef(false);
  const resultsRef = useRef(results);
  useEffect(() => {
    resultsRef.current = results;
  });

  // The status line focus went to: React may reuse its element for the result.
  const focusedRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!pressedRef.current) return;
    const status = statusRef.current;
    const active = document.activeElement;
    // Free: on the body, on the status line, or still on the removed button.
    const free =
      !active || active === document.body || active === status || active === focusedRef.current || !active.isConnected;
    if (loading) {
      if (free && status && focusFirstOf([status])) focusedRef.current = status;
      return;
    }
    pressedRef.current = false;
    focusedRef.current = null;
    if (!free) return;
    const shown = resultsRef.current.map((ref) => ref.current).filter((el): el is HTMLElement => el !== null);
    focusFirstOf(shown);
  }, [loading, statusRef]);

  return useCallback(() => {
    pressedRef.current = true;
  }, []);
}
