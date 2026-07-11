import type { ConsoleMessage, Page } from "@playwright/test";

/**
 * Console error text fragments that are known-benign and should not fail the
 * smoke suite even though they land on `console.error`. Kept empty by
 * default — the production build under test emits none of these — but the
 * hook exists so a future non-fatal message (e.g. a browser extension notice
 * injected by the test runner's Chromium, or a documented React hydration
 * notice) can be tolerated with a one-line, commented addition instead of a
 * code change to the test bodies.
 */
const ALLOWED_CONSOLE_ERROR_PATTERNS: RegExp[] = [];

function isAllowedConsoleError(text: string): boolean {
  return ALLOWED_CONSOLE_ERROR_PATTERNS.some((pattern) => pattern.test(text));
}

export interface PageErrorTracker {
  /** `console.error(...)` messages not matched by the allow-list above. */
  readonly consoleErrors: readonly string[];
  /** Uncaught exceptions thrown in the page (browser `pageerror` event). */
  readonly pageErrors: readonly string[];
}

/**
 * Attaches `console` / `pageerror` listeners before any navigation so
 * nothing emitted during initial load or hydration is missed. Call this
 * before `page.goto(...)`, then read `.consoleErrors` / `.pageErrors` after
 * the page has settled.
 */
export function trackPageErrors(page: Page): PageErrorTracker {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];

  page.on("console", (message: ConsoleMessage) => {
    if (message.type() === "error" && !isAllowedConsoleError(message.text())) {
      consoleErrors.push(message.text());
    }
  });

  page.on("pageerror", (error: Error) => {
    pageErrors.push(error.message);
  });

  return { consoleErrors, pageErrors };
}
