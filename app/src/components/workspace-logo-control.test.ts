import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));

import { settingsPlanNotes } from "@/app/settings/planNotes";
import { LOGO_HELP_LINE } from "@/lib/workspaceLogo";

import { WorkspaceLogoControl } from "./workspace-logo-control";

const LOGO = "https://abc.public.blob.vercel-storage.com/logos/ws-1/0123456789abcdef.png";

const render = (logoUrl: string | null, isOwner: boolean) =>
  renderToStaticMarkup(createElement(WorkspaceLogoControl, { logoUrl, isOwner, workspaceId: "ws-1" }));

describe("WorkspaceLogoControl", () => {
  it("shows an owner the logo, Upload, Remove and the one line", () => {
    const html = render(LOGO, true);
    expect(html).toContain(">Logo<");
    expect(html).toContain(`src="${LOGO}"`);
    expect(html).toContain(">Upload<");
    expect(html).toContain(">Remove<");
    expect(html).toContain(LOGO_HELP_LINE);
    expect(html).toContain('accept="image/png,image/jpeg"');
  });

  it("offers an owner with no logo only Upload", () => {
    const html = render(null, true);
    expect(html).toContain(">Upload<");
    expect(html).not.toContain(">Remove<");
    expect(html).not.toContain("<img");
    expect(html).toContain("No logo yet.");
  });

  it("shows a member the logo and no buttons", () => {
    const html = render(LOGO, false);
    expect(html).toContain(`src="${LOGO}"`);
    expect(html).not.toContain(">Upload<");
    expect(html).not.toContain(">Remove<");
    expect(html).not.toContain('type="file"');
  });
});

// P1 fix round 2: on Starter the logo does not show on the report, so the help line says when it does.
describe("WorkspaceLogoControl and the plan", () => {
  const PLAN_LINE = "Your logo shows on the monthly report on the Growth and Pro plans.";

  it("with a plan note: the size rule, then the plan line, and not 'It appears on your monthly report'", () => {
    const html = renderToStaticMarkup(
      createElement(WorkspaceLogoControl, { logoUrl: LOGO, isOwner: true, workspaceId: "ws-1", planNote: PLAN_LINE }),
    );
    expect(html).toContain("An image up to 1 MB (not SVG).");
    expect(html).toContain(PLAN_LINE);
    expect(html).not.toContain("It appears on your monthly report.");
  });

  it("without one: today's line exactly", () => {
    const html = render(LOGO, true);
    expect(html).toContain(LOGO_HELP_LINE);
    expect(html).not.toContain(PLAN_LINE);
  });
});

// Q1: where the plan refuses the upload, Upload is disabled before a file is picked.
describe("WorkspaceLogoControl: Upload by plan", () => {
  const ON = { BILLING_ENABLED: "true" };
  const NOW = new Date("2026-12-10T12:00:00Z");
  const LATER = new Date("2026-12-30T00:00:00Z");
  const STARTER = { plan: "starter", planStatus: "active", currentPeriodEnd: LATER };
  // The page passes settingsPlanNotes(workspace).logo, which asks planIncludes(monthlyReportEmail).
  const html = (workspace: Record<string, unknown>, env: Record<string, string>, logoUrl: string | null = LOGO) =>
    renderToStaticMarkup(
      createElement(WorkspaceLogoControl, {
        logoUrl,
        isOwner: true,
        workspaceId: "ws-1",
        planNote: settingsPlanNotes(workspace, env, NOW).logo,
      }),
    );
  const upload = (markup: string) => markup.match(/<button[^>]*>Upload<\/button>/)?.[0] ?? "";

  it("disabled on Starter and ended, with aria-disabled and the help line kept", () => {
    for (const workspace of [STARTER, { ...STARTER, planStatus: "canceled", currentPeriodEnd: NOW }, { trialEndsAt: new Date("2026-12-01T00:00:00Z") }]) {
      const markup = html(workspace, ON);
      expect(upload(markup)).toContain('disabled=""');
      expect(upload(markup)).toContain('aria-disabled="true"');
      expect(markup).toContain("An image up to 1 MB (not SVG). Your logo shows on the monthly report on the Growth and Pro plans.");
      expect(markup).toMatch(/<input[^>]*type="file"[^>]*disabled=""/);
    }
  });

  it("Remove stays offered on Starter with a saved logo", () => {
    const remove = html(STARTER, ON).match(/<button[^>]*>Remove<\/button>/)?.[0] ?? "";
    expect(remove).not.toBe("");
    expect(remove).not.toContain('disabled=""');
    expect(remove).not.toContain("aria-disabled");
  });

  it("enabled exactly as today with billing off, exempt, in a trial, on Growth and on Pro", () => {
    const today = render(LOGO, true);
    for (const [workspace, env] of [
      [STARTER, {}],
      [{ ...STARTER, billingExempt: true }, ON],
      [{ trialEndsAt: LATER }, ON],
      [{ ...STARTER, plan: "growth" }, ON],
      [{ ...STARTER, plan: "pro" }, ON],
    ] as const) {
      expect(html(workspace, env)).toBe(today);
    }
  });
});
