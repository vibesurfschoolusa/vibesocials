import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { Browser, BrowserContext, Page } from "@playwright/test";

/**
 * UI audit: contexts at the two sizes, the "wait until quiet" rule, the
 * pictures and report.json. One entry per picture; a screen that throws gets
 * an entry with its error and the rest carry on.
 */

export type ViewportName = "phone" | "desktop";

export const VIEWPORTS: Record<ViewportName, Parameters<Browser["newContext"]>[0]> = {
  phone: {
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 1,
    isMobile: true,
    hasTouch: true,
    // A current Android Chrome, so the app sees a phone.
    userAgent:
      "Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36",
  },
  desktop: {
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 1,
    isMobile: false,
    hasTouch: false,
  },
};

/**
 * Requests the browser must not make: each would have the server call a live
 * platform with the dummy credentials. They are cut off in the browser and
 * listed in the report as blocked by the audit, so a picture that shows the
 * resulting error state says why.
 */
const BLOCKED_PATHS: RegExp[] = [
  /^\/api\/tiktok\/creator-info/,
  /^\/api\/reviews(\/|$|\?)/,
  /^\/api\/connections\/google_business_profile\/locations/,
  /^\/api\/auth\/[a-z_]+\/start/,
  /^\/api\/connect-link\/[^/]+\/start/,
  /^\/api\/billing\//,
  /^\/api\/posts\/[^/]+\/(publish|retry)/,
];
/** /api/reviews/link answers from the saved link (seeded), with no Google call. */
const ALLOWED_PATHS: RegExp[] = [/^\/api\/reviews\/link$/];

export interface FailedRequest {
  method: string;
  url: string;
  status: number | null;
  failure?: string;
  blockedByAudit?: boolean;
}

export interface ReportEntry {
  file: string | null;
  number: string;
  screen: string;
  state: string;
  viewport: ViewportName;
  colorScheme: "light" | "dark";
  signedInAs: string | null;
  url: string | null;
  widerThanViewport: boolean | null;
  scrollWidth: number | null;
  innerWidth: number | null;
  pageHeight: number | null;
  topFile?: string;
  consoleErrors: string[];
  pageErrors: string[];
  failedRequests: FailedRequest[];
  note?: string;
  error?: string;
  errorPicture?: string;
}

export class Camera {
  readonly entries: ReportEntry[] = [];
  private readonly reportPath: string;

  constructor(readonly outDir: string, readonly pass: string) {
    mkdirSync(outDir, { recursive: true });
    mkdirSync(path.join(outDir, "errors"), { recursive: true });
    this.reportPath = path.join(outDir, "report.json");
    this.flush();
  }

  flush(): void {
    writeFileSync(
      this.reportPath,
      `${JSON.stringify({ pass: this.pass, generatedAt: new Date().toISOString(), pictures: this.entries }, null, 2)}\n`,
    );
  }

  record(entry: ReportEntry): void {
    this.entries.push(entry);
    this.flush();
  }
}

/** Collects console errors, uncaught exceptions and failed requests for one page. */
export class PageWatch {
  consoleErrors: string[] = [];
  pageErrors: string[] = [];
  failedRequests: FailedRequest[] = [];

  constructor(page: Page) {
    page.on("console", (message) => {
      if (message.type() === "error") this.consoleErrors.push(message.text());
    });
    page.on("pageerror", (error) => {
      this.pageErrors.push(`${error.name}: ${error.message}`);
    });
    page.on("response", (response) => {
      if (response.status() >= 400) {
        this.failedRequests.push({ method: response.request().method(), url: response.url(), status: response.status() });
      }
    });
    page.on("requestfailed", (request) => {
      const failure = request.failure()?.errorText ?? "failed";
      this.failedRequests.push({
        method: request.method(),
        url: request.url(),
        status: null,
        failure,
        ...(failure.includes("ERR_BLOCKED_BY_CLIENT") ? { blockedByAudit: true } : {}),
      });
    });
  }

  take(): Pick<ReportEntry, "consoleErrors" | "pageErrors" | "failedRequests"> {
    const out = { consoleErrors: this.consoleErrors, pageErrors: this.pageErrors, failedRequests: this.failedRequests };
    this.consoleErrors = [];
    this.pageErrors = [];
    this.failedRequests = [];
    return out;
  }
}

export interface ContextOptions {
  viewport: ViewportName;
  colorScheme: "light" | "dark";
  storageState?: string;
  activeWorkspaceId?: string;
  baseURL: string;
}

export async function newAuditContext(browser: Browser, options: ContextOptions): Promise<BrowserContext> {
  const context = await browser.newContext({
    ...VIEWPORTS[options.viewport],
    baseURL: options.baseURL,
    colorScheme: options.colorScheme,
    locale: "en-US",
    timezoneId: "America/New_York",
    serviceWorkers: "block",
    ...(options.storageState ? { storageState: options.storageState } : {}),
  });
  if (options.activeWorkspaceId) {
    const host = new URL(options.baseURL).hostname;
    // The cookie the workspace switcher sets (src/app/api/workspaces/switch/route.ts).
    await context.addCookies([
      { name: "vs_active_workspace", value: options.activeWorkspaceId, domain: host, path: "/", httpOnly: true, sameSite: "Lax" },
    ]);
  }
  const appOrigin = new URL(options.baseURL).origin;
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin === appOrigin) {
      const pathAndQuery = `${url.pathname}${url.search}`;
      if (!ALLOWED_PATHS.some((re) => re.test(url.pathname)) && BLOCKED_PATHS.some((re) => re.test(pathAndQuery))) {
        await route.abort("blockedbyclient");
        return;
      }
      await route.continue();
      return;
    }
    // Client upload link files carry the real store's address; serve them from the double.
    if (url.hostname.endsWith(".public.blob.vercel-storage.com")) {
      const store = process.env.VERCEL_BLOB_API_URL ?? "http://localhost:9366";
      const response = await route.fetch({ url: `${store}${url.pathname}` });
      await route.fulfill({ response });
      return;
    }
    if (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.protocol === "data:" || url.protocol === "blob:") {
      await route.continue();
      return;
    }
    // Anything else would leave the runner (fonts are bundled at build time).
    await route.abort("blockedbyclient");
  });
  return context;
}

/** No pending requests (best effort), fonts loaded, a moment for layout. */
export async function waitQuiet(page: Page, timeout = 15_000): Promise<void> {
  await page.waitForLoadState("load", { timeout }).catch(() => undefined);
  await page.waitForLoadState("networkidle", { timeout }).catch(() => undefined);
  await page.evaluate(() => document.fonts.ready.then(() => true)).catch(() => undefined);
  await page.waitForTimeout(300);
}

const FREEZE_CSS = `
*, *::before, *::after {
  animation-duration: 0s !important;
  animation-delay: 0s !important;
  transition-duration: 0s !important;
  transition-delay: 0s !important;
  caret-color: transparent !important;
}
`;

export interface SnapContext {
  camera: Camera;
  watch: PageWatch;
  viewport: ViewportName;
  colorScheme: "light" | "dark";
  signedInAs: string | null;
  number: string;
  screen: string;
}

function fileBase(ctx: SnapContext, state: string): string {
  const scheme = ctx.colorScheme === "dark" ? "-dark" : "";
  return `${ctx.number}-${ctx.screen}-${state}${scheme}.${ctx.viewport}`;
}

/**
 * One picture. `fullPage: false` takes what is on screen (used for a section
 * scrolled to its heading, a dialog, or a menu). `element` takes one element.
 */
export async function snap(
  page: Page,
  ctx: SnapContext,
  state: string,
  options: { fullPage?: boolean; element?: ReturnType<Page["locator"]>; note?: string; quietTimeout?: number } = {},
): Promise<void> {
  await waitQuiet(page, options.quietTimeout);
  await page.addStyleTag({ content: FREEZE_CSS }).catch(() => undefined);
  const metrics = await page
    .evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
      height: document.documentElement.scrollHeight,
    }))
    .catch(() => null);
  const base = fileBase(ctx, state);
  const file = `${base}.jpg`;
  const target = path.join(ctx.camera.outDir, file);
  const fullPage = options.fullPage ?? true;
  if (options.element) {
    await options.element.screenshot({ path: target, type: "jpeg", quality: 70, animations: "disabled" });
  } else {
    await page.screenshot({ path: target, type: "jpeg", quality: 70, fullPage, animations: "disabled", caret: "hide" });
  }
  let topFile: string | undefined;
  if (!options.element && fullPage && ctx.viewport === "phone" && metrics && metrics.height > 6000) {
    topFile = `${base}.top.jpg`;
    await page.screenshot({
      path: path.join(ctx.camera.outDir, topFile),
      type: "jpeg",
      quality: 70,
      fullPage: false,
      animations: "disabled",
      caret: "hide",
    });
  }
  ctx.camera.record({
    file,
    number: ctx.number,
    screen: ctx.screen,
    state,
    viewport: ctx.viewport,
    colorScheme: ctx.colorScheme,
    signedInAs: ctx.signedInAs,
    url: page.url(),
    widerThanViewport: metrics ? metrics.scrollWidth > metrics.innerWidth : null,
    scrollWidth: metrics?.scrollWidth ?? null,
    innerWidth: metrics?.innerWidth ?? null,
    pageHeight: metrics?.height ?? null,
    ...(topFile ? { topFile } : {}),
    ...ctx.watch.take(),
    ...(options.note ? { note: options.note } : {}),
  });
}

/** Records a screen that threw, with a picture of wherever the page was. */
export async function recordFailure(page: Page | null, ctx: SnapContext, state: string, error: unknown): Promise<void> {
  let errorPicture: string | undefined;
  if (page && !page.isClosed()) {
    errorPicture = `errors/${fileBase(ctx, state)}.jpg`;
    await page
      .screenshot({ path: path.join(ctx.camera.outDir, errorPicture), type: "jpeg", quality: 60, fullPage: false, timeout: 10_000 })
      .catch(() => {
        errorPicture = undefined;
      });
  }
  ctx.camera.record({
    file: null,
    number: ctx.number,
    screen: ctx.screen,
    state,
    viewport: ctx.viewport,
    colorScheme: ctx.colorScheme,
    signedInAs: ctx.signedInAs,
    url: page && !page.isClosed() ? page.url() : null,
    widerThanViewport: null,
    scrollWidth: null,
    innerWidth: null,
    pageHeight: null,
    ...ctx.watch.take(),
    error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    ...(errorPicture ? { errorPicture } : {}),
  });
}
