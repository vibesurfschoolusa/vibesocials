/**
 * R30 PP2 (lead): the rules of the page's one announcer (components/ui/announcer.tsx).
 * Kept out of the "use client" module so they can be tested and imported anywhere.
 */

/**
 * Whether an element's text is read out. `last` is the text the element had
 * at its previous check (undefined on its first). An element that was in the
 * page's first render (pageReady false) is not read out, so a static notice
 * isn't read on load; one added later is, and so is any change of text.
 */
export function shouldAnnounce(input: { pageReady: boolean; last: string | undefined; text: string }): boolean {
  if (!input.text.trim()) return false;
  if (input.last === undefined) return input.pageReady;
  return input.text !== input.last;
}

/**
 * announce(text): empty the region, then set the text on a later tick, so the
 * same text twice is a change a screen reader reads again. A newer text
 * replaces one still waiting.
 */
export function createAnnouncer<T>(
  setText: (text: string) => void,
  later: (run: () => void) => T,
  cancel: (handle: T) => void,
): (text: string) => void {
  let pending: T | null = null;
  return (text) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    if (pending !== null) cancel(pending);
    setText("");
    pending = later(() => {
      pending = null;
      setText(trimmed);
    });
  };
}
