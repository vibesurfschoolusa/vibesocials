import { redirect } from "next/navigation";
import Link from "next/link";

import { getWorkspaceContext, getWorkspaceMemberCount } from "@/lib/workspace";
import { prisma } from "@/lib/db";
import { SettingsForm } from "@/components/settings-form";
import { PostingSlotsForm } from "@/components/posting-slots-form";
import { readPostingSlots } from "@/lib/postingSlots";
import { ConnectionsSection } from "@/components/connections-section";
import { ConnectLinkSection } from "@/components/connect-link-section";
import { TeamSection, type WorkspaceDeletionInfo } from "@/components/team-section";
import { AccountSection } from "@/components/account-section";
import { accountDeletionPreview } from "@/server/account/accountDeletion";
import { workspaceDeletionRefusal } from "@/server/account/deleteWorkspace";
import { UsageSection } from "@/components/usage-section";
import { WorkspaceLogoControl } from "@/components/workspace-logo-control";
import { PlanSection } from "@/components/plan-section";
import {
  PLAN_PORTAL_ONLY_LABEL,
  planReturnNotice,
  planSectionActions,
  planSectionLabel,
} from "@/components/planSectionView";
import { paymentsConfigured, stripeReachable } from "@/lib/billing";
import { workspacePlanNoteShown } from "@/lib/planCopy";
import { getPlanOffers } from "@/server/billing/planPrices";
import { getWorkspaceUsageOrNull } from "@/server/usage/workspaceUsage";
import { Alert } from "@/components/ui/alert";
import { describeOAuthResult } from "@/lib/oauthResult";
import { advertisedPlatforms } from "@/lib/advertisedPlatforms";
import { platformHelpHref } from "@/lib/platformGuides";
import { platformLabel } from "@/lib/platforms";
import { type ConnectionSummary, toConnectionSummary } from "@/lib/connectionSummary";
import type { UserSettings } from "@/lib/userSettings";
import { SUPPORT_EMAIL } from "@/lib/siteInfo";

import { accountDeletionCancelsPaidPlan, workspacesHavePaidPlan } from "./paidPlans";
import { settingsPlanNotes } from "./planNotes";

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; success?: string; billing?: string }>;
}) {
  // Team Workspaces (Task 6): getWorkspaceContext() covers the auth gate
  // (null when unauthenticated, same as a bare getCurrentUser() check) and
  // additionally resolves the active workspace this page's data now reads
  // from. Task 7 uses `context.role` below to split the Posts and emails/Connections
  // forms into owner-mutation vs member-read-only, and to gate the new Team
  // card's management controls.
  const context = await getWorkspaceContext();

  if (!context) {
    redirect(`/login?callbackUrl=${encodeURIComponent("/settings")}`);
  }

  const params = await searchParams;
  const oauthResult = describeOAuthResult({
    error: params.error ?? null,
    success: params.success ?? null,
  });

  // SEC-1: project only browser-safe fields so passwordHash/email never reach
  // the client component payload. See lib/userSettings.ts.
  const settings: UserSettings = {
    companyWebsite: context.workspace.companyWebsite,
    defaultHashtags: context.workspace.defaultHashtags,
    notifyOnPostComplete: context.user.notifyOnPostComplete,
    notifyDailyDigest: context.user.notifyDailyDigest,
    notifyNewReviews: context.user.notifyNewReviews,
    notifyMonthlyReport: context.user.notifyMonthlyReport,
    requireApproval: context.workspace.requireApproval,
    googleButtonType: context.workspace.googleButtonType,
    googleButtonUrl: context.workspace.googleButtonUrl,
    brandVoice: context.workspace.brandVoice,
    brandVoiceExamples: context.workspace.brandVoiceExamples,
    trackWebsiteLinks: context.workspace.trackWebsiteLinks,
  };

  // Fetch the WORKSPACE's connections (shared by every member — design §2),
  // not just this user's. SEC-1: select only browser-safe columns and map to
  // ConnectionSummary so OAuth tokens (accessToken/refreshToken) and the raw
  // metadata JSON (which holds page access tokens) never reach the client.
  const rows = await prisma.socialConnection.findMany({
    where: { workspaceId: context.workspace.id },
    select: {
      platform: true,
      accountIdentifier: true,
      metadata: true,
      // Roadmap Phase 4: the connection-health flag itself — still never
      // accessToken/refreshToken/scopes/raw metadata beyond the display
      // fields toConnectionSummary reads.
      needsReconnect: true,
    },
  });

  const connections: ConnectionSummary[] = rows.map(toConnectionSummary);

  // Posting times (brief 11): read here, not carried in every route's context.
  const slotRow = await prisma.workspace.findUnique({
    where: { id: context.workspace.id },
    select: { postingSlots: true },
  });
  const postingSlots = readPostingSlots(slotRow?.postingSlots);
  // The report logo (18b): its public address only, for every member to see.
  const logo = await prisma.workspace.findUnique({
    where: { id: context.workspace.id },
    select: { logoUrl: true },
  });

  // Usage limits (2026-11-10): the same counts the limits are enforced with.
  // Null when they cannot be read: the section says so and the page still renders.
  const usage = await getWorkspaceUsageOrNull(context.workspace.id, new Date());
  // 21b: the Stripe columns, read only for owners and only when Stripe is set up.
  const stripeRow =
    context.role === "owner" && stripeReachable()
      ? await prisma.workspace.findUnique({
          where: { id: context.workspace.id },
          select: { stripeCustomerId: true, planEndsAt: true },
        })
      : null;
  const planWorkspace = { ...context.workspace, ...(stripeRow ?? {}) };
  // 21b: the plan buttons (payments configured) and the portal (the Stripe key
  // and a plan or customer, billing on or off); null: no buttons.
  const planActions = planSectionActions(context.role, planWorkspace, new Date());
  // 21a: owners only, and only with billing on. 21b fix round 1: with billing
  // off, the section still shows when the portal does.
  const planLabel =
    planSectionLabel(context.role, planWorkspace, new Date()) ?? (planActions?.manage ? PLAN_PORTAL_ONLY_LABEL : null);
  const planOffers = planActions && planActions.choose.length > 0 ? await getPlanOffers(planActions.choose) : [];
  const planNotice = paymentsConfigured() ? planReturnNotice(params.billing, planWorkspace, new Date()) : null;

  // What the two delete confirmations say, computed with the same functions
  // the delete routes use, so the dialog shows the sentence the route would
  // refuse with.
  // S1: and whether deleting cancels a paid plan; nothing is read without the Stripe key.
  const [accountDeletion, workspaceDeletion, accountCancelsPaidPlan] = await Promise.all([
    accountDeletionPreview(context.user.id),
    context.role === "owner" ? loadWorkspaceDeletion(context.workspace.id, context.user.id) : null,
    accountDeletionCancelsPaidPlan(context.user.id),
  ]);

  // The jump links under the title: one per section this person sees, in page
  // order, each to its heading's id (Plan only when it shows, below).
  const sections = [
    { id: "post-defaults", label: "Posts and emails" },
    { id: "posting-times", label: "Posting times" },
    { id: "connections", label: "Connections" },
    { id: "team", label: "Team" },
    ...(planLabel ? [{ id: "plan", label: "Plan" }] : []),
    { id: "usage", label: "Usage" },
    { id: "account", label: "Account" },
  ];

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 md:px-6 lg:px-8">
      {oauthResult ? (
        <Alert variant={oauthResult.variant} className="mb-6">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <p>{oauthResult.message}</p>
              {oauthResult.variant === "danger" && oauthResult.platform ? (
                <Link
                  href={platformHelpHref(oauthResult.platform)}
                  className="mt-1 inline-block text-sm font-medium text-primary underline-offset-4 hover:underline"
                >
                  See how to connect {platformLabel(oauthResult.platform)}
                </Link>
              ) : null}
            </div>
            <Link
              href="/settings"
              className="text-sm font-medium text-primary underline-offset-4 hover:underline"
            >
              Dismiss
            </Link>
          </div>
        </Alert>
      ) : null}

      <header className="mb-8">
        <h1 className="text-2xl font-bold tracking-tight text-foreground">Settings</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Your post defaults and emails, posting times, connections, team, usage and your account.
        </p>
        <nav aria-label="Settings sections">
          <ul className="mt-4 flex flex-wrap gap-x-4 gap-y-2 text-sm">
            {sections.map((section) => (
              <li key={section.id}>
                <a href={`#${section.id}`} className="font-medium text-primary underline-offset-4 hover:underline">
                  {section.label}
                </a>
              </li>
            ))}
          </ul>
        </nav>
      </header>

      <div className="flex flex-col gap-10">
        <section>
          <div className="mb-4">
            <h2 id="post-defaults" className="scroll-mt-20 text-lg font-semibold tracking-tight text-foreground">Posts and emails</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              What every post starts with (the footer, the brand voice the AI writes in, approvals
              and Google post defaults) and which emails you get.
            </p>
          </div>
          {/* key: force a REMOUNT when the active workspace changes. This
              client component seeds its local state from props once at mount
              (footer inputs, preview, member read-only card), and the
              account-menu switcher's router.refresh() intentionally preserves
              client state — without the key, workspace A's values would stay
              on screen under workspace B after an in-page switch. */}
          <SettingsForm
            key={context.workspace.id}
            settings={settings}
            role={context.role}
            planNotes={settingsPlanNotes(context.workspace)}
          />
        </section>

        <section>
          <div className="mb-4">
            <h2 id="posting-times" className="scroll-mt-20 text-lg font-semibold tracking-tight text-foreground">Posting times</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              The times you usually post each week. Create and Add many can fill in the next free one.
            </p>
          </div>
          {/* key: remount on a workspace switch, like SettingsForm. */}
          <PostingSlotsForm key={context.workspace.id} slots={postingSlots} role={context.role} />
        </section>

        <section>
          <div className="mb-4">
            <h2 id="connections" className="scroll-mt-20 text-lg font-semibold tracking-tight text-foreground">Connections</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Connect your social accounts so Vibe Socials can publish on your behalf.
            </p>
          </div>
          <ConnectionsSection
            connections={connections}
            readOnly={context.role !== "owner"}
            // Pinterest is listed once its app credentials are set (lib/advertisedPlatforms.ts).
            unavailablePlatforms={advertisedPlatforms().includes("pinterest") ? [] : ["pinterest"]}
          />
          {/* Owners only; key: one link per workspace, so remount on a switch. */}
          <div id="connect-link" className="mt-4 scroll-mt-20">
            <ConnectLinkSection
              key={`connect-link-${context.workspace.id}`}
              workspaceId={context.workspace.id}
              isOwner={context.role === "owner"}
            />
          </div>
        </section>

        <section>
          <div className="mb-4">
            <h2 id="team" className="scroll-mt-20 text-lg font-semibold tracking-tight text-foreground">Team</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {context.role === "owner"
                ? "Invite teammates and manage who has access to this workspace."
                : "See who else is in this workspace."}
            </p>
          </div>
          {/* key: same remount-on-switch rule as SettingsForm above — the
              owner view's invite/member fetch effects run once per mount and
              its rename state seeds from props, all assuming one workspace
              per mounted instance. */}
          <WorkspaceLogoControl
            key={`logo-${context.workspace.id}`}
            logoUrl={logo?.logoUrl ?? null}
            isOwner={context.role === "owner"}
            workspaceId={context.workspace.id}
          />
          <TeamSection
            key={context.workspace.id}
            role={context.role}
            workspaceName={context.workspace.name}
            deletion={workspaceDeletion}
          />
        </section>

        {planLabel ? (
          <section>
            <div className="mb-4">
              <h2 id="plan" className="scroll-mt-20 text-lg font-semibold tracking-tight text-foreground">Plan</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                This workspace&apos;s plan and the limits that come with it.
              </p>
            </div>
            <PlanSection
              label={planLabel}
              usage={usage}
              notice={planNotice}
              offers={planOffers}
              manage={planActions?.manage ?? false}
              workspaceNote={workspacePlanNoteShown(planWorkspace, new Date())}
            />
          </section>
        ) : null}

        <section>
          <div className="mb-4">
            <h2 id="usage" className="scroll-mt-20 text-lg font-semibold tracking-tight text-foreground">Usage</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              What this workspace has used of its limits. For a higher limit, write to {SUPPORT_EMAIL}.
            </p>
          </div>
          <UsageSection usage={usage} />
        </section>

        <section>
          <div className="mb-4">
            <h2 id="account" className="scroll-mt-20 text-lg font-semibold tracking-tight text-foreground">Account</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Your sign-in, your password, and deleting your account.
            </p>
          </div>
          {/* SEC-1: a boolean, never the hash itself. */}
          <AccountSection
            email={context.user.email}
            hasPassword={context.user.passwordHash !== null}
            deletion={accountDeletion}
            cancelsPaidPlan={accountCancelsPaidPlan}
          />
        </section>
      </div>
    </div>
  );
}

async function loadWorkspaceDeletion(
  workspaceId: string,
  userId: string,
): Promise<WorkspaceDeletionInfo> {
  const [memberCount, scheduledCount, refusal, paidPlan] = await Promise.all([
    getWorkspaceMemberCount(workspaceId),
    prisma.postJob.count({ where: { workspaceId, status: "scheduled" } }),
    workspaceDeletionRefusal(workspaceId, userId),
    workspacesHavePaidPlan([workspaceId]),
  ]);
  // Without a paid plan the dialog's props are exactly as before.
  return { memberCount, scheduledCount, refusal, ...(paidPlan ? { paidPlan } : {}) };
}
