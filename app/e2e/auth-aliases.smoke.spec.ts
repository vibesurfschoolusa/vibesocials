import { expect, test } from "@playwright/test";

/**
 * Auth-path aliases. Real users type /signup and /signin — before these
 * redirects existed, an anonymous visitor typing /signup was bounced by the
 * middleware to /login?callbackUrl=%2Fsignup: a LOGIN form in response to
 * trying to SIGN UP (and the callback then 404s after login). Permanent
 * redirects in next.config.ts map each alias to the real route; like the
 * public-routes suite, these need no database.
 */

const ALIASES: Array<{ path: string; target: string; heading: string }> = [
  { path: "/signup", target: "/register", heading: "Create an account" },
  { path: "/sign-up", target: "/register", heading: "Create an account" },
  { path: "/signin", target: "/login", heading: "Log in" },
  { path: "/sign-in", target: "/login", heading: "Log in" },
];

for (const alias of ALIASES) {
  test(`${alias.path} redirects to ${alias.target}`, async ({ page }) => {
    await page.goto(alias.path);

    await expect(page).toHaveURL(new RegExp(`${alias.target}$`));
    await expect(
      page.getByRole("heading", { level: 1, name: alias.heading }),
    ).toBeVisible();
  });
}
