import { redirect } from "next/navigation";
import Link from "next/link";

import { getWorkspaceContext } from "@/lib/workspace";
import { prisma } from "@/lib/db";
import { SettingsForm } from "@/components/settings-form";
import { ConnectionsSection } from "@/components/connections-section";
import { TeamSection } from "@/components/team-section";
import { Alert } from "@/components/ui/alert";
import { describeOAuthResult } from "@/lib/oauthResult";
import type { ConnectionSummary } from "@/lib/connectionSummary";
import type { UserSettings } from "@/lib/userSettings";

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; success?: string }>;
}) {
  // Team Workspaces (Task 6): getWorkspaceContext() covers the auth gate
  // (null when unauthenticated, same as a bare getCurrentUser() check) and
  // additionally resolves the active workspace this page's data now reads
  // from. Task 7 uses `context.role` below to split the Captions/Connections
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
    requireApproval: context.workspace.requireApproval,
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
      // accessToken/refreshToken/scopes/raw metadata beyond the two fields
      // flattened below.
      needsReconnect: true,
    },
  });

  const connections: ConnectionSummary[] = rows.map((row) => {
    const metadata = row.metadata as unknown as
      | { username?: string | null; locationName?: string | null }
      | null;
    return {
      platform: row.platform,
      accountIdentifier: row.accountIdentifier,
      username: metadata?.username ?? null,
      locationName: metadata?.locationName ?? null,
      needsReconnect: row.needsReconnect,
    };
  });

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 md:px-6 lg:px-8">
      {oauthResult ? (
        <Alert variant={oauthResult.variant} className="mb-6">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p>{oauthResult.message}</p>
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
          Configure your default caption footer and manage social platform connections.
        </p>
      </header>

      <div className="flex flex-col gap-10">
        <section>
          <div className="mb-4">
            <h2 className="text-lg font-semibold tracking-tight text-foreground">Captions</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Configure the default footer appended to all your posts.
            </p>
          </div>
          {/* key: force a REMOUNT when the active workspace changes. This
              client component seeds its local state from props once at mount
              (footer inputs, preview, member read-only card), and the
              account-menu switcher's router.refresh() intentionally preserves
              client state — without the key, workspace A's values would stay
              on screen under workspace B after an in-page switch. */}
          <SettingsForm key={context.workspace.id} settings={settings} role={context.role} />
        </section>

        <section>
          <div className="mb-4">
            <h2 className="text-lg font-semibold tracking-tight text-foreground">Connections</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Connect your social accounts so Vibe Socials can publish on your behalf.
            </p>
          </div>
          <ConnectionsSection connections={connections} readOnly={context.role !== "owner"} />
        </section>

        <section>
          <div className="mb-4">
            <h2 className="text-lg font-semibold tracking-tight text-foreground">Team</h2>
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
          <TeamSection
            key={context.workspace.id}
            role={context.role}
            workspaceName={context.workspace.name}
          />
        </section>
      </div>
    </div>
  );
}
