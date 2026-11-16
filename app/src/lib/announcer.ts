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

/** What readableText reads: a DOM node, or a test's stand-in for one. */
export interface TextNodeLike {
  nodeType: number;
  nodeValue: string | null;
  tagName?: string;
  childNodes: ArrayLike<TextNodeLike>;
  getAttribute?: (name: string) => string | null;
}

const BLOCK_TAGS = new Set(["P", "DIV", "LI", "UL", "OL", "H1", "H2", "H3", "H4", "H5", "H6", "SECTION", "BLOCKQUOTE"]);

/**
 * R30 lead review: an element's text as a sentence a screen reader can read.
 * textContent ran an Alert's title and body together ("Post scheduledWe'll
 * publish..."); each block's text is its own part, and parts are joined with
 * a full stop unless one already ends a sentence. Hidden parts (aria-hidden)
 * are left out.
 */
export function readableText(node: TextNodeLike): string {
  const parts: string[] = [];
  let current = "";
  const flush = () => {
    const text = current.replace(/\s+/g, " ").trim();
    if (text) parts.push(text);
    current = "";
  };
  const walk = (n: TextNodeLike) => {
    if (n.nodeType === 3) {
      current += n.nodeValue ?? "";
      return;
    }
    if (n.nodeType !== 1 || n.getAttribute?.("aria-hidden") === "true") return;
    const block = BLOCK_TAGS.has((n.tagName ?? "").toUpperCase());
    if (block) flush();
    for (let i = 0; i < n.childNodes.length; i += 1) walk(n.childNodes[i]);
    if (block) flush();
  };
  walk(node);
  flush();
  return parts.reduce((text, part) => (text === "" ? part : /[.!?:]$/.test(text) ? `${text} ${part}` : `${text}. ${part}`), "");
}
