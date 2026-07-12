import path from "node:path";

import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

/**
 * Health track H3 — authenticated core-flow scaffold.
 *
 * These flows need infra this sandbox does not have: a seeded Postgres
 * reachable at `E2E_DATABASE_URL` (migrated), and, for the posting flow, a
 * connected platform (real sandbox app or a stub — see e2e/README.md).
 * Until `E2E_DATABASE_URL` is set, the whole file is skipped so it can never
 * report a false pass.
 *
 * The bodies below are written against the real selectors/copy in
 * src/app/{login,register,posts/new,queue,activity,settings}/*, cross-checked
 * against the current source as of this commit — a real scaffold, not
 * placeholders. If the UI changes, update the selectors here in the same PR.
 *
 * Each test provisions its own user (via the register API directly, not the
 * UI, to keep it fast) rather than sharing one created by another test. With
 * `fullyParallel: true` (playwright.config.ts) tests may run concurrently
 * and in any order, so nothing here depends on another test having run
 * first.
 *
 * Every `getByLabel("Password", { exact: true })` below needs that option:
 * the login/register forms also render a "Show password" icon-button
 * (`aria-label="Show password"`), and getByLabel's default substring match
 * would otherwise resolve "Password" to both it and the actual <input> —
 * caught for real in public-routes.smoke.spec.ts, applied here by
 * inspection since this file can't run in this sandbox to catch it itself.
 */

const dbReady = !!process.env.E2E_DATABASE_URL;

const SAMPLE_IMAGE_PATH = path.join(__dirname, "fixtures", "sample-image.png");

/** `<input type="datetime-local">` wants "YYYY-MM-DDTHH:mm" in the browser's
 *  local time zone (see src/lib/scheduling.ts's localDateTimeToUtcIso, which
 *  is what the form submits this value through). Built from local getters —
 *  not `toISOString()`, which is UTC and would drift by the local offset. */
function toDateTimeLocalInputValue(date: Date): string {
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

interface TestCredentials {
  email: string;
  password: string;
  name: string;
}

/** A fresh, collision-free identity for one test run. */
function freshTestUser(label: string): TestCredentials {
  const suffix = `${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  return {
    email: `e2e-${suffix}@example.test`,
    password: "correct horse battery staple",
    name: `E2E ${label}`,
  };
}

/** Creates the account directly through the API (mirrors
 *  src/app/api/auth/register/route.ts's contract) — faster than driving the
 *  register form, and this suite already covers that form separately in the
 *  "register via the UI" test below. */
async function registerViaApi(
  request: APIRequestContext,
  user: TestCredentials,
): Promise<void> {
  const response = await request.post("/api/auth/register", { data: user });
  if (!response.ok()) {
    throw new Error(
      `Failed to seed test user ${user.email}: ${response.status()} ${await response.text()}`,
    );
  }
}

/** Registers a fresh user via the API, then logs in through the real UI
 *  form (next-auth v4 `credentials` provider, `jwt` session strategy — see
 *  src/lib/auth.ts) so the browser ends up with a genuine session cookie. */
async function loginAsFreshUser(
  page: Page,
  request: APIRequestContext,
  label: string,
): Promise<TestCredentials> {
  const user = freshTestUser(label);
  await registerViaApi(request, user);

  await page.goto("/login");
  await page.getByLabel("Email").fill(user.email);
  await page.getByLabel("Password", { exact: true }).fill(user.password);
  await page.getByRole("button", { name: "Sign in" }).click();

  // LoginPage pushes to "/" on success; "/" renders the authenticated
  // Dashboard (not the signed-out Landing) once useSession() settles.
  await expect(page).toHaveURL("/");

  return user;
}

test.describe(
  dbReady ? "core flows" : "core flows (skipped — needs E2E_DATABASE_URL)",
  () => {
    test.skip(!dbReady, "Set E2E_DATABASE_URL to a seeded test DB to run these");

    test("register via the UI, then log in with the new account", async ({
      page,
      context,
    }) => {
      const user = freshTestUser("register-ui");

      await page.goto("/register");
      await expect(
        page.getByRole("heading", { level: 1, name: "Create an account" }),
      ).toBeVisible();

      await page.getByLabel("Name").fill(user.name);
      await page.getByLabel("Email").fill(user.email);
      await page.getByLabel("Password", { exact: true }).fill(user.password);
      await page.getByRole("button", { name: "Create account" }).click();

      // RegisterPage signs the new account in immediately on a 201
      // (src/app/register/page.tsx) and lands on the authenticated dashboard —
      // no separate manual login required for a fresh registration.
      await expect(page).toHaveURL("/");
      await expect(
        page.getByRole("heading", { level: 1, name: "Welcome back" }),
      ).toBeVisible();

      // Clear the session and exercise the manual login form too, so this
      // test still covers the plain email/password sign-in path.
      await context.clearCookies();

      await page.goto("/login");
      await page.getByLabel("Email").fill(user.email);
      await page.getByLabel("Password", { exact: true }).fill(user.password);
      await page.getByRole("button", { name: "Sign in" }).click();

      await expect(page).toHaveURL("/");
      await expect(
        page.getByRole("heading", { level: 1, name: "Welcome back" }),
      ).toBeVisible();
    });

    test.describe("as a logged-in user", () => {
      test("compose a post and see it land in Activity", async ({ page, request }) => {
        await loginAsFreshUser(page, request, "compose");

        await page.goto("/posts/new");
        await expect(
          page.getByRole("heading", { level: 1, name: "Create post" }),
        ).toBeVisible();

        // Needs at least one connected platform (see README's "OAuth test
        // doubles" section) and a working blob store
        // (BLOB_READ_WRITE_TOKEN — src/app/api/upload/route.ts uses
        // @vercel/blob/client) for the upload step below to succeed.
        await page.setInputFiles("#post-media", SAMPLE_IMAGE_PATH);
        await page
          .getByLabel("Caption")
          .fill("Hello from the Playwright core-flow suite.");

        const form = page.locator("form");
        await form
          .getByRole("group", { name: "When to publish" })
          .getByRole("button", { name: "Publish now" })
          .click();
        await form.getByRole("button", { name: "Publish post" }).click();

        // Publish-now confirmation dialog (per-post platform targeting change)
        await page
          .getByRole("dialog")
          .getByRole("button", { name: "Publish now" })
          .click();

        // Alert `title` renders as styled text, not a heading (see
        // src/components/ui/alert.tsx) — match on visible text instead.
        await expect(page.getByText("Post queued")).toBeVisible();
        await page.getByRole("link", { name: "View activity" }).click();

        await expect(page).toHaveURL("/activity");
        await expect(
          page.getByRole("heading", { level: 1, name: "Activity" }),
        ).toBeVisible();
        await expect(
          page.getByText("Hello from the Playwright core-flow suite."),
        ).toBeVisible();
      });

      test("schedule a post and see it land in the Queue", async ({ page, request }) => {
        await loginAsFreshUser(page, request, "schedule");

        await page.goto("/posts/new");
        await page.setInputFiles("#post-media", SAMPLE_IMAGE_PATH);
        await page
          .getByLabel("Caption")
          .fill("Scheduled via the Playwright core-flow suite.");

        const form = page.locator("form");
        await form
          .getByRole("group", { name: "When to publish" })
          .getByRole("button", { name: "Schedule" })
          .click();

        const oneHourFromNow = new Date(Date.now() + 60 * 60 * 1000);
        await page
          .locator("#post-schedule")
          .fill(toDateTimeLocalInputValue(oneHourFromNow));

        await form.getByRole("button", { name: "Schedule post" }).click();
        await expect(page.getByText("Post scheduled")).toBeVisible();

        await page.getByRole("link", { name: "View queue" }).click();
        await expect(page).toHaveURL("/queue");
        await expect(
          page.getByRole("heading", { level: 1, name: "Queue" }),
        ).toBeVisible();
        await expect(
          page.getByText("Scheduled via the Playwright core-flow suite."),
        ).toBeVisible();
      });

      test("edit settings and see the change persist", async ({ page, request }) => {
        await loginAsFreshUser(page, request, "settings");

        await page.goto("/settings");
        await expect(
          page.getByRole("heading", { level: 1, name: "Settings" }),
        ).toBeVisible();

        const website = `https://example.test/${Date.now()}`;
        await page.getByLabel("Company website").fill(website);
        await page.getByLabel("Default hashtags").fill("#e2e #playwright");
        await page.getByRole("button", { name: "Save settings" }).click();

        await expect(page.getByText("Settings saved successfully!")).toBeVisible();

        // Reload to confirm the change persisted server-side (the settings
        // page re-fetches the user row on the server), not just local state.
        await page.reload();
        await expect(page.getByLabel("Company website")).toHaveValue(website);
      });
    });
  },
);
