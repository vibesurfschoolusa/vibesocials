import { readFileSync } from "node:fs";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Button } from "@/components/ui/button";
import {
  MISSING_WORKSPACE_ID_MESSAGE,
  WORKSPACE_CHANGED_MESSAGE,
  WORKSPACE_CHANGED_SAVE_MESSAGE,
} from "@/lib/workspaceChanged";

import { LoadError, loadErrorAsksReload } from "./load-error";

/**
 * R33 pages L5: after a switch in another tab a page's read is refused with
 * the switch sentence, and its only button, Retry, sent the same stale id and
 * got the same refusal. One control for every load error: for that refusal
 * (or a page with no id) the button is Reload page; otherwise Retry, as before.
 */

function findButton(node: ReactNode): ReactElement<{ onClick?: (event: unknown) => void; children?: ReactNode }> | null {
  if (!isValidElement(node)) {
    if (Array.isArray(node)) {
      for (const child of node) {
        const found = findButton(child);
        if (found) return found;
      }
    }
    return null;
  }
  const element = node as ReactElement<{ onClick?: (event: unknown) => void; children?: ReactNode }>;
  if (element.type === Button) return element;
  return findButton(element.props.children);
}

const originalWindow = (globalThis as { window?: unknown }).window;
afterEach(() => {
  (globalThis as { window?: unknown }).window = originalWindow;
});

describe("loadErrorAsksReload", () => {
  it("is true for the workspace refusals a read can get", () => {
    expect(loadErrorAsksReload(WORKSPACE_CHANGED_SAVE_MESSAGE)).toBe(true);
    expect(loadErrorAsksReload(WORKSPACE_CHANGED_MESSAGE)).toBe(true);
    expect(loadErrorAsksReload(MISSING_WORKSPACE_ID_MESSAGE)).toBe(true);
  });

  it("is false for any other failure", () => {
    expect(loadErrorAsksReload("Failed to load your queue.")).toBe(false);
    expect(loadErrorAsksReload(null)).toBe(false);
    expect(loadErrorAsksReload(undefined)).toBe(false);
  });
});

describe("LoadError", () => {
  it("for the switch refusal shows its sentence and Reload page, which reloads the page", () => {
    const html = renderToStaticMarkup(createElement(LoadError, { message: WORKSPACE_CHANGED_SAVE_MESSAGE, onRetry: () => {} }));
    expect(html).toContain(WORKSPACE_CHANGED_SAVE_MESSAGE);
    expect(html).toContain(">Reload page</button>");
    expect(html).not.toContain(">Retry<");

    const reload = vi.fn();
    (globalThis as { window?: unknown }).window = { location: { reload } };
    const onRetry = vi.fn();
    const button = findButton(LoadError({ message: WORKSPACE_CHANGED_SAVE_MESSAGE, onRetry }));
    button?.props.onClick?.({});
    expect(reload).toHaveBeenCalledTimes(1);
    expect(onRetry).not.toHaveBeenCalled();
  });

  it("for a page with no id it is Reload page too", () => {
    const html = renderToStaticMarkup(createElement(LoadError, { message: MISSING_WORKSPACE_ID_MESSAGE, onRetry: () => {} }));
    expect(html).toContain(">Reload page</button>");
  });

  it("for any other failure shows the sentence and Retry, which asks again", () => {
    const html = renderToStaticMarkup(createElement(LoadError, { message: "Failed to load your queue.", onRetry: () => {} }));
    expect(html).toContain("Failed to load your queue.");
    expect(html).toContain(">Retry</button>");
    expect(html).not.toContain("Reload page");

    const reload = vi.fn();
    (globalThis as { window?: unknown }).window = { location: { reload } };
    const onRetry = vi.fn();
    const button = findButton(LoadError({ message: "Failed to load your queue.", onRetry }));
    button?.props.onClick?.({});
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(reload).not.toHaveBeenCalled();
  });

  it("keeps a site's own button name and the sentence after the message", () => {
    const html = renderToStaticMarkup(
      createElement(LoadError, { message: "Couldn't load.", detail: "We need them.", retryLabel: "Try again", onRetry: () => {} }),
    );
    expect(html).toContain("Couldn&#x27;t load. We need them.");
    expect(html).toContain(">Try again</button>");
  });

  it("is a client component", () => {
    const raw = readFileSync(new URL("./load-error.tsx", import.meta.url), "utf8");
    expect(raw.startsWith('"use client";')).toBe(true);
  });
});

// Every load error with a Retry uses the one control, so none offers a Retry
// that sends the same stale id.
describe("every load-error site uses LoadError", () => {
  const read = (relative: string) => readFileSync(new URL(relative, import.meta.url), "utf8");

  for (const [name, relative, retry] of [
    ["Queue", "../app/queue/queue-view.tsx", "onRetry={handleReload}"],
    ["Activity", "../app/activity/activity-view.tsx", "onRetry={reload}"],
    ["Media", "./media-library.tsx", "onRetry={handleRetry}"],
    ["Dashboard recent posts", "./dashboard/recent-activity.tsx", "onRetry={reload}"],
    ["Add many's platforms", "../app/posts/bulk/bulk-posts-form.tsx", "onRetry={reload}"],
  ] as const) {
    it(name, () => {
      const raw = read(relative);
      expect(raw).toContain('import { LoadError } from "@/components/load-error";');
      expect(raw).toMatch(new RegExp(`<LoadError[^>]*message=\\{(error|connectionsError)\\}[^>]*${retry.replace(/[{}]/g, "\\$&")}`));
      // No hand-made Retry button is left beside a load error.
      expect(raw).not.toMatch(/onClick=\{(handleReload|reload|handleRetry)\}>\s*(Retry|Try again)/);
    });
  }

  it("Create's connections card", () => {
    const raw = read("./create-post-form.tsx");
    expect(raw).toContain('import { LoadError } from "@/components/load-error";');
    const card = raw.slice(raw.indexOf('title="Couldn\'t load your connections"'), raw.indexOf("</Alert>", raw.indexOf('title="Couldn\'t load your connections"')));
    expect(card).toContain("<LoadError");
    expect(card).toContain("message={connectionsError ?? CONNECTIONS_FAILED_TEXT}");
    expect(card).toContain("retryRef={connectionsRetryRef}");
    expect(card).not.toMatch(/>\s*Retry\s*</);
  });
});
