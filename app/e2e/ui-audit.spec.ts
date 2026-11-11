import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import type { Platform } from "@prisma/client";

import {
  Camera,
  PageWatch,
  newAuditContext,
  recordFailure,
  snap,
  waitQuiet,
  type SnapContext,
  type ViewportName,
} from "./ui-audit/camera";
import { makeLogo, makePhotos, makeVideo, putIntoStore, type AuditFile } from "./ui-audit/media";
import {
  AUDIT_PASSWORD,
  BILLING_EMAILS,
  MAIN_EMAILS,
  auditDatabaseUrl,
  auditPrisma,
  seedBilling,
  seedMain,
  type BillingSeed,
  type MainSeed,
} from "./ui-audit/seed";

/**
 * UI audit (task A1): a picture of every screen in its listed states, on a
 * phone and a desktop, for the lead to look at. Never merged; runs only from
 * .github/workflows/ui-audit.yml with UI_AUDIT=1, against the CI database.
 *
 * Two passes, one per server build: UI_AUDIT_PASS=main (billing off, the
 * operator address set, every platform configured with dummy values) and
 * UI_AUDIT_PASS=billing (billing on with a dummy Stripe key Stripe refuses).
 *
 * Every screen and state runs in its own fresh browser context, inside its own
 * try/catch: one that fails is written to report.json with its error and a
 * picture of where it stopped, and the run goes on.
 */

const ENABLED = process.env.UI_AUDIT === "1";
const PASS: "main" | "billing" = process.env.UI_AUDIT_PASS === "billing" ? "billing" : "main";
const OUT_DIR = process.env.UI_AUDIT_OUT ?? path.join(__dirname, "..", "ui-audit-output", PASS);
const BASE_URL = "http://127.0.0.1:3000";
// Sign-in state stays out of the uploaded folder.
const STATE_DIR = path.join(tmpdir(), `ui-audit-sessions-${PASS}`);

const ALL_PLATFORMS: Platform[] = [
  "tiktok",
  "youtube",
  "x",
  "linkedin",
  "instagram",
  "google_business_profile",
  "facebook_page",
  "pinterest",
];

type Who = "signedOut" | "owner" | "member" | "visitor" | keyof typeof BILLING_EMAILS;

interface Tools {
  page: Page;
  /** Takes the picture for `state` now. */
  shot: (state: string, options?: { fullPage?: boolean; element?: ReturnType<Page["locator"]>; note?: string }) => Promise<void>;
  /** Runs `fn` and takes the picture; a failure is recorded for this state only. */
  step: (state: string, fn: () => Promise<void>, options?: { fullPage?: boolean; note?: string }) => Promise<void>;
}

interface Screen {
  n: number;
  screen: string;
  who: Who;
  workspaceId?: () => string;
  dark?: boolean;
  only?: ViewportName[];
  /** The state named when the run throws before its first picture. */
  state: string;
  run: (tools: Tools) => Promise<void>;
}

/** Everything the screens need from the setup. */
interface World {
  main?: MainSeed;
  billing?: BillingSeed;
  photos: AuditFile[];
  video: AuditFile | null;
  links: {
    upload?: string;
    uploadRevoked?: string;
    review?: string;
    reviewRevoked?: string;
    connect?: string;
    connectRevoked?: string;
    connectEmpty?: string;
    invite?: string;
  };
  sessions: Partial<Record<Who, string>>;
}

const world: World = { photos: [], video: null, links: {}, sessions: {} };

function need<T>(value: T | undefined | null, what: string): T {
  if (value === undefined || value === null) throw new Error(`setup did not produce ${what}`);
  return value;
}

function tokenOf(url: string): string {
  return new URL(url, BASE_URL).pathname.split("/").filter(Boolean).pop() ?? "";
}

async function go(page: Page, address: string): Promise<void> {
  await page.goto(address, { waitUntil: "domcontentloaded", timeout: 45_000 });
  await waitQuiet(page);
}

async function signIn(browser: Browser, who: Who, email: string): Promise<void> {
  const context = await newAuditContext(browser, { viewport: "desktop", colorScheme: "light", baseURL: BASE_URL });
  try {
    const page = await context.newPage();
    await page.goto("/login", { waitUntil: "domcontentloaded" });
    await page.locator("#email").fill(email);
    await page.locator("#password").fill(AUDIT_PASSWORD);
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.waitForURL((url) => url.pathname === "/", { timeout: 30_000 });
    mkdirSync(STATE_DIR, { recursive: true });
    const file = path.join(STATE_DIR, `${who}.json`);
    await context.storageState({ path: file });
    world.sessions[who] = file;
  } finally {
    await context.close();
  }
}

// ---------------------------------------------------------------- composer helpers

function files(list: AuditFile[]) {
  return list.map((f) => ({ name: f.name, mimeType: f.mimeType, buffer: f.buffer }));
}

/** Create page loaded past its connection check (the form renders only then). */
async function openComposer(page: Page): Promise<void> {
  await go(page, "/posts/new");
  await page.getByRole("group", { name: "When to publish" }).waitFor({ timeout: 30_000 });
  await waitQuiet(page);
}

/** Stops a composer screen from ever creating a post: these pictures only look. */
async function neverCreatePosts(page: Page): Promise<void> {
  await page.route("**/api/posts", (route) =>
    route.request().method() === "POST" ? route.abort("blockedbyclient") : route.continue(),
  );
}

async function waitForUploads(page: Page): Promise<void> {
  await page.waitForTimeout(500);
  await expect
    .poll(async () => page.getByRole("progressbar").count(), { timeout: 90_000, intervals: [500, 1000, 2000] })
    .toBe(0);
  await waitQuiet(page);
}

/**
 * Attaches files the way a person does, with "Generate a caption when media is
 * added" unticked first: CI has no AI key, so the automatic caption could only
 * fail and leave an error toast over the picture.
 */
async function attach(page: Page, list: AuditFile[]): Promise<void> {
  const auto = page.getByLabel("Generate a caption when media is added");
  if (await auto.isChecked()) await auto.uncheck();
  await page.locator("#post-media").setInputFiles(files(list));
  await waitForUploads(page);
}

async function caption(page: Page, text: string): Promise<void> {
  await page.locator("#post-caption").fill(text);
}

async function chooseMode(page: Page, label: "Publish now" | "Schedule" | "Save draft"): Promise<void> {
  await page.getByRole("group", { name: "When to publish" }).getByRole("button", { name: label, exact: true }).click();
}

async function localDateTime(page: Page, daysAhead: number, hour: number): Promise<string> {
  return page.evaluate(
    ({ daysAhead, hour }) => {
      const d = new Date(Date.now() + daysAhead * 86_400_000);
      const p = (n: number) => String(n).padStart(2, "0");
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(hour)}:00`;
    },
    { daysAhead, hour },
  );
}

async function localDate(page: Page, daysAhead: number): Promise<string> {
  return (await localDateTime(page, daysAhead, 0)).slice(0, 10);
}

async function scrollToHeading(page: Page, name: string, level = 2): Promise<void> {
  const heading = page.getByRole("heading", { level, name, exact: true });
  await heading.waitFor({ timeout: 15_000 });
  await heading.evaluate((el) => {
    el.scrollIntoView({ block: "start" });
    // The sticky top bar is 4rem tall: keep the heading below it.
    window.scrollBy(0, -80);
  });
  await page.waitForTimeout(300);
}

/** Presses the composer's main button and waits for the server's answer. */
async function submitAndWait(page: Page): Promise<void> {
  const answer = page.waitForResponse(
    (r) => new URL(r.url()).pathname === "/api/posts" && r.request().method() === "POST",
    { timeout: 30_000 },
  );
  await page.locator("form button[type=submit]").first().click();
  await answer;
  await waitQuiet(page);
}

// ---------------------------------------------------------------- the screens

const owner = (): string => need(world.main, "the main seed").mainId;

const COMPOSER_CAPTION = "Saturday lesson at 8: small, clean waves and a few spots left. Boards and wetsuits included.";

function mainScreens(): Screen[] {
  const m = () => need(world.main, "the main seed");
  const L = world.links;
  const photo = () => world.photos[0];
  const s: Screen[] = [];
  const page1 = (n: number, screen: string, state: string, who: Who, address: () => string, extra: Partial<Screen> = {}) =>
    s.push({
      n,
      screen,
      state,
      who,
      ...extra,
      run: async ({ page, shot }) => {
        await go(page, address());
        await shot(state);
      },
    });

  // Signed out.
  page1(1, "landing", "signed-out", "signedOut", () => "/");
  page1(2, "login", "empty", "signedOut", () => "/login");
  s.push({
    n: 2,
    screen: "login",
    state: "wrong-password",
    who: "signedOut",
    run: async ({ page, shot }) => {
      await go(page, "/login");
      await page.locator("#email").fill(MAIN_EMAILS.owner);
      await page.locator("#password").fill("not-the-password-1");
      await page.getByRole("button", { name: "Sign in" }).click();
      await page.getByText("Invalid email or password.").waitFor({ timeout: 20_000 });
      await shot("wrong-password");
    },
  });
  page1(3, "register", "empty", "signedOut", () => "/register");
  s.push({
    n: 3,
    screen: "register",
    state: "validation-error",
    who: "signedOut",
    run: async ({ page, shot }) => {
      await go(page, "/register");
      await page.locator("#name").fill("Sam Rivera");
      // The browser accepts this address; the server's own check refuses it.
      await page.locator("#email").fill("sam@example");
      await page.locator("#password").fill("long-enough-1");
      await page.getByRole("button", { name: "Create account" }).click();
      await page.getByText("Enter a valid email address.").waitFor({ timeout: 20_000 });
      await shot("validation-error", {
        note: "Server-side refusal. The browser's own bubbles for an empty required field are not captured by screenshots.",
      });
    },
  });
  page1(4, "forgot-password", "empty", "signedOut", () => "/forgot-password");
  page1(5, "terms", "page", "signedOut", () => "/terms");
  page1(6, "privacy", "page", "signedOut", () => "/privacy");
  page1(7, "help", "page", "signedOut", () => "/help");
  page1(8, "about", "page", "signedOut", () => "/about");
  // A signed-out visitor to an unknown address is sent to sign in by proxy.ts.
  page1(9, "not-found", "signed-out", "signedOut", () => "/this-address-does-not-exist");
  page1(10, "connect-link", "no-token", "signedOut", () => "/c");

  // Client pages, signed out.
  page1(11, "upload-link", "empty", "signedOut", () => `/u/${need(L.upload, "the upload link")}`);
  s.push({
    n: 11,
    screen: "upload-link",
    state: "after-upload",
    who: "signedOut",
    run: async ({ page, shot }) => {
      await go(page, `/u/${need(L.upload, "the upload link")}`);
      await page.locator("#upload-link-name").fill("Chris, camp parent");
      await page.locator("#upload-link-note").fill("Photos from Tuesday's camp, use whatever you like.");
      await page.locator("#upload-link-files").setInputFiles(files([world.photos[6]]));
      await page.getByRole("button", { name: /^Send/ }).click();
      await page.getByText(/arrived/).waitFor({ timeout: 60_000 });
      await shot("after-upload");
    },
  });
  page1(12, "review-link", "list", "signedOut", () => `/v/${need(L.review, "the review link")}`);
  s.push({
    n: 12,
    screen: "review-link",
    state: "one-post",
    who: "signedOut",
    run: async ({ page, shot }) => {
      await go(page, `/v/${need(L.review, "the review link")}`);
      const card = page.locator("main ul > li").first();
      await card.waitFor({ timeout: 20_000 });
      await shot("one-post", {
        element: card,
        note: "The page has no separate post view: every post is shown in full in the list. This is the first card alone.",
      });
    },
  });
  s.push({
    n: 12,
    screen: "review-link",
    state: "change-form",
    who: "signedOut",
    run: async ({ page, shot }) => {
      await go(page, `/v/${need(L.review, "the review link")}`);
      await page.getByRole("button", { name: "Ask for a change" }).first().click();
      await page.getByLabel("What would you like changed?").first().fill("Could the second photo be the one with the orange boards?");
      await shot("change-form");
    },
  });
  page1(13, "review-report", "page", "signedOut", () => `/v/${need(L.review, "the review link")}/report`);
  page1(14, "connect-link", "first-visit", "signedOut", () => `/c/${need(L.connect, "the connect link")}`);
  page1(14, "connect-link", "first-visit-nothing-connected", "signedOut", () => `/c/${need(L.connectEmpty, "the empty workspace's connect link")}`);
  page1(14, "connect-link", "success", "signedOut", () => `/c/${need(L.connect, "the connect link")}?success=instagram_connected`);
  page1(14, "connect-link", "cancelled", "signedOut", () => `/c/${need(L.connect, "the connect link")}?error=instagram_cancelled`);
  page1(14, "connect-link", "connect-failed", "signedOut", () => `/c/${need(L.connect, "the connect link")}?error=instagram_connect_failed`);
  page1(15, "revoked-link", "upload", "signedOut", () => `/u/${need(L.uploadRevoked, "the revoked upload link")}`);
  page1(15, "revoked-link", "review", "signedOut", () => `/v/${need(L.reviewRevoked, "the revoked review link")}`);
  page1(15, "revoked-link", "connect", "signedOut", () => `/c/${need(L.connectRevoked, "the revoked connect link")}`);
  page1(16, "join", "signed-in-visitor", "visitor", () => `/join/${need(L.invite, "the invite link")}`);
  page1(16, "join", "signed-out", "signedOut", () => `/join/${need(L.invite, "the invite link")}`);

  // Owner, main workspace.
  page1(17, "dashboard", "owner", "owner", () => "/");

  const composer = (state: string, act: (page: Page) => Promise<void>, fullPage = true) =>
    s.push({
      n: 18,
      screen: "create",
      state,
      who: "owner",
      run: async ({ page, shot }) => {
        await neverCreatePosts(page);
        await openComposer(page);
        await act(page);
        await shot(state, { fullPage });
      },
    });
  composer("empty", async () => undefined);
  composer("one-photo", async (page) => {
    await attach(page, [photo()]);
    await caption(page, COMPOSER_CAPTION);
    await page.locator("#post-alt-text").fill("Six students on soft-top boards at the water's edge, an instructor in front.");
  });
  composer("four-photos", async (page) => {
    await attach(page, world.photos.slice(0, 4));
    await caption(page, "Four photos from this week's lessons.");
  });
  composer("video", async (page) => {
    await attach(page, [need(world.video, "the video")]);
    await caption(page, "Pop-up drill in 20 seconds.");
  });
  composer("story", async (page) => {
    await attach(page, [photo()]);
    await caption(page, COMPOSER_CAPTION);
    await page
      .locator("fieldset", { has: page.getByText("Instagram: post to", { exact: true }) })
      .getByRole("radio", { name: "Story" })
      .check();
  });
  composer("schedule-weekly", async (page) => {
    await attach(page, [photo()]);
    await caption(page, COMPOSER_CAPTION);
    await chooseMode(page, "Schedule");
    await page.locator("#post-schedule").fill(await localDateTime(page, 2, 10));
    await page.locator("#post-repeat").selectOption("weekly");
  });
  composer("caption-per-platform", async (page) => {
    await attach(page, [photo()]);
    await caption(page, COMPOSER_CAPTION);
    await page.getByText("Caption per platform", { exact: true }).click();
    await page.getByRole("switch", { name: "Different caption for Instagram" }).click();
    await page
      .getByRole("textbox", { name: "Caption for Instagram" })
      .fill("Saturday lesson at 8 🌊 a few spots left. Link in bio to book.");
  });
  composer("google-offer", async (page) => {
    await attach(page, [photo()]);
    await caption(page, "10% off board rental this week.");
    await page.locator("#google-post-type").selectOption("offer");
    await page.locator("#google-offer-title").fill("10% off board rental");
    await page.locator("#google-offer-start-date").fill(await localDate(page, 1));
    await page.locator("#google-offer-end-date").fill(await localDate(page, 8));
    await page.locator("#google-offer-coupon").fill("WAVES10");
  });
  composer("google-event", async (page) => {
    await attach(page, [photo()]);
    await caption(page, "Free beach clean-up and surf lesson on Sunday.");
    await page.locator("#google-post-type").selectOption("event");
    await page.locator("#google-event-title").fill("Beach clean-up and free lesson");
    await page.locator("#google-event-start-date").fill(await localDate(page, 4));
    await page.locator("#google-event-end-date").fill(await localDate(page, 4));
  });
  s.push({
    n: 18,
    screen: "create",
    state: "confirm-dialog",
    who: "owner",
    run: async ({ page, shot }) => {
      await neverCreatePosts(page);
      await openComposer(page);
      await attach(page, [photo()]);
      await caption(page, COMPOSER_CAPTION);
      await chooseMode(page, "Publish now");
      await page.locator("form button[type=submit]").first().click();
      const dialog = page.getByRole("dialog");
      await dialog.waitFor({ timeout: 15_000 });
      await shot("confirm-dialog", { fullPage: false });
      await dialog.getByRole("button", { name: "Cancel" }).click();
      await dialog.waitFor({ state: "hidden", timeout: 10_000 });
    },
  });

  page1(19, "bulk", "empty", "owner", () => "/posts/bulk");
  s.push({
    n: 19,
    screen: "bulk",
    state: "five-photos",
    who: "owner",
    run: async ({ page, shot }) => {
      await neverCreatePosts(page);
      await go(page, "/posts/bulk");
      await page.locator("#bulk-files").setInputFiles(files(world.photos.slice(0, 5)));
      await waitForUploads(page);
      await page.waitForTimeout(1500);
      await shot("five-photos", {
        note: "Add many writes each caption with AI as soon as a file is added. CI has no AI key, so each row shows the caption error.",
      });
    },
  });

  page1(20, "queue", "list", "owner", () => "/queue");
  s.push({
    n: 20,
    screen: "queue",
    state: "calendar",
    who: "owner",
    run: async ({ page, shot }) => {
      await go(page, "/queue");
      await page.getByRole("group", { name: "Queue view" }).getByRole("button", { name: "Calendar" }).click();
      await shot("calendar");
    },
  });
  s.push({
    n: 20,
    screen: "queue",
    state: "edit-scheduled",
    who: "owner",
    run: async ({ page, shot }) => {
      await go(page, "/queue");
      await page.getByRole("button", { name: /^Edit "/ }).first().click();
      await page.getByRole("dialog").waitFor({ timeout: 15_000 });
      await shot("edit-scheduled", { fullPage: false });
    },
  });

  page1(21, "activity", "list", "owner", () => "/activity");
  s.push({
    n: 21,
    screen: "activity",
    state: "error-expanded",
    who: "owner",
    run: async ({ page, shot }) => {
      await go(page, "/activity");
      const toggles = page.getByRole("button", { name: /^Show \d+ errors?$/ });
      await toggles.first().waitFor({ timeout: 20_000 });
      for (let i = await toggles.count(); i > 0; i--) {
        await toggles.first().click();
      }
      await shot("error-expanded");
    },
  });

  const month = (offset: number) => {
    const d = new Date();
    const m = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + offset, 1));
    return `${m.getUTCFullYear()}-${String(m.getUTCMonth() + 1).padStart(2, "0")}`;
  };
  page1(22, "reports", "last-month", "owner", () => `/reports?month=${month(-1)}`);
  page1(22, "reports", "this-month", "owner", () => `/reports?month=${month(0)}`);
  page1(23, "media", "library", "owner", () => "/media");
  page1(24, "reviews", "page", "owner", () => "/reviews");

  s.push({
    n: 25,
    screen: "settings",
    state: "full",
    who: "owner",
    run: async ({ page, shot, step }) => {
      await go(page, "/settings");
      await shot("full");
      for (const [heading, state] of [
        ["Posts and emails", "section-captions"],
        ["Posting times", "section-posting-times"],
        ["Connections", "section-connections"],
        ["Team", "section-team"],
        ["Usage", "section-usage"],
        ["Account", "section-account"],
      ] as const) {
        await step(state, () => scrollToHeading(page, heading), { fullPage: false });
      }
    },
  });
  s.push({
    n: 25,
    screen: "settings",
    state: "choose-account",
    who: "owner",
    run: async ({ page, shot }) => {
      await go(page, `/settings?choose=${encodeURIComponent(m().pendingConnectionId)}`);
      await page.getByRole("heading", { name: "Choose which Facebook Page to connect" }).waitFor({ timeout: 20_000 });
      await shot("choose-account", {
        fullPage: false,
        note: "The pending choice is a seeded PendingConnection row, the one a Facebook callback writes when it finds several Pages.",
      });
    },
  });
  page1(26, "workspaces", "list", "owner", () => "/workspaces");
  s.push({
    n: 27,
    screen: "account-menu",
    state: "open",
    who: "owner",
    run: async ({ page, shot }) => {
      await go(page, "/");
      await page.locator('header button[aria-haspopup="dialog"]').click();
      await page.getByRole("group", { name: "Switch workspace" }).waitFor({ timeout: 15_000 });
      await shot("open", { fullPage: false });
    },
  });
  s.push({
    n: 28,
    screen: "navigation",
    state: "open",
    who: "owner",
    only: ["phone"],
    run: async ({ page, shot }) => {
      await go(page, "/");
      await page.getByRole("button", { name: "Open navigation" }).click();
      await page.getByRole("dialog", { name: "Navigation" }).waitFor({ timeout: 10_000 });
      await shot("open", { fullPage: false });
    },
  });
  page1(29, "dark", "dashboard", "owner", () => "/", { dark: true });
  page1(29, "dark", "create", "owner", () => "/posts/new", { dark: true });
  page1(29, "dark", "queue", "owner", () => "/queue", { dark: true });
  page1(29, "dark", "settings", "owner", () => "/settings", { dark: true });
  page1(29, "dark", "review-link", "signedOut", () => `/v/${need(L.review, "the review link")}`, { dark: true });
  page1(30, "not-found", "signed-in", "owner", () => "/this-address-does-not-exist");

  // Owner, the other workspaces.
  const empty = () => m().emptyId;
  page1(31, "empty-workspace", "dashboard", "owner", () => "/", { workspaceId: empty });
  page1(31, "empty-workspace", "queue", "owner", () => "/queue", { workspaceId: empty });
  page1(31, "empty-workspace", "activity", "owner", () => "/activity", { workspaceId: empty });
  page1(31, "empty-workspace", "media", "owner", () => "/media", { workspaceId: empty });
  page1(31, "empty-workspace", "reports", "owner", () => "/reports", { workspaceId: empty });
  const paused = () => m().pausedId;
  page1(32, "paused-workspace", "dashboard", "owner", () => "/", { workspaceId: paused });
  page1(32, "paused-workspace", "create", "owner", () => "/posts/new", { workspaceId: paused });
  s.push({
    n: 32,
    screen: "paused-workspace",
    state: "create-refused",
    who: "owner",
    workspaceId: paused,
    run: async ({ page, shot }) => {
      await openComposer(page);
      await caption(page, "Rentals open at 7 tomorrow.");
      // A draft: even if the refusal failed, nothing would be sent to a platform.
      await chooseMode(page, "Save draft");
      await submitAndWait(page);
      await shot("create-refused");
    },
  });

  // The member.
  page1(33, "member", "dashboard", "member", () => "/", { workspaceId: owner });
  page1(33, "member", "create", "member", () => "/posts/new", { workspaceId: owner });
  page1(33, "member", "queue", "member", () => "/queue", { workspaceId: owner });
  page1(33, "member", "settings", "member", () => "/settings", { workspaceId: owner });

  // Admin.
  page1(34, "admin", "list", "owner", () => "/admin");
  page1(34, "admin", "workspace", "owner", () => `/admin/workspaces/${encodeURIComponent(owner())}`);
  s.push({
    n: 34,
    screen: "admin",
    state: "pause-form",
    who: "owner",
    run: async ({ page, shot }) => {
      await go(page, `/admin/workspaces/${encodeURIComponent(owner())}`);
      const reason = page.locator("#pause-reason");
      await reason.fill("Paused while the account details are checked.");
      await reason.evaluate((el) => {
        el.scrollIntoView({ block: "center" });
      });
      await shot("pause-form", { fullPage: false, note: "Filled in, not sent." });
    },
  });

  return s;
}

function billingScreens(): Screen[] {
  const s: Screen[] = [];
  const page1 = (n: number, screen: string, state: string, who: Who, address: () => string, extra: Partial<Screen> = {}) =>
    s.push({
      n,
      screen,
      state,
      who,
      ...extra,
      run: async ({ page, shot }) => {
        await go(page, address());
        await shot(state);
      },
    });
  const planSection = (n: number, screen: string, who: Who) =>
    s.push({
      n,
      screen,
      state: "settings-plan",
      who,
      run: async ({ page, step }) => {
        await go(page, "/settings");
        await step("settings-plan", () => scrollToHeading(page, "Plan"), { fullPage: false });
      },
    });

  page1(35, "pricing", "signed-out", "signedOut", () => "/pricing");
  page1(36, "landing-billing", "signed-out", "signedOut", () => "/");
  page1(37, "register-billing", "empty", "signedOut", () => "/register");
  page1(38, "terms-billing", "page", "signedOut", () => "/terms");
  page1(39, "privacy-billing", "page", "signedOut", () => "/privacy");
  page1(40, "trial-new", "dashboard", "trialNew", () => "/");
  page1(40, "trial-new", "settings", "trialNew", () => "/settings");
  planSection(40, "trial-new", "trialNew");
  page1(41, "trial-ending", "dashboard", "trialEnding", () => "/");
  planSection(41, "trial-ending", "trialEnding");
  page1(42, "trial-ended", "dashboard", "trialEnded", () => "/");
  s.push({
    n: 42,
    screen: "trial-ended",
    state: "create-refused",
    who: "trialEnded",
    run: async ({ page, shot }) => {
      await openComposer(page);
      await caption(page, "Lessons at 8 and 10 on Saturday.");
      await chooseMode(page, "Save draft");
      await submitAndWait(page);
      await shot("create-refused");
    },
  });
  planSection(42, "trial-ended", "trialEnded");
  page1(43, "unconfirmed-email", "dashboard", "unconfirmed", () => "/");
  return s;
}

// ---------------------------------------------------------------- the run

async function runScreen(browser: Browser, camera: Camera, screen: Screen, viewport: ViewportName): Promise<void> {
  const colorScheme = screen.dark ? "dark" : "light";
  let current = screen.state;
  let context: BrowserContext | null = null;
  let page: Page | null = null;
  let ctx: SnapContext | null = null;
  try {
    context = await newAuditContext(browser, {
      viewport,
      colorScheme,
      baseURL: BASE_URL,
      ...(screen.who === "signedOut" ? {} : { storageState: need(world.sessions[screen.who], `a session for ${screen.who}`) }),
      ...(screen.workspaceId ? { activeWorkspaceId: screen.workspaceId() } : {}),
    });
    page = await context.newPage();
    page.setDefaultTimeout(20_000);
    const c: SnapContext = {
      camera,
      watch: new PageWatch(page),
      viewport,
      colorScheme,
      signedInAs: screen.who === "signedOut" ? null : screen.who,
      number: String(screen.n).padStart(2, "0"),
      screen: screen.screen,
    };
    ctx = c;
    const p = page;
    const tools: Tools = {
      page: p,
      shot: async (state, options) => {
        current = state;
        await snap(p, c, state, options);
      },
      step: async (state, fn, options) => {
        current = state;
        try {
          await fn();
          await snap(p, c, state, options);
        } catch (error) {
          await recordFailure(p, c, state, error);
        }
      },
    };
    await screen.run(tools);
  } catch (error) {
    if (ctx) {
      await recordFailure(page, ctx, current, error);
    } else {
      // The context itself could not be made (for example a missing session).
      camera.record({
        file: null,
        number: String(screen.n).padStart(2, "0"),
        screen: screen.screen,
        state: current,
        viewport,
        colorScheme,
        signedInAs: screen.who === "signedOut" ? null : screen.who,
        url: null,
        widerThanViewport: null,
        scrollWidth: null,
        innerWidth: null,
        pageHeight: null,
        consoleErrors: [],
        pageErrors: [],
        failedRequests: [],
        error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      });
    }
  } finally {
    await context?.close().catch(() => undefined);
  }
}

async function setupMain(browser: Browser): Promise<void> {
  world.photos = await makePhotos(browser, 10);
  world.video = await makeVideo(browser);
  const logo = await makeLogo(browser);
  const photoUrls: string[] = [];
  for (let i = 0; i < 6; i++) photoUrls.push(await putIntoStore(`seed/photo-${i + 1}.jpg`, world.photos[i]));
  const videoUrl = world.video ? await putIntoStore(`seed/${world.video.name}`, world.video) : null;
  const logoUrl = await putIntoStore("logos/audit/0123456789abcdef.png", logo);

  const prisma = auditPrisma();
  try {
    world.main = await seedMain(prisma, {
      photos: photoUrls,
      video: videoUrl && world.video ? { url: videoUrl, mimeType: world.video.mimeType } : null,
      logo: logoUrl,
    });
  } finally {
    await prisma.$disconnect();
  }

  await signIn(browser, "owner", MAIN_EMAILS.owner);
  await signIn(browser, "member", MAIN_EMAILS.member);
  await signIn(browser, "visitor", MAIN_EMAILS.visitor);

  // The client links, made through the owner's own routes so the real addresses are known.
  const mainId = world.main.mainId;
  const ownerContext = await newAuditContext(browser, {
    viewport: "desktop",
    colorScheme: "light",
    baseURL: BASE_URL,
    storageState: need(world.sessions.owner, "the owner's session"),
    activeWorkspaceId: mainId,
  });
  try {
    const api = ownerContext.request;
    const post = async (route: string, data?: unknown): Promise<string> => {
      const response = await api.post(`${BASE_URL}${route}`, data === undefined ? {} : { data });
      const body = (await response.json().catch(() => null)) as { link?: { url?: string | null }; url?: string } | null;
      const url = body?.link?.url ?? body?.url;
      if (!response.ok() || !url) throw new Error(`POST ${route} answered ${response.status()}: ${JSON.stringify(body)}`);
      return url;
    };
    // The first of each is replaced by the second, which revokes it: the "not active" pictures.
    world.links.uploadRevoked = tokenOf(await post("/api/workspaces/upload-link", { workspaceId: mainId }));
    world.links.upload = tokenOf(await post("/api/workspaces/upload-link", { workspaceId: mainId }));
    world.links.reviewRevoked = tokenOf(await post("/api/workspaces/review-link", { workspaceId: mainId }));
    world.links.review = tokenOf(await post("/api/workspaces/review-link", { workspaceId: mainId }));
    world.links.connectRevoked = tokenOf(await post("/api/workspaces/connect-link", { workspaceId: mainId, platforms: ALL_PLATFORMS }));
    world.links.connect = tokenOf(await post("/api/workspaces/connect-link", { workspaceId: mainId, platforms: ALL_PLATFORMS }));
    world.links.invite = tokenOf(await post("/api/workspaces/invites"));
  } finally {
    await ownerContext.close();
  }
  const emptyContext = await newAuditContext(browser, {
    viewport: "desktop",
    colorScheme: "light",
    baseURL: BASE_URL,
    storageState: need(world.sessions.owner, "the owner's session"),
    activeWorkspaceId: world.main.emptyId,
  });
  try {
    const response = await emptyContext.request.post(`${BASE_URL}/api/workspaces/connect-link`, {
      data: { workspaceId: world.main.emptyId, platforms: ALL_PLATFORMS },
    });
    const body = (await response.json().catch(() => null)) as { link?: { url?: string | null } } | null;
    if (response.ok() && body?.link?.url) world.links.connectEmpty = tokenOf(body.link.url);
  } finally {
    await emptyContext.close();
  }
}

async function setupBilling(browser: Browser): Promise<void> {
  const prisma = auditPrisma();
  try {
    world.billing = await seedBilling(prisma);
  } finally {
    await prisma.$disconnect();
  }
  for (const who of Object.keys(BILLING_EMAILS) as (keyof typeof BILLING_EMAILS)[]) {
    await signIn(browser, who, BILLING_EMAILS[who]);
  }
}

test.describe("UI audit", () => {
  test.skip(!ENABLED, "Runs only from the ui-audit workflow (UI_AUDIT=1).");
  test.describe.configure({ retries: 0 });

  test(`screens, ${PASS} pass`, async ({ browser }) => {
    test.setTimeout(80 * 60 * 1000);
    // Refuses anything but a local database before a single row is written.
    auditDatabaseUrl();
    const camera = new Camera(OUT_DIR, PASS);

    if (PASS === "main") await setupMain(browser);
    else await setupBilling(browser);

    const screens = PASS === "main" ? mainScreens() : billingScreens();
    for (const screen of screens) {
      for (const viewport of screen.only ?? (["phone", "desktop"] as const)) {
        await runScreen(browser, camera, screen, viewport);
      }
    }

    const failed = camera.entries.filter((e) => e.error).length;
    console.log(`[ui-audit] ${PASS}: ${camera.entries.length - failed} pictures, ${failed} failed states`);
  });
});
