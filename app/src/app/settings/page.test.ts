import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  getWorkspaceContextMock,
  planSectionMock,
  billing,
  planActionsMock,
  sectionProps,
  isPayerMock,
  findConnectionsMock,
  noPlanYetMock,
  personalNoteMock,
  findOwnersMock,
  usageMock,
  membershipCountMock,
} = vi.hoisted(() => ({
  membershipCountMock: vi.fn<(args?: unknown) => Promise<number>>(async () => 2),
  usageMock: vi.fn<(...args: unknown[]) => Promise<null>>(async () => null),
  getWorkspaceContextMock: vi.fn(),
  noPlanYetMock: vi.fn<(...args: unknown[]) => boolean>(() => false),
  personalNoteMock: vi.fn<(...args: unknown[]) => { limit: number; reduced: string | null } | null>(() => null),
  findOwnersMock: vi.fn<(args?: unknown) => Promise<unknown[]>>(async () => []),
  findConnectionsMock: vi.fn<(args?: unknown) => Promise<unknown[]>>(async () => []),
  isPayerMock: vi.fn(async () => false),
  // What the Plan section offers (planSectionActions); null: no plan action.
  planActionsMock: vi.fn<(role: string) => { choose: string[]; manage: boolean } | null>(() => null),
  // The props each section that writes was given, by section name.
  sectionProps: {} as Record<string, Record<string, unknown>>,
  // Stands in for billing on/off: with it off, planSectionLabel shows no plan.
  billing: { on: true },
  planSectionMock: vi.fn<
    (props: { workspaceNote?: boolean; workspaceId?: string; noPlanYet?: boolean; personalPostNote?: unknown }) => null
  >(() => null),
}));

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT ${url}`);
  },
  // For the real connection row one test renders.
  useRouter: () => ({ push: () => {}, refresh: () => {} }),
}));
vi.mock("@/components/ui/toast", () => ({ useToast: () => ({ success: () => {}, error: () => {} }) }));
vi.mock("@/lib/workspace", () => ({
  getWorkspaceContext: getWorkspaceContextMock,
  getWorkspaceMemberCount: async () => 1,
}));
vi.mock("@/lib/db", () => ({
  prisma: {
    socialConnection: { findMany: findConnectionsMock },
    workspace: { findUnique: async () => null },
    workspaceMember: { findMany: findOwnersMock, count: membershipCountMock },
    postJob: { count: async () => 0 },
  },
}));
vi.mock("@/server/account/accountDeletion", () => ({ accountDeletionPreview: async () => null }));
vi.mock("@/server/account/deleteWorkspace", () => ({
  workspaceDeletionRefusal: async () => null,
  isOnlyWorkspace: (memberships: number) => memberships <= 1,
}));
vi.mock("@/server/usage/workspaceUsage", () => ({ getWorkspaceUsageOrNull: usageMock }));
vi.mock("@/server/billing/planPrices", () => ({ getPlanOffers: async () => [], getYearlyPlanOffers: async () => [] }));
// The plan section shows for an owner with a plan and billing on; never for a member.
vi.mock("@/components/planSectionView", () => ({
  PLAN_PORTAL_ONLY_LABEL: "Plan",
  planGrowthAddsShown: () => false,
  planReturnNotice: () => null,
  planSectionActions: (role: string) => planActionsMock(role),
  planNoPlanYet: (...args: unknown[]) => noPlanYetMock(...args),
  planPersonalPostNote: (...args: unknown[]) => personalNoteMock(...args),
  // R13-new-customer L1: the viewer's zone, when the page passes one, shows in the label.
  planSectionLabel: (role: string, _workspace: unknown, _now: unknown, _env: unknown, timeZone?: string | null) =>
    role === "owner" && billing.on ? (timeZone ? `Studio plan in ${timeZone}` : "Studio plan") : null,
}));
// The sections' own contents are tested beside them; here only the page's frame.
vi.mock("@/components/settings-form", () => ({
  SettingsForm: (props: Record<string, unknown>) => {
    sectionProps.SettingsForm = props;
    return null;
  },
}));
vi.mock("@/components/posting-slots-form", () => ({
  PostingSlotsForm: (props: Record<string, unknown>) => {
    sectionProps.PostingSlotsForm = props;
    return null;
  },
}));
vi.mock("@/components/connections-section", () => ({
  ConnectionsSection: (props: Record<string, unknown>) => {
    sectionProps.ConnectionsSection = props;
    return null;
  },
}));
vi.mock("@/components/connect-link-section", () => ({ ConnectLinkSection: () => null }));
vi.mock("@/components/team-section", () => ({
  TeamSection: (props: Record<string, unknown>) => {
    sectionProps.TeamSection = props;
    return null;
  },
}));
vi.mock("@/components/account-section", () => ({ AccountSection: () => null }));
vi.mock("@/components/usage-section", () => ({
  UsageSection: (props: Record<string, unknown>) => {
    sectionProps.UsageSection = props;
    return null;
  },
}));
vi.mock("@/components/workspace-logo-control", () => ({ WorkspaceLogoControl: () => null }));
vi.mock("@/components/plan-section", () => ({ PlanSection: planSectionMock }));
vi.mock("@/server/billing/payerRefusal", () => ({ isWorkspacePayer: isPayerMock }));
// With the Stripe key set (the payer tests), no paid plan is in the way.
vi.mock("./paidPlans", () => ({
  accountDeletionCancelsPaidPlan: async () => false,
  workspacesHavePaidPlan: async () => false,
}));
vi.mock("@/components/plan-actions", () => ({
  PlanActions: (props: { manageLabel?: string; workspaceId: string }) => `[PlanActions ${props.manageLabel} ${props.workspaceId}]`,
}));

import SettingsPage, { metadata } from "./page";
import { APP_PAGE_CLASS } from "@/lib/pageLayout";

function context(role: "owner" | "member") {
  return {
    user: {
      id: "user-1",
      email: "owner@example.test",
      emailVerifiedAt: new Date("2026-11-01T09:00:00Z"),
      createdAt: new Date("2026-11-01T08:00:00Z"),
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
  const nav = /<nav aria-label="Settings sections"[^>]*>([\s\S]*?)<\/nav>/.exec(html)?.[1] ?? "";
  return [...nav.matchAll(/<a href="#([^"]+)"[^>]*>([^<]+)<\/a>/g)].map((m) => [m[1], m[2]]);
}

/** Every h2 heading: [id, text]. */
function headings(html: string): Array<[string | null, string]> {
  return [...html.matchAll(/<h2([^>]*)>([^<]+)<\/h2>/g)].map((m) => [/id="([^"]+)"/.exec(m[1])?.[1] ?? null, m[2]]);
}

beforeEach(() => {
  getWorkspaceContextMock.mockReset();
  billing.on = true;
  planActionsMock.mockReset();
  planActionsMock.mockReturnValue(null);
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

  it("words the Connections intro for the viewer's role", async () => {
    // The real function runs on the server here (lib/ownerStepAnswers.ts), as in production.
    const owner = await render("owner");
    expect(owner).toContain("Connect your social accounts so Vibe Socials can publish on your behalf.");
    expect(owner).not.toContain("The workspace owner connects and reconnects them.");
    const member = await render("member");
    expect(member).toContain("The workspace owner connects and reconnects them.");
    expect(member).not.toContain("Connect your social accounts");
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
      // Below lg the sticky link row sits under the top bar too, so the margin is larger there.
      expect(html).toMatch(new RegExp(`<h2 id="${id}" class="scroll-mt-32 lg:scroll-mt-20 [^"]*"`));
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

  it.each([
    ["owner", true, true],
    ["owner", false, false],
    ["member", true, false],
    ["member", false, false],
  ] as const)("for an %s with billing on %s: Plan link %s, matching the sections shown", async (role, on, planLink) => {
    billing.on = on;
    const html = await render(role);
    const links = jumpLinks(html);
    expect(links.map(([id]) => id).includes("plan")).toBe(planLink);
    expect(links).toEqual(headings(html));
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
    expect(html).toContain('<div id="connect-link" class="mt-4 scroll-mt-32 lg:scroll-mt-20">');
  });

  it("puts the links in one row that scrolls sideways on a narrow screen", async () => {
    const html = await render("member");
    expect(html).toMatch(/<nav aria-label="Settings sections"[^>]*>\s*<ul class="[^"]*overflow-x-auto/);
  });

  it("marks the first section as current before the page scrolls", async () => {
    const html = await render("owner");
    expect(html).toMatch(/<a href="#post-defaults"[^>]*aria-current="location"/);
    expect(html.match(/aria-current="location"/g)).toHaveLength(1);
  });

  it("uses the shared page width", async () => {
    const html = await render("owner");
    expect(html).toContain(`<div class="${APP_PAGE_CLASS}">`);
    expect(html).not.toContain("max-w-4xl");
  });

  it("names the browser tab", () => {
    expect(metadata.title).toBe("Settings | Vibe Socials");
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

// F7 (R1 L4): with billing on, a higher limit comes with another plan, not an
// email, but only where the Plan section offers a way to change it.
describe("SettingsPage — Usage words", () => {
  function usageLine(html: string): string {
    const start = html.indexOf('id="usage"');
    return (/<p[^>]*>([\s\S]*?)<\/p>/.exec(html.slice(start))?.[1] ?? "").replace(/<!-- -->/g, "");
  }
  // R9-pages L5: only the workspace's own limits are the operator's to raise.
  const SUPPORT = "What this workspace has used of its limits. For a higher limit on this workspace, write to ";

  beforeEach(() => {
    vi.stubEnv("BILLING_ENABLED", "true");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("a paying owner the Plan section offers a change to: points to Plan", async () => {
    planActionsMock.mockReturnValue({ choose: [], manage: true });
    const line = usageLine(await render("owner"));
    expect(line).toContain('For a higher limit, change the plan under <a href="#plan"');
    expect(line).not.toContain("write to");
  });

  it("an owner on a trial the Plan section offers plans to: points to Plan", async () => {
    planActionsMock.mockReturnValue({ choose: ["starter"], manage: false });
    expect(usageLine(await render("owner"))).toContain('change the plan under <a href="#plan"');
  });

  it("an exempt workspace (no plan action): the support sentence", async () => {
    planActionsMock.mockReturnValue(null);
    expect(usageLine(await render("owner"))).toContain(SUPPORT);
  });

  it("a trial with payments not set up (no plan action): the support sentence", async () => {
    planActionsMock.mockReturnValue(null);
    const line = usageLine(await render("owner"));
    expect(line).toContain(SUPPORT);
    expect(line).not.toContain("#plan");
  });

  it("a member where the owner could change the plan: ask the owner", async () => {
    planActionsMock.mockImplementation(() => ({ choose: [], manage: true }));
    const line = usageLine(await render("member"));
    expect(line).toContain("For a higher limit, ask the workspace owner to change the plan.");
    expect(planActionsMock).toHaveBeenCalledWith("owner");
  });

  it("a member where there is no plan to change: the support sentence", async () => {
    planActionsMock.mockReturnValue(null);
    expect(usageLine(await render("member"))).toContain(SUPPORT);
  });

  it("billing off: the support sentence, whatever the Plan section offers", async () => {
    vi.stubEnv("BILLING_ENABLED", undefined);
    planActionsMock.mockReturnValue({ choose: [], manage: true });
    expect(usageLine(await render("owner"))).toContain(SUPPORT);
  });
});

// F3 (R1 security H1): every section that saves sends the workspace its page
// was rendered for, so a tab left open on one workspace cannot change another.
// Review of R5-security L2: the person whose card pays, once made a member,
// still reaches the portal to cancel or change the card.
describe("SettingsPage — the payer who is not an owner", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    isPayerMock.mockReset();
    isPayerMock.mockResolvedValue(false);
  });

  it("shows a member who pays a Manage your payment entry", async () => {
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_placeholder");
    isPayerMock.mockResolvedValue(true);
    const html = await render("member");
    expect(html).toContain("Your payment");
    expect(html).toContain("You pay for this workspace&#x27;s plan.");
    expect(html).toContain("[PlanActions Manage your payment ws-1]");
  });

  it("shows nothing for a member who does not pay, nor without the Stripe key", async () => {
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_placeholder");
    expect(await render("member")).not.toContain("Manage your payment");
    vi.stubEnv("STRIPE_SECRET_KEY", "");
    isPayerMock.mockResolvedValue(true);
    expect(await render("member")).not.toContain("Manage your payment");
  });

  it("never asks for an owner, who has the Plan section", async () => {
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_placeholder");
    await render("owner");
    expect(isPayerMock).not.toHaveBeenCalled();
  });
});

describe("SettingsPage — the rendered workspace", () => {
  it.each(["owner", "member"] as const)("gives each section that saves the page's workspace id, for an %s", async (role) => {
    for (const key of Object.keys(sectionProps)) delete sectionProps[key];
    await render(role);
    for (const name of ["SettingsForm", "PostingSlotsForm", "ConnectionsSection", "TeamSection"]) {
      expect(sectionProps[name]?.workspaceId, name).toBe("ws-1");
    }
  });

  // R35 client-journey L1: the Team card words a sole owner's Leave line with the
  // leave route's rule; whether this is their only workspace is plain data.
  it("tells the Team card, as a boolean, whether this is the owner's only workspace", async () => {
    for (const memberships of [1, 2]) {
      membershipCountMock.mockClear();
      membershipCountMock.mockResolvedValue(memberships);
      for (const key of Object.keys(sectionProps)) delete sectionProps[key];
      await render("owner");
      expect(sectionProps.TeamSection?.onlyWorkspace).toBe(memberships === 1);
      expect(membershipCountMock).toHaveBeenCalledWith({ where: { userId: "user-1" } });
    }
  });

  it("reads no membership count for a member, who has no Leave line", async () => {
    membershipCountMock.mockClear();
    for (const key of Object.keys(sectionProps)) delete sectionProps[key];
    await render("member");
    expect(sectionProps.TeamSection?.onlyWorkspace).toBe(false);
    expect(membershipCountMock).not.toHaveBeenCalled();
  });

  // R8-pages M1: the Usage section's per-person line says "Your" to the owner reading it.
  it.each(["owner", "member"] as const)("reads the usage for the person viewing it, for an %s", async (role) => {
    usageMock.mockClear();
    await render(role);
    expect(usageMock).toHaveBeenCalledWith("ws-1", expect.any(Date), context(role).user.id);
  });

  it("gives the Plan section the page's workspace id, for its Stripe buttons", async () => {
    planSectionMock.mockClear();
    await render("owner");
    expect(planSectionMock.mock.calls.at(-1)?.[0]).toMatchObject({ workspaceId: "ws-1" });
  });
});

// R6-pages M1: inside the warning window (lib/connectionExpiry.ts) the
// Connections card shows Reconnect; only the platform list reaches the client.
describe("SettingsPage — connections about to end", () => {
  const DAY = 24 * 60 * 60 * 1000;
  const linkedIn = (fields: Record<string, unknown>) => ({
    platform: "linkedin",
    accountIdentifier: "li-1",
    metadata: { username: "Surf Co page" },
    needsReconnect: false,
    refreshToken: null,
    ...fields,
  });

  afterEach(() => {
    findConnectionsMock.mockReset();
    findConnectionsMock.mockResolvedValue([]);
  });

  it("an in-window LinkedIn is passed on as reconnectSoon; a far one, or a renewable one, is not", async () => {
    findConnectionsMock.mockResolvedValue([
      linkedIn({ expiresAt: new Date(Date.now() + 3 * DAY) }),
      { ...linkedIn({ expiresAt: new Date(Date.now() + 3 * DAY), refreshToken: "sealed-secret-token" }), platform: "youtube" },
      { ...linkedIn({ expiresAt: new Date(Date.now() + 40 * DAY) }), platform: "pinterest" },
    ]);

    await render("owner");

    expect(sectionProps.ConnectionsSection.reconnectSoon).toEqual(["linkedin"]);
    const select = (findConnectionsMock.mock.calls[0][0] as { select: Record<string, boolean> }).select;
    expect(select).toMatchObject({ expiresAt: true, refreshToken: true, needsReconnect: true });
    // The token itself never reaches the client, only whether one exists.
    expect(JSON.stringify(sectionProps.ConnectionsSection)).not.toContain("sealed-secret-token");
    expect(JSON.stringify(sectionProps.ConnectionsSection.connections)).not.toContain("expiresAt");
  });

  it("an end date that has passed is passed on with the date, for Ended <date>", async () => {
    const ended = new Date(Date.now() - DAY);
    findConnectionsMock.mockResolvedValue([
      linkedIn({ expiresAt: ended }),
      { ...linkedIn({ expiresAt: new Date(Date.now() + 5 * DAY) }), platform: "youtube" },
    ]);
    await render("owner");
    expect(sectionProps.ConnectionsSection.reconnectSoon).toEqual(["linkedin", "youtube"]);
    expect(sectionProps.ConnectionsSection.endedAt).toEqual({ linkedin: ended.toISOString() });
  });

  // R13-pages L3: a member's Ends soon row says when, in UTC (connection-actions.tsx).
  it("an end still ahead is passed on as endsAt, which a member's row writes in UTC", async () => {
    const endsAt = new Date(Date.now() + 3 * DAY);
    findConnectionsMock.mockResolvedValue([
      linkedIn({ expiresAt: endsAt }),
      { ...linkedIn({ expiresAt: new Date(Date.now() - DAY) }), platform: "youtube" },
    ]);
    await render("member");
    const props = sectionProps.ConnectionsSection as { endsAt?: Record<string, string>; readOnly?: boolean };
    expect(props.readOnly).toBe(true);
    expect(props.endsAt).toEqual({ linkedin: endsAt.toISOString() });
    const { ConnectionActions, endsAtText } = await vi.importActual<typeof import("@/components/connection-actions")>(
      "@/components/connection-actions",
    );
    const html = renderToStaticMarkup(
      createElement(ConnectionActions, {
        platform: "linkedin",
        workspaceId: "ws-1",
        isConnected: true,
        readOnly: true,
        reconnectSoon: true,
        endsAt: props.endsAt!.linkedin,
      }),
    );
    expect(endsAtText(endsAt.toISOString())).toMatch(/ UTC$/);
    expect(html).toContain(`Ends ${endsAtText(endsAt.toISOString())}. The workspace owner can reconnect it.`);
  });

  it("nothing about to end: an empty list", async () => {
    findConnectionsMock.mockResolvedValue([linkedIn({ expiresAt: new Date(Date.now() + 40 * DAY) })]);
    await render("owner");
    expect(sectionProps.ConnectionsSection.reconnectSoon).toEqual([]);
  });
});

// R6 review low 1: a reconnect that came back with a different account changed nothing.
describe("SettingsPage — a reconnect with a different account", () => {
  afterEach(() => {
    findConnectionsMock.mockReset();
    findConnectionsMock.mockResolvedValue([]);
  });

  // R7-new-customer L2: the address carries no name; a crafted one is never shown.
  it("names only the connected account, and the sign-out step for LinkedIn; a name typed into the address is ignored", async () => {
    findConnectionsMock.mockResolvedValue([
      { platform: "linkedin", accountIdentifier: "member-1", metadata: { username: "Surf Co page" }, needsReconnect: true, expiresAt: null, refreshToken: null },
    ]);
    getWorkspaceContextMock.mockResolvedValue(context("owner"));

    const html = renderToStaticMarkup(
      (await SettingsPage({
        searchParams: Promise.resolve({ error: "linkedin_different_account", signed_in_as: "Visit evil.example to fix" }),
      })) as ReactElement,
    );

    expect(html).toContain(
      "LinkedIn connected a different page than Surf Co page, so nothing changed. Sign out of LinkedIn first (Reconnect shows the steps), then sign in with a LinkedIn account that manages Surf Co page. To use the other page instead, use Switch account.",
    );
    expect(html).not.toContain("evil.example");
  });

  it("another platform: sign in to the connected account, or Switch account", async () => {
    findConnectionsMock.mockResolvedValue([
      { platform: "youtube", accountIdentifier: "chan-1", metadata: { username: "Surf Co channel" }, needsReconnect: true, expiresAt: null, refreshToken: "sealed" },
    ]);
    getWorkspaceContextMock.mockResolvedValue(context("owner"));

    const html = renderToStaticMarkup(
      (await SettingsPage({ searchParams: Promise.resolve({ error: "youtube_different_account" }) })) as ReactElement,
    );

    expect(html).toContain(
      "You signed in to a different YouTube account than Surf Co channel. Sign in to Surf Co channel to reconnect it, or use Switch account to change accounts.",
    );
  });
});

// R6 second review 1: the new Google sign-in couldn't be checked against the chosen location.
describe("SettingsPage — a Business Profile reconnect that couldn't be checked", () => {
  afterEach(() => {
    findConnectionsMock.mockReset();
    findConnectionsMock.mockResolvedValue([]);
  });

  it("names the location and says to try again", async () => {
    findConnectionsMock.mockResolvedValue([
      {
        platform: "google_business_profile",
        accountIdentifier: "google_business_profile",
        metadata: { locationTitle: "Surf Co Dania" },
        needsReconnect: true,
        expiresAt: null,
        refreshToken: "sealed",
      },
    ]);
    getWorkspaceContextMock.mockResolvedValue(context("owner"));

    const html = renderToStaticMarkup(
      (await SettingsPage({ searchParams: Promise.resolve({ error: "google_business_profile_account_check_failed" }) })) as ReactElement,
    );

    expect(html).toContain("We couldn&#x27;t check that this Google account manages Surf Co Dania. Try again in a minute.");
  });
});

// R6 third review: a Business Profile reconnect whose location this Google account can't use.
describe("SettingsPage — a Business Profile reconnect that cleared the location", () => {
  afterEach(() => {
    findConnectionsMock.mockReset();
    findConnectionsMock.mockResolvedValue([]);
  });

  it("says it reconnected and asks for a location; a title typed into the address is never shown", async () => {
    findConnectionsMock.mockResolvedValue([
      { platform: "google_business_profile", accountIdentifier: "google_business_profile", metadata: { locationName: null }, needsReconnect: false, expiresAt: null, refreshToken: "sealed" },
    ]);
    getWorkspaceContextMock.mockResolvedValue(context("owner"));

    const html = renderToStaticMarkup(
      (await SettingsPage({
        searchParams: Promise.resolve({ success: "google_business_profile_connected", location_cleared: "Visit evil.example" }),
      })) as ReactElement,
    );

    expect(html).toContain(
      "Reconnected. Choose the location to post to; the one chosen before isn&#x27;t available to this Google account.",
    );
    expect(html).not.toContain("evil.example");
  });

  // R6 fourth review 1: anyone can type the parameter; only a real cleared reconnect shows it.
  it.each([
    [
      "the connection has a location chosen",
      [{ platform: "google_business_profile", accountIdentifier: "google_business_profile", metadata: { locationName: "accounts/1/locations/555", locationTitle: "Surf Co Dania" }, needsReconnect: false, expiresAt: null, refreshToken: "sealed" }],
    ],
    ["there is no Business Profile connection", []],
  ])("a crafted link where %s: no such sentence", async (_case, rows) => {
    findConnectionsMock.mockResolvedValue(rows);
    getWorkspaceContextMock.mockResolvedValue(context("owner"));

    const html = renderToStaticMarkup(
      (await SettingsPage({
        searchParams: Promise.resolve({ success: "google_business_profile_connected", location_cleared: "Somewhere Else" }),
      })) as ReactElement,
    );

    expect(html).not.toContain("Reconnected. Choose the location");
    expect(html).not.toContain("Somewhere Else");
  });
});

// Unconfirmed (R7 client-journey): an owner's LinkedIn Reconnect that LinkedIn
// answered with the same end date (the callback's same_end flag; no name, no date in the address).
describe("SettingsPage — a LinkedIn reconnect that did not renew", () => {
  afterEach(() => {
    findConnectionsMock.mockReset();
    findConnectionsMock.mockResolvedValue([]);
  });

  const DAY = 24 * 60 * 60 * 1000;
  async function renderWith(expiresAt: Date, query: Record<string, string>): Promise<string> {
    findConnectionsMock.mockResolvedValue([
      { platform: "linkedin", accountIdentifier: "member-1", metadata: { username: "Surf Co page" }, needsReconnect: false, expiresAt, refreshToken: null },
    ]);
    getWorkspaceContextMock.mockResolvedValue(context("owner"));
    return renderToStaticMarkup((await SettingsPage({ searchParams: Promise.resolve(query) })) as ReactElement);
  }

  it("same date: says LinkedIn gave the same end date, with the stored date", async () => {
    const expiresAt = new Date(Date.now() + 3 * DAY);
    const html = await renderWith(expiresAt, { success: "linkedin_connected", same_end: "1" });
    // R8-pages L5: what to do next.
    // R9-pages L2: no date of its own; the row shows it.
    expect(html).toContain("LinkedIn kept the same end date. Reconnect after that date to keep posting; posts due after it fail until you do.");
    // R7 review 2: a warning, as on /c.
    expect(html).toMatch(/<div role="alert" class="[^"]*border-warning\/25[^"]*"/);
  });

  it("renewed: the usual message, even with a crafted flag", async () => {
    const html = await renderWith(new Date(Date.now() + 60 * DAY), { success: "linkedin_connected", same_end: "1" });
    expect(html).not.toContain("kept the same end date");
    expect(html).toContain("LinkedIn");
  });

  it("no flag: the usual message", async () => {
    const html = await renderWith(new Date(Date.now() + 3 * DAY), { success: "linkedin_connected" });
    expect(html).not.toContain("kept the same end date");
  });
});

// R8-new-customer L1 / L4 (lead's follow-up): the page decides both Plan section facts from the workspace and the viewer.
describe("SettingsPage — the Plan section's per-person note and no-plan flag", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    noPlanYetMock.mockReset();
    noPlanYetMock.mockReturnValue(false);
    personalNoteMock.mockReset();
    personalNoteMock.mockReturnValue(null);
    findOwnersMock.mockReset();
    findOwnersMock.mockResolvedValue([]);
  });

  it("passes the no-plan flag as a prop", async () => {
    noPlanYetMock.mockReturnValue(true);
    planSectionMock.mockClear();
    await render("owner");
    expect(noPlanYetMock).toHaveBeenCalledWith("owner", expect.objectContaining({ id: "ws-1" }), expect.any(Date));
    expect(planSectionMock.mock.calls.at(-1)?.[0]).toMatchObject({ noPlanYet: true });
  });

  it("passes the viewer's per-person note, read for the viewer", async () => {
    personalNoteMock.mockReturnValue({ limit: 5, reduced: "unconfirmed" });
    planSectionMock.mockClear();
    await render("owner");
    const [, viewer, operatorOwned] = personalNoteMock.mock.calls.at(-1) ?? [];
    expect(viewer).toMatchObject({ id: "user-1", createdAt: new Date("2026-11-01T08:00:00Z") });
    expect(operatorOwned).toBe(false);
    expect(planSectionMock.mock.calls.at(-1)?.[0]).toMatchObject({ personalPostNote: { limit: 5, reduced: "unconfirmed" } });
  });

  it("an operator among the owners: the note is asked for as operator-owned", async () => {
    vi.stubEnv("ADMIN_EMAILS", "ops@example.test");
    findOwnersMock.mockResolvedValue([
      { user: { email: "owner@example.test", emailVerifiedAt: new Date("2026-11-01T09:00:00Z") } },
      { user: { email: "ops@example.test", emailVerifiedAt: new Date("2026-11-01T09:00:00Z") } },
    ]);
    await render("owner");
    expect(findOwnersMock).toHaveBeenCalledWith(
      expect.objectContaining({ where: { workspaceId: "ws-1", role: "owner" } }),
    );
    expect(personalNoteMock.mock.calls.at(-1)?.[2]).toBe(true);
  });
});

// R9-pages L1 and L7: the first day's end is shown in the viewer's own time, in Usage and in Plan.
describe("SettingsPage — the viewer's time zone", () => {
  it("goes to the Usage and the Plan sections", async () => {
    const ctx = context("owner");
    getWorkspaceContextMock.mockResolvedValue({ ...ctx, user: { ...ctx.user, timeZone: "America/New_York" } });
    planSectionMock.mockClear();
    renderToStaticMarkup((await SettingsPage({ searchParams: Promise.resolve({}) })) as ReactElement);
    expect(sectionProps.UsageSection).toMatchObject({ timeZone: "America/New_York" });
    expect(planSectionMock.mock.calls.at(-1)?.[0]).toMatchObject({ timeZone: "America/New_York" });
  });

  // R13-new-customer L1: Settings, Plan's dates are written in the viewer's zone.
  it("goes to the Plan line's dates", async () => {
    const ctx = context("owner");
    getWorkspaceContextMock.mockResolvedValue({ ...ctx, user: { ...ctx.user, timeZone: "America/New_York" } });
    planSectionMock.mockClear();
    renderToStaticMarkup((await SettingsPage({ searchParams: Promise.resolve({}) })) as ReactElement);
    expect(planSectionMock.mock.calls.at(-1)?.[0]).toMatchObject({ label: "Studio plan in America/New_York" });
  });

  it("none known: null", async () => {
    planSectionMock.mockClear();
    await render("owner");
    expect(sectionProps.UsageSection).toMatchObject({ timeZone: null });
  });
});

// R8-pages L5 (lead's follow-up): the kept end date goes down to the row as a prop.
describe("SettingsPage — the same-end row", () => {
  afterEach(() => {
    findConnectionsMock.mockReset();
    findConnectionsMock.mockResolvedValue([]);
  });

  const DAY = 24 * 60 * 60 * 1000;
  async function rowProps(expiresAt: Date, query: Record<string, string>) {
    findConnectionsMock.mockResolvedValue([
      { platform: "linkedin", accountIdentifier: "member-1", metadata: { username: "Surf Co page" }, needsReconnect: false, expiresAt, refreshToken: null },
    ]);
    getWorkspaceContextMock.mockResolvedValue(context("owner"));
    renderToStaticMarkup((await SettingsPage({ searchParams: Promise.resolve(query) })) as ReactElement);
    return sectionProps.ConnectionsSection;
  }

  it("with the flag and the date still inside the window: sameEndAt for LinkedIn", async () => {
    const expiresAt = new Date(Date.now() + 3 * DAY);
    const props = await rowProps(expiresAt, { success: "linkedin_connected", same_end: "1" });
    expect(props.sameEndAt).toEqual({ linkedin: expiresAt.toISOString() });
  });

  it("no flag, or a renewed sign-in: none", async () => {
    expect((await rowProps(new Date(Date.now() + 3 * DAY), { success: "linkedin_connected" })).sameEndAt).toEqual({});
    expect(
      (await rowProps(new Date(Date.now() + 60 * DAY), { success: "linkedin_connected", same_end: "1" })).sameEndAt,
    ).toEqual({});
  });
});

// R28 new-customer L6: a missing Google permission names the control the row shows.
describe("SettingsPage — a missing Google permission", () => {
  afterEach(() => {
    findConnectionsMock.mockReset();
    findConnectionsMock.mockResolvedValue([]);
  });

  const render = async (error: string) =>
    renderToStaticMarkup((await SettingsPage({ searchParams: Promise.resolve({ error }) })) as ReactElement);

  it("a flagged YouTube row: Reconnect, never Connect", async () => {
    findConnectionsMock.mockResolvedValue([
      { platform: "youtube", accountIdentifier: "chan-1", metadata: { username: "Surf Co channel" }, needsReconnect: true, expiresAt: null, refreshToken: "sealed" },
    ]);
    getWorkspaceContextMock.mockResolvedValue(context("owner"));

    const html = await render("youtube_upload_not_allowed");

    expect(html).toContain("YouTube wasn&#x27;t reconnected: the permission to upload videos wasn&#x27;t allowed. Click Reconnect and");
    expect(html).not.toContain("Click Connect again");
  });

  it("no YouTube row: Connect", async () => {
    getWorkspaceContextMock.mockResolvedValue(context("owner"));

    expect(await render("youtube_readonly_not_allowed")).toContain(
      "YouTube wasn&#x27;t connected: the permission to see your YouTube account wasn&#x27;t allowed. Click Connect again and",
    );
  });

  it("a flagged Business Profile card: Reconnect on the card, not the hidden sign-in link", async () => {
    findConnectionsMock.mockResolvedValue([
      { platform: "google_business_profile", accountIdentifier: "google_business_profile", metadata: { locationName: "accounts/1/locations/2" }, needsReconnect: true, expiresAt: null, refreshToken: "sealed" },
    ]);
    getWorkspaceContextMock.mockResolvedValue(context("owner"));

    const html = await render("google_business_profile_permission_missing");

    expect(html).toContain("Click Reconnect on the Google Business Profile card and");
    expect(html).not.toContain("Sign in to Google again from the Google Business Profile card");
  });
});
