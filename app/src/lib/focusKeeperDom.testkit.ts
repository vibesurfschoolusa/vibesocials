import type { FakeNode } from "@/components/shell/fakeDom.testkit";

import { installFocusKeeper, type KeeperEnv } from "./focusKeeper";
import type { FocusDoc } from "./focusDom.testkit";

/**
 * R40 pages L1: the client pages' focus tests ran without the page-wide focus
 * keeper, so they missed it moving focus first. This gives the shell's fake DOM
 * what the keeper reads (parentElement, children, boxes, focusin, a
 * MutationObserver) and installs it, with the client page around the view: a
 * main landmark holding the view, then a "Terms" link below it.
 *
 * Removals are reported to the keeper at once, inside React's commit, before
 * any effect runs: the browser's order in R40 pages L1, where the keeper's
 * observer ran before the page's effects. Test support only.
 */

type Listener = (event: { type: string; target: unknown }) => void;
type Records = { type: string; target: FakeNode; removedNodes: FakeNode[]; addedNodes: FakeNode[] }[];

export function installKeeperOnFakePage(made: { doc: Record<string, unknown>; container: FakeNode }): {
  terms: FakeNode;
  stop: () => void;
} {
  const doc = made.doc as unknown as FocusDoc & Record<string, unknown>;
  const listeners = new Map<string, Set<Listener>>();
  const observers = new Set<(records: Records) => void>();

  const fire = (type: string, target: unknown) => {
    for (const listener of listeners.get(type) ?? []) listener({ type, target });
  };

  const patch = (node: FakeNode) => {
    Object.defineProperty(node, "parentElement", {
      get: () => (node.parentNode && node.parentNode.nodeType === 1 ? node.parentNode : null),
    });
    Object.defineProperty(node, "children", { get: () => node.childNodes.filter((child) => child.nodeType === 1) });
    node.getClientRects = () => [{}];
    const focus = node.focus as (() => void) | undefined;
    if (focus) {
      node.focus = () => {
        focus();
        fire("focusin", node);
      };
    }
    const removeChild = node.removeChild as (child: FakeNode) => FakeNode;
    node.removeChild = (child: FakeNode) => {
      removeChild(child);
      const active = doc.activeElement as FakeNode | null;
      if (active && (child.contains as (other: FakeNode) => boolean)(active)) doc.activeElement = doc.body;
      for (const observer of observers) observer([{ type: "childList", target: node, removedNodes: [child], addedNodes: [] }]);
      return child;
    };
  };

  const make = doc.createElement;
  doc.createElement = (tag: string) => {
    const element = make(tag);
    patch(element);
    return element;
  };
  for (const node of [doc.body, doc.body.parentNode as FakeNode, made.container]) patch(node);

  doc.addEventListener = (type: string, listener: Listener) => {
    if (!listeners.has(type)) listeners.set(type, new Set());
    listeners.get(type)!.add(listener);
  };
  doc.removeEventListener = (type: string, listener: Listener) => {
    listeners.get(type)?.delete(listener);
  };
  doc.querySelector = () => null;
  doc.location = { pathname: "/c/tok" };

  // The client page: <main> with the view, then the Terms link below it.
  const main = doc.createElement("main");
  const footer = doc.createElement("p");
  const terms = doc.createElement("a");
  (terms.setAttribute as (name: string, value: string) => void)("href", "/terms");
  terms.appendChild((doc.createTextNode as (text: string) => FakeNode)("Terms"));
  footer.appendChild(terms);
  doc.body.appendChild(main);
  main.appendChild(made.container);
  main.appendChild(footer);

  class FakeObserver {
    private readonly callback: (records: Records) => void;
    constructor(callback: (records: Records) => void) {
      this.callback = callback;
      observers.add(callback);
    }
    observe() {}
    disconnect() {
      observers.delete(this.callback);
    }
  }

  const stop = installFocusKeeper({ doc, MutationObserver: FakeObserver } as unknown as KeeperEnv);
  return { terms, stop };
}
