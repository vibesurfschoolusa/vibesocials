import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { workspaceBrandVoicePrompt, brandVoicePrompt } from "./brandVoice";
import { settingsPlanNotes } from "@/app/settings/planNotes";
import { workspaceSetupFrom } from "./gettingStarted";
import { PLAN_FEATURES, pausedByPlan, planIncludes } from "./planFeatures";
import { planFeatureResponse } from "./planFeatureResponse";

/**
 * P1: every gated place, and the one rule they share.
 *
 * 1. The table: with billing off, and for an exempt workspace (by its flag or
 *    created with billing off), every place behaves as before plans differed.
 *    The pure decision of each place is run here; each place's own test file
 *    covers the same cases through its route, page or job.
 * 2. The guard: each place calls the rule, and no other source file names the
 *    plans that include the features.
 */

const NOW = new Date("2026-12-10T12:00:00Z");
// workspaceSetupFrom reads the clock itself; pinned so the fixed dates below never expire.
beforeAll(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterAll(() => vi.useRealTimers());
const LATER = new Date("2026-12-30T00:00:00Z");
const STARTER_COLUMNS = { plan: "starter", planStatus: "active", currentPeriodEnd: LATER };

// The cases that must behave as today: [label, workspace, env].
const AS_TODAY = [
  ["billing off, a Starter-shaped row", STARTER_COLUMNS, {}],
  ["billing off, a row read without billing columns", {}, {}],
  ["billing on, exempt by its flag", { ...STARTER_COLUMNS, billingExempt: true }, { BILLING_ENABLED: "true" }],
  ["billing on, exempt for predating billing", {}, { BILLING_ENABLED: "true" }],
] as const;

const VOICE = { brandVoice: "Sunny.", brandVoiceExamples: "Waves today" };
const SETUP_FIELDS = { companyWebsite: null, defaultHashtags: null, ...VOICE };

/** Each place's own decision, true when it behaves as before plans differed. */
const PLACES: Record<string, (workspace: Record<string, unknown>, env: Record<string, string>) => boolean> = {
  "client links: public pages and routes (uploadLink, reviewLink, connectLink finders)": (w, env) =>
    planIncludes(w, "clientLinks", env, NOW),
  "client links: owner POST routes": (w, env) => planFeatureResponse(w, "clientLinks", env, NOW) === null,
  "client links: owner GET routes": (w, env) => Object.keys(pausedByPlan(w, "clientLinks", env, NOW)).length === 0,
  "client links: Reports' client sentence": (w, env) => planIncludes(w, "clientLinks", env, NOW),
  "client links: dashboard block": (w, env) => {
    const prior = process.env.BILLING_ENABLED;
    process.env.BILLING_ENABLED = env.BILLING_ENABLED ?? "";
    try {
      return !("clientLinksPaused" in workspaceSetupFrom({ ...SETUP_FIELDS, ...w }, "owner", true));
    } finally {
      if (prior === undefined) delete process.env.BILLING_ENABLED;
      else process.env.BILLING_ENABLED = prior;
    }
  },
  "Get started's brand voice step": (w, env) => {
    const prior = process.env.BILLING_ENABLED;
    process.env.BILLING_ENABLED = env.BILLING_ENABLED ?? "";
    try {
      return !("brandVoicePaused" in workspaceSetupFrom({ ...SETUP_FIELDS, ...w }, "owner", true));
    } finally {
      if (prior === undefined) delete process.env.BILLING_ENABLED;
      else process.env.BILLING_ENABLED = prior;
    }
  },
  "Add many page": (w, env) => planIncludes(w, "bulk", env, NOW),
  "brand voice in the AI prompts": (w, env) =>
    workspaceBrandVoicePrompt({ ...VOICE, ...w }, env, NOW) === brandVoicePrompt(VOICE.brandVoice, VOICE.brandVoiceExamples),
  "Settings lines": (w, env) => Object.keys(settingsPlanNotes(w, env, NOW)).length === 0,
  "logo upload": (w, env) => planFeatureResponse(w, "monthlyReportEmail", env, NOW) === null,
  "logo shown on reports and the email": (w, env) => planIncludes(w, "monthlyReportEmail", env, NOW),
  "monthly report email job": (w, env) => planIncludes(w, "monthlyReportEmail", env, NOW),
  "new-review email job": (w, env) => planIncludes(w, "reviewAlerts", env, NOW),
};

describe("every gated place behaves as today with billing off and for an exempt workspace", () => {
  for (const [place, behavesAsToday] of Object.entries(PLACES)) {
    for (const [label, workspace, env] of AS_TODAY) {
      it(`${place}: ${label}`, () => {
        expect(behavesAsToday(workspace, env)).toBe(true);
      });
    }
    it(`${place}: changes on Starter with billing on (the table is not vacuous)`, () => {
      expect(behavesAsToday(STARTER_COLUMNS, { BILLING_ENABLED: "true" })).toBe(false);
    });
  }
});

const SRC = path.resolve(__dirname, "..");

/** Each gated file and the feature it must name in a call to the rule (or a helper that calls it). */
const GATED_FILES: Array<[string, string]> = [
  ["server/uploadLink.ts", "clientLinks"],
  ["server/reviewLink.ts", "clientLinks"],
  ["server/connectLink/link.ts", "clientLinks"],
  ["app/api/workspaces/upload-link/route.ts", "clientLinks"],
  ["app/api/workspaces/review-link/route.ts", "clientLinks"],
  ["app/api/workspaces/connect-link/route.ts", "clientLinks"],
  ["app/reports/page.tsx", "clientLinks"],
  ["lib/gettingStarted.ts", "clientLinks"],
  ["lib/gettingStarted.ts", "brandVoice"],
  ["app/posts/bulk/page.tsx", "bulk"],
  ["lib/brandVoice.ts", "brandVoice"],
  ["app/settings/planNotes.ts", "brandVoice"],
  ["app/settings/planNotes.ts", "reviewAlerts"],
  ["app/api/workspaces/logo/route.ts", "monthlyReportEmail"],
  ["server/reports/monthlyReport.ts", "monthlyReportEmail"],
  ["server/jobs/monthlyReportEmail.ts", "monthlyReportEmail"],
  ["server/jobs/reviewAlerts.ts", "reviewAlerts"],
];

const BRAND_VOICE_ROUTES = [
  "app/api/posts/auto-caption/route.ts",
  "app/api/posts/enhance-caption/route.ts",
  "app/api/reviews/draft-response/route.ts",
];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [full] : [];
  });
}

describe("one rule decides what a plan includes", () => {
  it.each(GATED_FILES)("%s asks the rule about %s", (file, feature) => {
    const text = readFileSync(path.join(SRC, file), "utf8");
    expect(text).toMatch(
      new RegExp(`(planIncludes|planFeatureResponse|pausedByPlan)\\([^)]*"${feature}"`),
    );
  });

  it.each(BRAND_VOICE_ROUTES)("%s adds the brand voice only through workspaceBrandVoicePrompt", (file) => {
    const text = readFileSync(path.join(SRC, file), "utf8");
    expect(text).toContain("workspaceBrandVoicePrompt(context.workspace)");
    expect(text).not.toMatch(/[^e]brandVoicePrompt\(/);
  });

  // Fix round 2: "starter" too, so no file decides a feature by comparing the plan value itself.
  it("no other source file names a plan as a string: the rule and the plan definitions only", () => {
    const allowed = new Set(["lib/plans.ts", "lib/planFeatures.ts", "lib/billing.ts"].map((f) => path.join(SRC, f)));
    const offenders = sourceFiles(SRC).filter(
      (file) => !allowed.has(file) && /["'](starter|growth|pro)["']/.test(readFileSync(file, "utf8")),
    );
    expect(offenders).toEqual([]);
  });

  it("covers every feature", () => {
    const named = new Set(GATED_FILES.map(([, feature]) => feature));
    for (const feature of PLAN_FEATURES) expect(named.has(feature)).toBe(true);
  });
});
