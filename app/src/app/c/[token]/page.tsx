import type { Metadata } from "next";

import { ClientPageShell } from "@/components/client-page-header";
import { Alert } from "@/components/ui/alert";
import { Button, buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import {
  CONNECT_LINK_INACTIVE_MESSAGE,
  connectLinkPlatformConfigured,
  describeConnectLinkResult,
} from "@/lib/connectLink";
import { findClientPageLogo } from "@/lib/clientPageLogo";
import { SAME_END_PARAM, sameEndDateMessage } from "@/lib/connectionExpiry";
import { prisma } from "@/lib/db";
import {
  LOCATION_CLEARED_LINK_MESSAGE,
  LOCATION_CLEARED_PARAM,
  accountCheckFailedMessage,
  accountCheckFailedPlatform,
  connectedAccountName,
  differentAccountPlatform,
  linkDifferentAccountMessage,
  linkedInReconnectSignInStep,
} from "@/lib/differentAccount";
import { formatDisplayDate } from "@/lib/displayDate";
import { LINKEDIN_SIGN_OUT_URL } from "@/lib/linkedinAccount";
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
      <ClientPageShell workspace={null}>
        <p className="text-base">{CONNECT_LINK_INACTIVE_MESSAGE}</p>
      </ClientPageShell>
    );
  }

  const [connections, logoUrl] = await Promise.all([
    listLinkConnections(link.workspaceId),
    findClientPageLogo(link.workspaceId),
  ]);
  const byPlatform = new Map(connections.map((connection) => [connection.platform, connection]));
  const platforms = PLATFORM_ORDER.filter(
    (platform) => link.platforms.includes(platform) && connectLinkPlatformConfigured(platform),
  );

  const outcome = new URLSearchParams();
  for (const key of ["error", "linkedin_setup"]) {
    const value = first(query[key]);
    if (value) outcome.set(key, value);
  }
  // Anyone can type ?success=… by hand, so a success is told only when the
  // workspace really has a working connection for that platform.
  const success = first(query.success);
  const succeeded = PLATFORM_ORDER.find((platform) => success === `${platform}_connected`);
  const working = succeeded ? byPlatform.get(succeeded) : undefined;
  if (success && working && !working.needsReconnect && !working.reconnectSoon) outcome.set("success", success);
  // Unconfirmed (R7 client-journey): the callback flagged a sign-in that ends
  // inside the warning window; said, with the stored date, only when the
  // connection really is in it, instead of no sentence at all.
  const sameEnd =
    success &&
    first(query[SAME_END_PARAM]) !== null &&
    working &&
    !working.needsReconnect &&
    working.reconnectSoon &&
    !working.ended
      ? await prisma.socialConnection.findUnique({
          where: { workspaceId_platform: { workspaceId: link.workspaceId, platform: working.platform } },
          select: { expiresAt: true },
        })
      : null;
  // R6 review low 1: the sign-in came back with another account than the one
  // connected, and nothing changed. Named by the connected account only.
  const differentPlatform = differentAccountPlatform(outcome.get("error"));
  const differentFrom = differentPlatform ? byPlatform.get(differentPlatform) : undefined;
  // R7-client-journey L4: the owners are emailed where the refusal happens
  // (server/connectLink/callback.ts, the choice route), never from this page,
  // which anyone holding the link can open with any query.
  const uncheckedPlatform = accountCheckFailedPlatform(outcome.get("error"));
  const uncheckedFrom = uncheckedPlatform ? byPlatform.get(uncheckedPlatform) : undefined;
  // R6 third review: a Business Profile reconnect whose location this Google
  // account can't use was saved with it cleared; the owner chooses it.
  const locationCleared =
    outcome.get("success") === "google_business_profile_connected" && first(query[LOCATION_CLEARED_PARAM]) !== null;
  const result = locationCleared
    ? { variant: "success" as const, message: LOCATION_CLEARED_LINK_MESSAGE }
    : sameEnd?.expiresAt && working
      ? { variant: "warning" as const, message: sameEndDateMessage(working.platform, sameEnd.expiresAt) }
      : differentPlatform && differentFrom
      ? { variant: "danger" as const, message: linkDifferentAccountMessage(differentPlatform, connectedAccountName(differentFrom)) }
      : uncheckedFrom
        ? { variant: "danger" as const, message: accountCheckFailedMessage(connectedAccountName(uncheckedFrom)) }
        : describeConnectLinkResult(outcome);
  const sameEndOn = sameEnd?.expiresAt && working ? { platform: working.platform, expiresAt: sameEnd.expiresAt } : null;
  const pendingId = first(query.choose);
  const action = `/api/connect-link/${encodeURIComponent(token)}/start`;

  return (
    <ClientPageShell workspace={{ name: link.workspaceName, logoUrl }} title="Connect your accounts">
      <div>
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

        <p className="text-sm text-muted-foreground">
          The person who sent you this link will be able to publish posts to the accounts you connect here. They
          cannot see your password.
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
            // R8-client-journey L2: a LinkedIn identifier is an opaque profile id, never shown.
            const name =
              connection?.username || (platform === "linkedin" ? null : connection?.accountIdentifier) || null;
            const connected = name ? `Connected: ${name}` : "Connected";
            const form = (label: string) => (
              <form action={action} method="post">
                <input type="hidden" name="platform" value={platform} />
                <Button type="submit" size="md">
                  {label}
                </Button>
              </form>
            );
            // R7-pages M2: LinkedIn connects whichever account this browser is
            // signed in to, without asking, so Reconnect first shows the
            // sign-out steps (as Settings does), then the sign-in. A plain
            // <details>: it works without JavaScript, like the rest of the page.
            const button =
              connection && platform === "linkedin" ? (
                <details className="min-w-0 max-w-sm flex-1 text-right">
                  <summary
                    className={cn(buttonVariants({ size: "md" }), "cursor-pointer list-none [&::-webkit-details-marker]:hidden")}
                  >
                    Reconnect
                  </summary>
                  <div className="mt-3 rounded-[var(--radius)] border p-3 text-left text-sm text-muted-foreground">
                    <ol className="list-decimal space-y-1.5 pl-5">
                      <li>
                        <a href={LINKEDIN_SIGN_OUT_URL} target="_blank" rel="noopener noreferrer" className="underline">
                          Open LinkedIn sign-out
                        </a>{" "}
                        and sign out in the new tab. If that tab shows a sign-in page instead, you&apos;re already
                        signed out: close it.
                      </li>
                      <li>{linkedInReconnectSignInStep(connectedAccountName(connection))}</li>
                    </ol>
                    <div className="mt-3 flex justify-end">{form("Continue")}</div>
                  </div>
                </details>
              ) : (
                form(connection ? "Reconnect" : "Connect")
              );
            return (
              <li key={platform} className="flex min-h-14 items-center justify-between gap-3 px-4 py-3">
                <span className="font-medium">{PLATFORM_LABELS[platform]}</span>
                {working && connection.reconnectSoon ? (
                  // R6 M1: it still works but can't be renewed and ends soon;
                  // the sign-in replaces it in place (server/connectLink/link.ts).
                  <div className="flex flex-wrap items-center justify-end gap-3">
                    <span className="text-right text-sm text-muted-foreground">
                      {connection.ended
                        ? `${name ? `${name}. ` : ""}It stopped working: press Reconnect.`
                        : // R8-pages L5: just reconnected with the same end date; the warning says what to do.
                          sameEndOn?.platform === platform
                          ? `${connected}. Ends ${formatDisplayDate(sameEndOn.expiresAt)}. LinkedIn kept this end date.`
                          : `${connected}. It stops working soon: press Reconnect to keep it posting.`}
                    </span>
                    {button}
                  </div>
                ) : working ? (
                  <span className="text-right text-sm text-muted-foreground">{connected}</span>
                ) : (
                  button
                )}
              </li>
            );
          })}
        </ul>
      </div>
    </ClientPageShell>
  );
}
