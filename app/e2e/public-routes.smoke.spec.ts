import { expect, test } from "@playwright/test";

import { trackPageErrors } from "./test-helpers";

/**
 * Health track H3 smoke suite.
 *
 * These are the only routes this sandbox can genuinely exercise end-to-end:
 * no database, no OAuth credentials. All four are statically prerendered
 * (confirmed via `npm run build` output — each is marked `○ (Static)`) and
 * `isPublicRoute()` (src/components/shell/nav.ts) renders them with no app
 * shell and no session-gated redirect, so they render identically whether or
 * not a database is reachable. See e2e/README.md for what is deliberately
 * NOT covered here.
 */

interface PublicRoute {
  path: string;
  /** Expected accessible name of the page's single <h1>. */
  heading: string;
  /** Accessible names of labelled form controls that must be present, if any. */
  labelledFields?: string[];
}

const PUBLIC_ROUTES: PublicRoute[] = [
  { path: "/login", heading: "Log in", labelledFields: ["Email", "Password"] },
  {
    path: "/register",
    heading: "Create an account",
    labelledFields: ["Email", "Password"],
  },
  { path: "/privacy", heading: "Privacy Policy" },
  { path: "/terms", heading: "Terms of Service" },
];

for (const route of PUBLIC_ROUTES) {
  test.describe(`${route.path}`, () => {
    test("returns HTTP 200 and renders the expected heading", async ({ page }) => {
      const response = await page.goto(route.path);

      expect(response?.status()).toBe(200);
      await expect(
        page.getByRole("heading", { level: 1, name: route.heading }),
      ).toBeVisible();
    });

    test("has exactly one <h1> (basic a11y sanity)", async ({ page }) => {
      await page.goto(route.path);

      await expect(page.locator("h1")).toHaveCount(1);
    });

    if (route.labelledFields) {
      for (const fieldName of route.labelledFields) {
        test(`has a labelled "${fieldName}" form control`, async ({ page }) => {
          await page.goto(route.path);

          // exact: true — both /login and /register also render a
          // "Show password" icon-button (aria-label), and getByLabel's
          // default substring match would otherwise resolve "Password" to
          // both that button and the actual <input>.
          await expect(page.getByLabel(fieldName, { exact: true })).toBeVisible();
        });
      }
    }

    test("has no unexpected console or page errors", async ({ page }) => {
      const tracker = trackPageErrors(page);

      await page.goto(route.path);
      await page.waitForLoadState("networkidle");

      expect(tracker.pageErrors, "uncaught exceptions").toEqual([]);
      expect(tracker.consoleErrors, "unexpected console.error calls").toEqual([]);
    });
  });
}
