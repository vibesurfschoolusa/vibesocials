import {
  focusFallbacks,
  focusFirstOf,
  isHiddenElement,
  isMainLandmark,
  isPageRoot,
  isWatchedForFocus,
} from "./focusAfter";

/**
 * R28 NN1: one page-wide keeper so keyboard focus never drops to the page body
 * when a press removes, disables, hides or moves its own control (Activity's
 * Retry, Add many's rows, Create's photos, a form swapped for its success
 * line). Round after round these were found and fixed site by site with
 * focusAfterPress; the keeper cures the class for every page, new ones too.
 *
 * The rule, kept narrow so it never fights the person:
 * - It follows the last control focused inside the page's main landmark
 *   (focusin), with the fallbacks focusAfter.ts records: the next row's
 *   control, the previous row's, then the headings above. They are read again
 *   when that control is pressed (pointerdown, keydown).
 * - It acts only on a DOM change that touches that control (removed, moved, or
 *   it or a section around it disabled, hidden or made inert), only while focus
 *   is on the body, and never while a dialog is open.
 * - Still on the page and usable (a keyed item React moved): focus it again.
 *   Otherwise: the first fallback still usable. Never with a scroll.
 * - It stands aside for a control a focusAfterPress or Dialog watch looks
 *   after (their target wins), for a control inside a dialog (the dialog's
 *   own restore), and for a control outside main (a toast, the sidebar).
 * - A pointerdown outside the control (a click into the page on purpose) ends
 *   the watch until another control takes focus.
 * - Lead review: never on a navigation (the address changed since the
 *   control took focus or was pressed, or the whole page content went), and
 *   the fallbacks stop at the page's own root, so a banner's "Resend email"
 *   is never chosen.
 */

/** What the keeper needs from the browser; tests pass a fake one. */
export interface KeeperEnv {
  doc: Pick<Document, "activeElement" | "body" | "addEventListener" | "removeEventListener" | "querySelector"> & {
    location?: { pathname: string } | null;
  };
  MutationObserver: typeof MutationObserver;
}

const OBSERVED_ATTRIBUTES = ["disabled", "aria-hidden", "inert", "hidden"];

/** A dialog has its own focus trap and restore; the keeper waits it out. */
const OPEN_DIALOG = '[role="dialog"][aria-modal="true"], [role="alertdialog"], dialog[open]';

function isDialog(element: Element): boolean {
  const role = element.getAttribute("role");
  return role === "dialog" || role === "alertdialog" || element.tagName === "DIALOG";
}

function selfOrAncestor(element: Element, matches: (element: Element) => boolean): boolean {
  for (let at: Element | null = element; at; at = at.parentElement) if (matches(at)) return true;
  return false;
}

/** A surrounding <fieldset disabled> disables its controls (Add many's batch settings). */
function isDisabledFieldset(element: Element): boolean {
  return element.tagName === "FIELDSET" && element.hasAttribute("disabled");
}

/**
 * On the page, not disabled (itself or by a fieldset), not in a hidden,
 * aria-hidden or inert part, and drawn: a control hidden by CSS (hidden
 * md:inline) has no boxes.
 */
function isUsable(element: HTMLElement): boolean {
  return (
    element.isConnected &&
    !element.hasAttribute("disabled") &&
    !selfOrAncestor(element, isDisabledFieldset) &&
    !selfOrAncestor(element, isHiddenElement) &&
    (typeof element.getClientRects !== "function" || element.getClientRects().length > 0)
  );
}

/** The node that holds the page: the frame's page root, else the main landmark. */
function pageRootOf(element: HTMLElement): Element | null {
  for (let at: Element | null = element.parentElement; at; at = at.parentElement) if (isPageRoot(at)) return at;
  for (let at: Element | null = element.parentElement; at; at = at.parentElement) if (isMainLandmark(at)) return at;
  return null;
}

/** The whole page went: its root, or a direct child of the root holding the page. */
function removesPage(record: MutationRecord, root: Element | null): boolean {
  if (!root || record.type !== "childList" || record.removedNodes.length === 0) return false;
  return record.target === root || Array.from(record.removedNodes).some((node) => node.contains(root));
}

/** The keys that press a control; the fallbacks are read again only then. */
const PRESS_KEYS = new Set(["Enter", " "]);

/** Input types where Space is a press (a checkbox, a button), not a typed character. */
const PRESSABLE_INPUT_TYPES = new Set(["button", "checkbox", "color", "file", "image", "radio", "reset", "submit"]);

/** A box the person types in: Space there is text, not a press. */
function isTextField(element: Element): boolean {
  if (element.tagName === "TEXTAREA") return true;
  if (element.tagName === "INPUT") return !PRESSABLE_INPUT_TYPES.has((element.getAttribute("type") ?? "text").toLowerCase());
  const editable = element.getAttribute("contenteditable");
  return editable !== null && editable !== "false";
}

function isElement(target: unknown): target is HTMLElement {
  return typeof target === "object" && target !== null && typeof (target as Element).getAttribute === "function";
}

function touches(record: MutationRecord, element: HTMLElement): boolean {
  if (record.type === "childList") {
    return Array.from(record.removedNodes).some((node) => node === element || node.contains(element));
  }
  return record.target === element || record.target.contains(element);
}

function start({ doc, MutationObserver: Observer }: KeeperEnv): () => void {
  type Tracked = { element: HTMLElement; fallbacks: HTMLElement[]; root: Element | null; pathname?: string };
  let tracked: Tracked | null = null;
  const pathname = () => doc.location?.pathname;
  const record = (element: HTMLElement): Tracked => ({
    element,
    fallbacks: focusFallbacks(element),
    root: pageRootOf(element),
    pathname: pathname(),
  });

  const onFocusIn = (event: Event) => {
    const target = event.target;
    tracked =
      isElement(target) && selfOrAncestor(target, isMainLandmark) && !selfOrAncestor(target, isDialog)
        ? record(target)
        : null;
  };

  const onPress = (event: Event) => {
    if (!tracked) return;
    const target = event.target;
    if (event.type === "pointerdown" && !(isElement(target) && tracked.element.contains(target))) {
      tracked = null;
      return;
    }
    // Lead review: only a press reads them again, not every key typed.
    if (event.type === "keydown") {
      const key = (event as KeyboardEvent).key;
      if (!PRESS_KEYS.has(key) || (key === " " && isTextField(tracked.element))) return;
    }
    if (isUsable(tracked.element)) tracked = record(tracked.element);
  };

  const observer = new Observer((records) => {
    if (!tracked) return;
    const { element, fallbacks, root } = tracked;
    if (!records.some((change) => touches(change, element))) return;
    // A navigation took the page away: the new page sets its own focus.
    if (pathname() !== tracked.pathname || records.some((change) => removesPage(change, root))) {
      tracked = null;
      return;
    }
    const active = doc.activeElement;
    if (active && active !== doc.body) return;
    if (doc.querySelector(OPEN_DIALOG)) return;
    if (isUsable(element)) {
      element.focus({ preventScroll: true });
      return;
    }
    if (isWatchedForFocus(element)) return;
    focusFirstOf(fallbacks, isUsable, doc);
  });

  doc.addEventListener("focusin", onFocusIn, true);
  doc.addEventListener("pointerdown", onPress, true);
  doc.addEventListener("keydown", onPress, true);
  observer.observe(doc as unknown as Node, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: OBSERVED_ATTRIBUTES,
  });
  return () => {
    observer.disconnect();
    doc.removeEventListener("focusin", onFocusIn, true);
    doc.removeEventListener("pointerdown", onPress, true);
    doc.removeEventListener("keydown", onPress, true);
  };
}

let installed: { count: number; stop: () => void } | null = null;

/**
 * Starts the keeper for the page (the browser's document unless a test passes
 * its own) and returns the function that ends this mount of it. Mounted more
 * than once (the app shell and a page), it runs once and stops with the last.
 */
export function installFocusKeeper(env?: KeeperEnv): () => void {
  if (!installed) {
    const browser: KeeperEnv | undefined =
      env ??
      (typeof document === "undefined" || typeof MutationObserver === "undefined"
        ? undefined
        : { doc: document, MutationObserver });
    if (!browser) return () => {};
    installed = { count: 0, stop: start(browser) };
  }
  installed.count += 1;
  let ended = false;
  return () => {
    if (ended || !installed) return;
    ended = true;
    installed.count -= 1;
    if (installed.count === 0) {
      installed.stop();
      installed = null;
    }
  };
}
