import { useCallback, useEffect, useRef, type RefObject } from "react";

import { focusFirstOf } from "./focusAfter";
import { keeperStandAside } from "./focusKeeper";

/**
 * R39 lead review: a Try again that the load removes drops keyboard focus to
 * the page body. After the press (`pressed()`), focus goes to the loading
 * status line while `loading`, then, once the load settles, to the first of
 * `results` on the page (the list, or the new error). Focus the person moved
 * meanwhile is never pulled back. `results` are refs, so the effect reads
 * them when it runs.
 *
 * R40 pages L1: the load's answer can remove the loading line (and the press
 * removes the Try again) before this hook's effect runs, and the page's focus
 * keeper reacts first, moving focus to an unrelated link. So the keeper
 * stands aside for both until the load settles and this hook has placed focus.
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

  // The keeper's holds for this press, let go once focus is placed.
  const releasesRef = useRef<(() => void)[]>([]);
  const standAside = useCallback((element: Element | null) => {
    if (element && typeof (element as HTMLElement).focus === "function" && element !== document.body) {
      releasesRef.current.push(keeperStandAside(element as HTMLElement));
    }
  }, []);
  const release = useCallback(() => {
    for (const end of releasesRef.current.splice(0)) end();
  }, []);
  useEffect(() => release, [release]);

  useEffect(() => {
    if (!pressedRef.current) return;
    const status = statusRef.current;
    const active = document.activeElement;
    // Free: on the body, on the status line, or still on the removed button.
    const free =
      !active || active === document.body || active === status || active === focusedRef.current || !active.isConnected;
    if (loading) {
      if (free && status && focusFirstOf([status])) {
        focusedRef.current = status;
        standAside(status);
      }
      return;
    }
    pressedRef.current = false;
    focusedRef.current = null;
    if (free) {
      const shown = resultsRef.current.map((ref) => ref.current).filter((el): el is HTMLElement => el !== null);
      focusFirstOf(shown);
    }
    release();
  }, [loading, statusRef, standAside, release]);

  return useCallback(() => {
    pressedRef.current = true;
    // The Try again just pressed: the press removes it.
    if (typeof document !== "undefined") standAside(document.activeElement);
  }, [standAside]);
}
