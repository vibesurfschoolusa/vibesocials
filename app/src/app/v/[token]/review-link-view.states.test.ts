import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

// R13-pages L2: "Try again" visibly retries and the failure is announced. The
// tests run without a DOM, so ReviewLinkView's state is forced through
// useState (its third state is the load error) and its load() is captured
// from useCallback (the first one it makes).
const forced = vi.hoisted(() => ({
  error: undefined as string | undefined,
  calls: 0,
  setError: undefined as ((value: unknown) => void) | undefined,
  load: undefined as (() => Promise<void>) | undefined,
}));
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useState: (initial: unknown) => {
      forced.calls += 1;
      if (forced.calls === 3) {
        return [forced.error !== undefined ? forced.error : initial, (value: unknown) => forced.setError?.(value)];
      }
      return actual.useState(initial);
    },
    useCallback: (fn: () => Promise<void>, deps: unknown[]) => {
      if (!forced.load) forced.load = fn;
      return actual.useCallback(fn, deps);
    },
  };
});

import { ReviewLinkView } from "./review-link-view";

function view(): string {
  forced.calls = 0;
  forced.load = undefined;
  return renderToStaticMarkup(createElement(ReviewLinkView, { token: "T".repeat(43) }));
}

afterEach(() => {
  forced.error = undefined;
  forced.setError = undefined;
  vi.unstubAllGlobals();
});

describe("ReviewLinkView, a failed load", () => {
  it("says so in an alert, with Try again", () => {
    forced.error = "";
    const html = view();
    expect(html).toMatch(/<p role="alert"[^>]*>Couldn/);
    expect(html).toContain(">Try again</button>");
  });

  it("Try again clears the error before it asks again, so Loading shows", async () => {
    forced.error = "";
    view();
    const order: string[] = [];
    forced.setError = (value) => order.push(`setError(${JSON.stringify(value)})`);
    vi.stubGlobal(
      "fetch",
      vi.fn(() => {
        order.push("fetch");
        return new Promise(() => {});
      }),
    );
    void forced.load!();
    await Promise.resolve();
    expect(order).toEqual(["setError(null)", "fetch"]);
  });

  it("with no error and no posts yet: Loading", () => {
    expect(view()).toContain("Loading the posts…");
  });
});
