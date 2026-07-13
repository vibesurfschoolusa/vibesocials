import path from "node:path";

import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

import { seedWorkspaceConnection } from "./support/seed-connection";

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
 * src/app/{login,register,posts/new,queue,activity,settings,join/[token]}/*
 * and src/components/team-section.tsx, cross-checked against the current
 * source as of this commit — a real scaffold, not placeholders. If the UI
 * changes, update the selectors here in the same PR.
 *
 * Team Workspaces: the "owner invites..." scenario below needs everything
 * "compose a post" already needs (a connected platform + blob store — see
 * e2e/README.md's "OAuth test doubles" section) PLUS that connection living
 * on the shared workspace the invite grants access to, not just the owner's
 * personal one — an unconnected workspace hits the same zero-connection
 * empty state either test would.
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
 * Same story for `getByLabel("Caption", { exact: true })`: the composer also
 * renders a "Generate a caption when media is added" wrapping-label checkbox
 * (src/components/create-post-form.tsx), which the default case-insensitive
 * substring match would resolve alongside the actual textarea.
 *
 * The success-banner assertions need `getByText(..., { exact: true })` too:
 * on submit the composer renders BOTH the success Alert titled "Post
 * scheduled" / "Post queued" AND a toast that repeats that title as a prefix
 * ("Post scheduled — see it in your Queue" — create-post-form.tsx's
 * toast.success), so the default substring match resolves to 2 elements.
 * Caught for real in CI (strict-mode violation, run 29213578981); `exact`
 * pins the Alert title, whose "View queue"/"View activity" link the next
 * step clicks.
 */

// Capability gates, so CI runs exactly the flows whose doubles are real and
// SKIPS (never fakes green on) the ones that aren't:
//  - E2E_DATABASE_URL: a throwaway, migrated test Postgres (NEVER prod). Gates
//    the whole file — no DB, nothing authenticated runs.
//  - E2E_UPLOAD_STUBS_READY: the blob-UPLOAD double exists (Task F) — a mock
//    Vercel-Blob server reached via the NEXT_PUBLIC_VERCEL_BLOB_API_URL seam,
//    plus a seeded SocialConnection so the composer will submit. Gates the
//    "schedule a post" flow, which uploads media then writes a scheduled job
//    (no publish, no platform call). CI sets this — the flow runs for real.
//  - E2E_STUBS_READY: the full PUBLISH double exists — a path that actually
//    runs the platform clients on an immediate publish. Gates "compose a post"
//    and "owner invites → member posts". NOT achievable in this harness: an
//    immediate publish calls inngest.send(), which THROWS under `next start`
//    (prod mode, no event key), and the real publish is an async Inngest
//    function no worker runs here — so a green would prove only "job created +
//    shown in Activity", not "published to a connected platform". Left unset in
//    CI, these SKIP — honest "not exercised". See e2e/README.md ("Why compose /
//    invite stay skipped").
const dbReady = !!process.env.E2E_DATABASE_URL;
const uploadStubsReady = !!process.env.E2E_UPLOAD_STUBS_READY;
const publishStubsReady = !!process.env.E2E_STUBS_READY;

const SAMPLE_IMAGE_PATH = path.join(__dirname, "fixtures", "sample-image.png");

/** `POST /api/workspaces/invites` returns `${NEXTAUTH_URL ?? ""}/join/<token>`
 *  — absolute if NEXTAUTH_URL is set in this environment, a bare path
 *  otherwise (see src/app/api/workspaces/invites/route.ts). `page.goto` wants
 *  a path either way, so parse out the pathname when it's absolute and fall
 *  back to the raw string (already a bare path) when `URL` rejects it. */
function joinPathFromInviteUrl(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

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
        test.skip(
          !publishStubsReady,
          "Needs a real publish path (inngest.send throws in prod; no worker runs the platform clients here) — set E2E_STUBS_READY (see e2e/README.md)",
        );
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
          .getByLabel("Caption", { exact: true })
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
        // src/components/ui/alert.tsx) — match on visible text, `exact`
        // because the submit toast ("Post queued — track it in Activity")
        // repeats the title as a prefix (see header note).
        await expect(page.getByText("Post queued", { exact: true })).toBeVisible();
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
        test.skip(
          !uploadStubsReady,
          "Needs the blob-upload double for the media upload step — set E2E_UPLOAD_STUBS_READY (see e2e/README.md)",
        );
        const scheduler = await loginAsFreshUser(page, request, "schedule");
        // The composer refuses to submit (schedule included) without at least
        // one connected platform — seed one on this fresh user's workspace so
        // the flow can reach the schedule write. The connection is inert; a
        // scheduled job creates no results and calls no platform client.
        await seedWorkspaceConnection(scheduler.email);

        await page.goto("/posts/new");
        await page.setInputFiles("#post-media", SAMPLE_IMAGE_PATH);
        await page
          .getByLabel("Caption", { exact: true })
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
        // `exact`: the submit toast ("Post scheduled — see it in your Queue")
        // repeats the Alert title as a prefix — the default substring match
        // resolved both (CI strict-mode violation; see header note).
        await expect(page.getByText("Post scheduled", { exact: true })).toBeVisible();

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

    // Team Workspaces plan amendment (Task 8, design §7/§8): invite -> join
    // -> post-attribution flow. Two accounts share one browser (`page`), so
    // each hop is explicit about whose session is active. `page.request` —
    // not the bare `request` fixture `registerViaApi` uses above — shares
    // cookies with the browser context, which is what lets the invite POST
    // below ride the owner's just-established login session.
    test("owner invites → member joins → member posts with attribution", async ({
      page,
      request,
      context,
    }) => {
      test.skip(
        !publishStubsReady,
        "Member-posts step needs a real publish path (see compose test / e2e/README.md) — set E2E_STUBS_READY",
      );
      const owner = await loginAsFreshUser(page, request, "invite-owner");

      // Simpler and more stable than driving the Team section's Create/Copy
      // UI (src/components/team-section.tsx) for what this test actually
      // needs to assert: a live invite link, created with the owner's real
      // session.
      const inviteResponse = await page.request.post("/api/workspaces/invites");
      if (!inviteResponse.ok()) {
        throw new Error(
          `Failed to create invite: ${inviteResponse.status()} ${await inviteResponse.text()}`,
        );
      }
      const { url: joinUrl } = (await inviteResponse.json()) as { url: string };

      // Sign the owner out and become a second, fresh account — same
      // sign-out-then-sign-in-again pattern as "register via the UI" above.
      await context.clearCookies();
      const member = await loginAsFreshUser(page, request, "invite-member");

      await page.goto(joinPathFromInviteUrl(joinUrl));

      // src/app/join/[token]/join-view.tsx
      await expect(
        page.getByRole("heading", { level: 1, name: `Join ${owner.name}'s workspace?` }),
      ).toBeVisible();
      await page.getByRole("button", { name: "Join workspace" }).click();
      await expect(page.getByText(`Joined ${owner.name}'s workspace.`)).toBeVisible();

      // Accept switches the active-workspace cookie to the shared workspace
      // (design §1) and JoinView redirects to "/" on success.
      await expect(page).toHaveURL("/");

      // Compose + publish as the member, mirroring "compose a post and see
      // it land in Activity" above.
      await page.goto("/posts/new");
      await page.setInputFiles("#post-media", SAMPLE_IMAGE_PATH);
      await page
        .getByLabel("Caption", { exact: true })
        .fill("Hello from the member, via the Playwright core-flow suite.");

      const form = page.locator("form");
      await form
        .getByRole("group", { name: "When to publish" })
        .getByRole("button", { name: "Publish now" })
        .click();
      await form.getByRole("button", { name: "Publish post" }).click();
      await page
        .getByRole("dialog")
        .getByRole("button", { name: "Publish now" })
        .click();

      // `exact`: same Alert-title + toast-prefix pair as the compose test.
      await expect(page.getByText("Post queued", { exact: true })).toBeVisible();
      await page.getByRole("link", { name: "View activity" }).click();

      await expect(page).toHaveURL("/activity");
      await expect(
        page.getByRole("heading", { level: 1, name: "Activity" }),
      ).toBeVisible();
      await expect(
        page.getByText("Hello from the member, via the Playwright core-flow suite."),
      ).toBeVisible();
      // Attribution (design §7, src/components/activity/post-job-card.tsx):
      // the shared workspace now has 2 members, so the card shows
      // "by {creator name}" next to the timestamp.
      await expect(page.getByText(`by ${member.name}`)).toBeVisible();
    });
  },
);
