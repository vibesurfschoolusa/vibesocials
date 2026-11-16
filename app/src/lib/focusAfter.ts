/**
 * Where keyboard focus goes when the control that had it is removed or
 * disabled, so it never drops to the page body. One rule for the Dialog (its
 * trigger is gone when it closes) and for a plain press outside a dialog (R27
 * MM3: "Create link" replaced by the new link, a Save that disables itself).
 *
 * The API:
 * - focusAfterPress(pressed, target?) => stop: call it in a press handler right
 *   before the state change that may remove or disable `pressed` (the
 *   `event.currentTarget` taken at the start of the press). Once the page has
 *   changed, if `pressed` is gone or disabled and focus is on the page body or
 *   still on `pressed`, focus goes to `target()` (read then, so a ref to the
 *   new control works), else to the fallback recorded now. Focus the person
 *   moved in the meantime is never pulled back. The returned `stop()` ends
 *   the watch early, before a later watch for the same press starts.
 * - focusFallbacks / restoreFocus / watchFocusAfterClose: the Dialog's parts
 *   (record at open, restore and keep watching on close).
 */

/** Out of reach for focus or out of sight: a closed drawer, an aria-hidden layer. */
export function isHiddenElement(element: Element): boolean {
  return (
    element.hasAttribute("hidden") || element.getAttribute("aria-hidden") === "true" || element.hasAttribute("inert")
  );
}

function headingsIn(element: Element): HTMLElement[] {
  if (isHiddenElement(element)) return [];
  if (/^H[1-6]$/.test(element.tagName)) return [element as HTMLElement];
  return Array.from(element.children).flatMap(headingsIn);
}

const FIELD_TAGS = new Set(["BUTTON", "INPUT", "SELECT", "TEXTAREA"]);

/** What the Dialog's focusable selector matches, read from attributes so it needs no layout. */
function isFocusable(element: Element): boolean {
  const tabindex = element.getAttribute("tabindex");
  if (tabindex !== null) return tabindex !== "-1";
  if (FIELD_TAGS.has(element.tagName)) return !element.hasAttribute("disabled");
  return element.tagName === "A" && element.hasAttribute("href");
}

function firstFocusableIn(element: Element): HTMLElement | null {
  if (isHiddenElement(element)) return null;
  if (isFocusable(element)) return element as HTMLElement;
  for (const child of Array.from(element.children)) {
    const found = firstFocusableIn(child);
    if (found) return found;
  }
  return null;
}

export function isMainLandmark(element: Element): boolean {
  return element.tagName === "MAIN" || element.getAttribute("role") === "main";
}

/** R28 NN1 review: the frame's wrapper round the page, below its banners (app-shell.tsx). */
export function isPageRoot(element: Element): boolean {
  return element.hasAttribute("data-focus-root");
}

function nearestAncestor(start: Element | null, matches: (element: Element) => boolean): Element | null {
  for (let at = start?.parentElement ?? null; at; at = at.parentElement) {
    if (matches(at)) return at;
  }
  return null;
}

/** On the page and not disabled: focus would land there. */
function canTakeFocus(element: HTMLElement): boolean {
  return element.isConnected && !element.hasAttribute("disabled");
}

/**
 * R26 pages L4: the controls that can take focus when `trigger` goes,
 * recorded while it is still on the page. Level by level from the trigger
 * outwards: the next row's first control, then the previous row's, then the
 * headings above, nearest first. Controls in the trigger's own row come first
 * but go with it, so the first one still on the page is the neighbouring row,
 * or the section heading when no row is left.
 */
export function focusFallbacks(trigger: HTMLElement | null): HTMLElement[] {
  const found: HTMLElement[] = [];
  const add = (element: HTMLElement | null | undefined) => {
    if (element && element !== trigger && !found.includes(element)) found.push(element);
  };
  // Lead review: past the page content a "next row" was a toast's button or
  // the mobile drawer. The walk ends at the trigger's main landmark, or its
  // nearest section where there is none. R28 NN1 review: in the signed-in
  // frame it ends at the page's own root, before the shell's banners.
  const limit =
    nearestAncestor(trigger, isPageRoot) ??
    nearestAncestor(trigger, isMainLandmark) ??
    nearestAncestor(trigger, (el) => el.tagName === "SECTION");
  let child: Element | null = trigger;
  while (child?.parentElement && child !== limit) {
    const siblings = Array.from(child.parentElement.children);
    const at = siblings.indexOf(child);
    add(siblings.slice(at + 1).map(firstFocusableIn).find(Boolean));
    add(siblings.slice(0, at).reverse().map(firstFocusableIn).find(Boolean));
    for (const heading of siblings.slice(0, at).flatMap(headingsIn).reverse()) add(heading);
    child = child.parentElement;
  }
  return found;
}

/**
 * The first fallback that can take focus gets it, without scrolling the page
 * (lead review: Queue's heading is at the top, the card that went was far
 * down). A heading or status line is made focusable by script only.
 */
export function focusFirstOf(
  candidates: HTMLElement[],
  usable: (element: HTMLElement) => boolean = canTakeFocus,
  doc?: Pick<Document, "activeElement">,
): boolean {
  for (const target of candidates) {
    if (!usable(target)) continue;
    if (!isFocusable(target) && !target.hasAttribute("tabindex")) target.tabIndex = -1;
    target.focus({ preventScroll: true });
    // R28 NN1 review: given a document, a control that did not take focus
    // (hidden by a rule focus can't see) gives way to the next one.
    if (!doc || doc.activeElement === target) return true;
  }
  return false;
}

/**
 * Focus the trigger if it can still take focus, else the first fallback that
 * can. Returns whether a fallback took it.
 */
export function restoreFocus(trigger: HTMLElement | null, fallbacks: HTMLElement[]): boolean {
  if (!trigger) return false;
  if (canTakeFocus(trigger)) {
    trigger.focus();
    return false;
  }
  return focusFirstOf(fallbacks);
}

/**
 * Lead follow-up: the page can change a little after the moment that matters
 * (Queue's series cancel reads the list again; a press's new state renders
 * after its answer). So look on the next frame and after these delays, only
 * while the trigger can't take focus and focus is on the page body or the
 * trigger. The watch ends after one move, and as soon as focus has been
 * anywhere else: focus the person moved is never pulled back.
 */
export const FOCUS_RECHECK_MS = [1000, 3000];

interface FocusSchedule {
  frame(run: () => void): void;
  later(run: () => void, ms: number): void;
}

type FocusDocument = Pick<Document, "activeElement" | "body" | "addEventListener" | "removeEventListener">;

/** Tests pass their own clock and document; the page uses the browser's. */
export interface FocusWatchOptions {
  schedule?: FocusSchedule;
  doc?: FocusDocument;
}

const browserSchedule: FocusSchedule = {
  frame: (run) => window.requestAnimationFrame(run),
  later: (run, ms) => window.setTimeout(run, ms),
};

/**
 * R28 NN1: the controls a watch below is looking after, so the page-wide
 * focus keeper (focusKeeper.ts) leaves their drop to it: a press's explicit
 * target wins, and the Dialog keeps its own restore. A count, as /u can hold
 * two watches for one press for a moment.
 */
const watched = new Map<HTMLElement, number>();

export function isWatchedForFocus(element: HTMLElement): boolean {
  return watched.has(element);
}

/** Starts the watch; the function it returns ends it early. */
function watch(
  trigger: HTMLElement,
  candidates: () => HTMLElement[],
  { schedule, doc }: Required<FocusWatchOptions>,
): () => void {
  let done = false;
  let checksLeft = 1 + FOCUS_RECHECK_MS.length;
  watched.set(trigger, (watched.get(trigger) ?? 0) + 1);
  const stop = () => {
    if (done) return;
    done = true;
    doc.removeEventListener("focusin", onFocusIn);
    const left = (watched.get(trigger) ?? 1) - 1;
    if (left > 0) watched.set(trigger, left);
    else watched.delete(trigger);
  };
  function onFocusIn(event: Event) {
    if (event.target !== trigger) stop();
  }
  const check = () => {
    checksLeft -= 1;
    if (!done) {
      const active = doc.activeElement;
      if (active && active !== doc.body && active !== trigger) stop();
      else if (!canTakeFocus(trigger) && focusFirstOf(candidates())) stop();
    }
    if (checksLeft === 0 && !done) stop();
  };
  doc.addEventListener("focusin", onFocusIn);
  schedule.frame(check);
  for (const ms of FOCUS_RECHECK_MS) schedule.later(check, ms);
  return stop;
}

/** The Dialog's watch after close, over the fallbacks it recorded at open. */
export function watchFocusAfterClose(
  trigger: HTMLElement | null,
  fallbacks: HTMLElement[],
  schedule: FocusSchedule = browserSchedule,
  doc: FocusDocument = document,
): void {
  if (!trigger) return;
  void watch(trigger, () => fallbacks, { schedule, doc });
}

/**
 * After this press, if `pressed` is gone or disabled, focus `target()` or the
 * fallback (see the API at the top of this file). Returns a function that ends
 * the watch early: call it before starting a later watch for the same press
 * (lead review: /u's retry and end-of-send watches).
 */
export function focusAfterPress(
  pressed: HTMLElement | null,
  target?: () => HTMLElement | null | undefined,
  options: FocusWatchOptions = {},
): () => void {
  if (!pressed) return () => {};
  const { schedule = browserSchedule, doc = document } = options;
  const fallbacks = focusFallbacks(pressed);
  return watch(
    pressed,
    () => {
      const chosen = target?.();
      return chosen ? [chosen, ...fallbacks] : fallbacks;
    },
    { schedule, doc },
  );
}
