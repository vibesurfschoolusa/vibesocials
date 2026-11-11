import type { Metadata } from "next";

import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  CONNECT_LINK_INACTIVE_MESSAGE,
  connectLinkPlatformConfigured,
  describeConnectLinkResult,
} from "@/lib/connectLink";
import { PLATFORM_LABELS, PLATFORM_ORDER } from "@/lib/platforms";
import { findActiveConnectLink, listLinkConnections } from "@/server/connectLink/link";

import { ConnectLinkChoice } from "./connect-link-choice";

/**
 * /c/[token] — a workspace's client connect link (2026-11-11). Open signed out
 * (proxy.ts isPublicPath, nav.ts PUBLIC_ROUTE_PREFIXES: no app shell). Each
 * offered platform the site can connect is a row with a plain form posting to
 * /api/connect-link/[token]/start, so connecting works without JavaScript.
 * After a flow the callback sends the visitor back here with one outcome in
 * the query, shown as one sentence; a choice among several accounts is the
 * only part that needs a small client component.
 */

interface ConnectLinkPageProps {
  params: Promise<{ token: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export const metadata: Metadata = {
  title: "Connect your accounts",
  robots: { index: false, follow: false },
  // The token is in the address, so only the bare origin is ever sent as a
  // referrer, here or to another site. Not "no-referrer" like /u and /v:
  // under that policy a browser without fetch metadata sends `Origin: null`
  // on the Connect form, and the start route could not tell it is ours.
  referrer: "strict-origin",
};

function first(value: string | string[] | undefined): string | null {
  return (Array.isArray(value) ? value[0] : value) ?? null;
}

export default async function ConnectLinkPage({ params, searchParams }: ConnectLinkPageProps) {
  const { token } = await params;
  const query = await searchParams;
  const link = await findActiveConnectLink(token);

  if (!link) {
    return (
      <main className="min-h-screen bg-background px-4 py-10 text-foreground">
        <div className="mx-auto w-full max-w-md">
          <p className="text-base">{CONNECT_LINK_INACTIVE_MESSAGE}</p>
        </div>
      </main>
    );
  }

  const connections = await listLinkConnections(link.workspaceId);
  const byPlatform = new Map(connections.map((connection) => [connection.platform, connection]));
  const platforms = PLATFORM_ORDER.filter(
    (platform) => link.platforms.includes(platform) && connectLinkPlatformConfigured(platform),
  );

  const outcome = new URLSearchParams();
  for (const key of ["error", "success", "linkedin_setup"]) {
    const value = first(query[key]);
    if (value) outcome.set(key, value);
  }
  const result = describeConnectLinkResult(outcome, link.workspaceName);
  const pendingId = first(query.choose);
  const action = `/api/connect-link/${encodeURIComponent(token)}/start`;

  return (
    <main className="min-h-screen bg-background px-4 py-8 text-foreground sm:py-10">
      <div className="mx-auto w-full max-w-md">
        {result ? (
          <Alert variant={result.variant} className="mb-6">
            <p>{result.message}</p>
          </Alert>
        ) : null}
        {pendingId ? (
          <div className="mb-6">
            <ConnectLinkChoice token={token} pendingId={pendingId} />
          </div>
        ) : null}

        <h1 className="break-words text-2xl font-bold tracking-tight">
          Connect your accounts to {link.workspaceName}
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          {link.workspaceName} will be able to publish posts to the accounts you connect here. They cannot see
          your password.
        </p>
        <p className="mt-2 text-sm text-muted-foreground">
          You can remove this access at any time in each platform&apos;s own settings.
        </p>
        <p className="mt-2 text-sm text-muted-foreground">
          <a href="/terms" className="underline">
            Terms
          </a>{" "}
          ·{" "}
          <a href="/privacy" className="underline">
            Privacy
          </a>
        </p>

        <ul className="mt-6 divide-y rounded-[var(--radius)] border">
          {platforms.map((platform) => {
            const connection = byPlatform.get(platform);
            const working = connection && !connection.needsReconnect;
            const name = connection?.username || connection?.accountIdentifier || null;
            return (
              <li key={platform} className="flex items-center justify-between gap-3 px-4 py-3">
                <span className="font-medium">{PLATFORM_LABELS[platform]}</span>
                {working ? (
                  <span className="text-right text-sm text-muted-foreground">
                    {name ? `Connected: ${name}` : "Connected"}
                  </span>
                ) : (
                  <form action={action} method="post">
                    <input type="hidden" name="platform" value={platform} />
                    <Button type="submit" size="sm">
                      {connection ? "Reconnect" : "Connect"}
                    </Button>
                  </form>
                )}
              </li>
            );
          })}
        </ul>
      </div>
    </main>
  );
}
