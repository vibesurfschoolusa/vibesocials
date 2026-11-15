import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  announceClientLinksReplaced,
  CLIENT_LINKS_REPLACED_EVENT,
  RemountOnClientLinksReplaced,
  subscribeClientLinksReplaced,
} from "./client-links-refresh";

/**
 * Check 3 (R6 M2): "Make new client links" on the Team card replaces the
 * connect link; the Connections card's connect link group, mounted beside it,
 * is remounted on this event so it reads the new link without a reload.
 */

beforeEach(() => {
  vi.stubGlobal("window", new EventTarget());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("client links replaced event", () => {
  it("an announce reaches each listener until it unsubscribes", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeClientLinksReplaced(listener);

    announceClientLinksReplaced();
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    announceClientLinksReplaced();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("is one named event on the window", () => {
    const listener = vi.fn();
    window.addEventListener(CLIENT_LINKS_REPLACED_EVENT, listener);
    announceClientLinksReplaced();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("the wrapper renders what it wraps", () => {
    expect(renderToStaticMarkup(createElement(RemountOnClientLinksReplaced, null, createElement("p", null, "link")))).toBe(
      "<p>link</p>",
    );
  });
});
