import type { FakeNode } from "@/components/shell/fakeDom.testkit";

/** The fake document's parts focus needs. */
export type FocusDoc = { activeElement: unknown; body: FakeNode; createElement: (tag: string) => FakeNode };

/**
 * R39 lead review: the shell's fake DOM has no focus. Elements this document
 * makes from now on can take it (focus() sets activeElement), and know
 * whether they are on the page. Test support only.
 */
export function makeFocusable(target: FocusDoc): void {
  const make = target.createElement;
  target.createElement = (tag: string) => {
    const element = make(tag);
    element.focus = () => {
      target.activeElement = element;
    };
    Object.defineProperty(element, "isConnected", {
      get: () => {
        for (let at: FakeNode | null = element; at; at = at.parentNode) if (at === target.body) return true;
        return false;
      },
    });
    return element;
  };
}
