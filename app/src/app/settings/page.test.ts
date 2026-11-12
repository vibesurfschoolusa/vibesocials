import { type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { getWorkspaceContextMock, planSectionMock } = vi.hoisted(() => ({
  getWorkspaceContextMock: vi.fn(),
  planSectionMock: vi.fn<(props: { workspaceNote?: boolean }) => null>(() => null),
}));

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT ${url}`);
  },
}));
vi.mock("@/lib/workspace", () => ({
  getWorkspaceContext: getWorkspaceContextMock,
  getWorkspaceMemberCount: async () => 1,
}));
vi.mock("@/lib/db", () => ({
  prisma: {
    socialConnection: { findMany: async () => [] },
    workspace: { findUnique: async () => null },
    postJob: { count: async () => 0 },
  },
}));
vi.mock("@/server/account/accountDeletion", () => ({ accountDeletionPreview: async () => null }));
vi.mock("@/server/account/deleteWorkspace", () => ({ workspaceDeletionRefusal: async () => null }));
vi.mock("@/server/usage/workspaceUsage", () => ({ getWorkspaceUsageOrNull: async () => null }));
vi.mock("@/server/billing/planPrices", () => ({ getPlanOffers: async () => [] }));
// The plan section shows for an owner with a plan; never for a member.
vi.mock("@/components/planSectionView", () => ({
  PLAN_PORTAL_ONLY_LABEL: "Plan",
  planReturnNotice: () => null,
  planSectionActions: () => null,
  planSectionLabel: (role: string) => (role === "owner" ? "Studio plan" : null),
}));
// The sections' own contents are tested beside them; here only the page's frame.
vi.mock("@/components/settings-form", () => ({ SettingsForm: () => null }));
vi.mock("@/components/posting-slots-form", () => ({ PostingSlotsForm: () => null }));
vi.mock("@/components/connections-section", () => ({ ConnectionsSection: () => null }));
vi.mock("@/components/connect-link-section", () => ({ ConnectLinkSection: () => null }));
vi.mock("@/components/team-section", () => ({ TeamSection: () => null }));
vi.mock("@/components/account-section", () => ({ AccountSection: () => null }));
vi.mock("@/components/usage-section", () => ({ UsageSection: () => null }));
vi.mock("@/components/workspace-logo-control", () => ({ WorkspaceLogoControl: () => null }));
vi.mock("@/components/plan-section", () => ({ PlanSection: planSectionMock }));

import SettingsPage from "./page";

function context(role: "owner" | "member") {
  return {
    user: {
      id: "user-1",
      email: "owner@example.test",
      passwordHash: null,
      notifyOnPostComplete: true,
      notifyDailyDigest: true,
      notifyNewReviews: true,
      notifyMonthlyReport: true,
    },
    workspace: {
      id: "ws-1",
      name: "Surf Co",
      companyWebsite: null,
      defaultHashtags: null,
      requireApproval: false,
      googleButtonType: null,
      googleButtonUrl: null,
      brandVoice: null,
      brandVoiceExamples: null,
      trackWebsiteLinks: false,
    },
    role,
  };
}

async function render(role: "owner" | "member"): Promise<string> {
  getWorkspaceContextMock.mockResolvedValue(context(role));
  return renderToStaticMarkup((await SettingsPage({ searchParams: Promise.resolve({}) })) as ReactElement);
}

/** The jump links under the title: [target id, link text]. */
function jumpLinks(html: string): Array<[string, string]> {
  const nav = /<nav aria-label="Settings sections">([\s\S]*?)<\/nav>/.exec(html)?.[1] ?? "";
  return [...nav.matchAll(/<a href="#([^"]+)"[^>]*>([^<]+)<\/a>/g)].map((m) => [m[1], m[2]]);
}

/** Every h2 heading: [id, text]. */
function headings(html: string): Array<[string | null, string]> {
  return [...html.matchAll(/<h2([^>]*)>([^<]+)<\/h2>/g)].map((m) => [/id="([^"]+)"/.exec(m[1])?.[1] ?? null, m[2]]);
}

beforeEach(() => {
  getWorkspaceContextMock.mockReset();
});

// Go-live check 2026-11-11: Settings is 5,600 pixels long with no way to jump,
// and its words describe only the footer and the connections.
describe("SettingsPage — words and jump links", () => {
  it("says in one sentence what the page holds", async () => {
    const html = await render("owner");
    expect(html).not.toContain("Configure your default caption footer and manage social platform connections.");
    expect(html).toContain(
      "Your post defaults and emails, posting times, connections, team, usage and your account.",
    );
  });

  it("names the first section for all it holds, not only captions", async () => {
    const html = await render("owner");
    expect(headings(html)[0][1]).toBe("Posts and emails");
    expect(html).not.toMatch(/<h2[^>]*>Captions<\/h2>/);
  });

  it.each(["owner", "member"] as const)("for an %s: one link per section seen, each to its heading", async (role) => {
    const html = await render(role);
    const shown = headings(html);
    const links = jumpLinks(html);
    // Every section heading has an id and a link with its name, in page order.
    expect(links).toEqual(shown.map(([id, text]) => [id, text]));
    for (const [id] of links) {
      expect(html).toMatch(new RegExp(`<h2 id="${id}" class="[^"]*scroll-mt-20`));
    }
  });

  it("shows the Plan link to an owner with a plan and not to a member", async () => {
    expect(jumpLinks(await render("owner")).map(([, text]) => text)).toEqual([
      "Posts and emails",
      "Posting times",
      "Connections",
      "Team",
      "Plan",
      "Usage",
      "Account",
    ]);
    expect(jumpLinks(await render("member")).map(([, text]) => text)).not.toContain("Plan");
  });

  it("keeps the anchors other pages link to", async () => {
    const html = await render("owner");
    for (const id of ["posting-times", "connections", "plan", "usage", "account"]) {
      expect(html).toContain(`id="${id}"`);
    }
  });

  // S2 fix round 2: the dashboard's "Send a connect link" goes to
  // /settings#connect-link. The card renders only after its own fetch, so the
  // anchor sits on the wrapper this page renders on the server.
  it("renders the connect-link anchor once, on the server, for an owner", async () => {
    const html = await render("owner");
    expect(html.match(/id="connect-link"/g)).toHaveLength(1);
    expect(html).toContain('<div id="connect-link" class="mt-4 scroll-mt-20">');
  });

  it("lets the links wrap on a narrow screen", async () => {
    const html = await render("member");
    expect(html).toMatch(/<nav aria-label="Settings sections"[^>]*>\s*<ul class="[^"]*flex-wrap/);
  });
});

// S1 fix round 1: Settings, Plan says "a plan covers one workspace" only where
// the workspace is on a trial or plan, never for an exempt one.
describe("SettingsPage — the one-workspace sentence", () => {
  async function noteFor(billing: Record<string, unknown>): Promise<boolean | undefined> {
    vi.stubEnv("BILLING_ENABLED", "true");
    planSectionMock.mockClear();
    const base = context("owner");
    getWorkspaceContextMock.mockResolvedValue({ ...base, workspace: { ...base.workspace, ...billing } });
    renderToStaticMarkup((await SettingsPage({ searchParams: Promise.resolve({}) })) as ReactElement);
    vi.unstubAllEnvs();
    return planSectionMock.mock.calls[0]?.[0].workspaceNote;
  }

  it("asks for it in a trial, and not in an exempt workspace", async () => {
    expect(await noteFor({ billingExempt: false, trialEndsAt: new Date(Date.now() + 86_400_000) })).toBe(true);
    expect(await noteFor({ billingExempt: true })).toBe(false);
    expect(await noteFor({})).toBe(false);
  });
});
