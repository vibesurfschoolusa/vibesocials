import type { Platform } from "@prisma/client";
import type { Metadata } from "next";

import { ClientPageShell } from "@/components/client-page-header";
import { ExternalLink } from "@/components/external-link";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { buttonVariants } from "@/components/ui/buttonVariants";
import { cn } from "@/lib/cn";
import {
  CONNECT_LINK_INACTIVE_MESSAGE,
  connectLinkPlatformConfigured,
  describeConnectLinkResult,
} from "@/lib/connectLink";
import { connectAgainSentence } from "@/lib/clientLinkLimit";
import { findClientPageLogo } from "@/lib/clientPageLogo";
import { SAME_END_PARAM, sameEndDateMessage } from "@/lib/connectionExpiry";
import { prisma } from "@/lib/db";
import {
  LOCATION_CLEARED_LINK_MESSAGE,
  LOCATION_CLEARED_PARAM,
  accountCheckFailedMessage,
  accountCheckFailedPlatform,
  connectedAccountName,
  connectionShownName,
  linkDifferentAccountMessage,
  linkedInReconnectSignInStep,
} from "@/lib/differentAccount";
import { LINKEDIN_SIGN_OUT_URL } from "@/lib/linkedinAccount";
import { differentAccountBanner, shownControl, signInButton } from "@/lib/oauthResult";
import { PLATFORM_LABELS, PLATFORM_ORDER } from "@/lib/platforms";
import { utcDisplayDateTime } from "@/lib/usageLimits";
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
      <ClientPageShell workspace={null} title="This link is not active">
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

  // R33 new-customer L2: every platform the link offers lost its app keys on
  // this site. Still an active link (findActiveConnectLink): the rows come back
  // when the keys do. Lead review: nothing to consent to, so only the sentence.
  if (platforms.length === 0) {
    return (
      <ClientPageShell workspace={{ name: link.workspaceName, logoUrl }} title="Connect your accounts">
        <p className="text-base">
          Nothing can be connected through this link right now. Ask the person who sent it for a new link.
        </p>
      </ClientPageShell>
    );
  }

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
  // Only LinkedIn's sign-in can't be renewed, as on Settings: a typed flag on another platform adds nothing.
  const sameEnd =
    succeeded === "linkedin" &&
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
  // R53 client-journey L1: its words say "press Reconnect", so only while the
  // row shows Reconnect; otherwise no sentence (differentAccountBanner).
  const rowShown = (platform: Platform) => shownControl(byPlatform.get(platform));
  const different = differentAccountBanner(outcome.get("error"), rowShown);
  const differentFrom = different?.told ? byPlatform.get(different.platform) : undefined;
  // R7-client-journey L4: the owners are emailed where the refusal happens
  // (server/connectLink/callback.ts, the choice route), never from this page,
  // which anyone holding the link can open with any query.
  const uncheckedPlatform = accountCheckFailedPlatform(outcome.get("error"));
  const uncheckedFrom = uncheckedPlatform ? byPlatform.get(uncheckedPlatform) : undefined;
  // R6 third review: a Business Profile reconnect whose location this Google
  // account can't use was saved with it cleared; the owner chooses it.
  // R34 client-journey L1: said only while there is still no location, as
  // Settings' gbpWithoutLocation, since a reload keeps the one-time flag.
  const locationCleared =
    outcome.get("success") === "google_business_profile_connected" &&
    first(query[LOCATION_CLEARED_PARAM]) !== null &&
    !working?.locationName;
  // R45 pages-a L7: a Connect press a limit refused comes back with its wait;
  // the platform is named only when it is one, so typed text is never shown.
  // R46 client-journey L1: the wait is its end, read against this request's
  // time, so a reload or Back after it has passed names only the step.
  const limitedValue = first(query.platform);
  const limitedPlatform = PLATFORM_ORDER.find((platform) => platform === limitedValue) ?? null;
  const limitSentence = connectAgainSentence(
    outcome.get("error"),
    first(query.until),
    (limitedPlatform && signInButton(shownControl(byPlatform.get(limitedPlatform)))) || "Connect",
    limitedPlatform ? PLATFORM_LABELS[limitedPlatform] : null,
    Date.now(),
  );
  const result = limitSentence
    ? { variant: "danger" as const, message: limitSentence }
    : locationCleared
    ? { variant: "success" as const, message: LOCATION_CLEARED_LINK_MESSAGE }
    : sameEnd?.expiresAt && working
      ? { variant: "warning" as const, message: sameEndDateMessage(working.platform) }
      : different
      ? differentFrom
        ? { variant: "danger" as const, message: linkDifferentAccountMessage(different.platform, connectedAccountName(differentFrom)) }
        : null
      : uncheckedFrom
        ? { variant: "danger" as const, message: accountCheckFailedMessage(connectedAccountName(uncheckedFrom)) }
        : describeConnectLinkResult(outcome, {
            locationKept: Boolean(working?.locationName),
            // R28 new-customer L6: the sentence names the button the row shows.
            shown: rowShown,
          });
  const sameEndOn = sameEnd?.expiresAt && working ? { platform: working.platform, expiresAt: sameEnd.expiresAt } : null;
  const pendingId = first(query.choose);
  // R40 review: the sign-in button each row below shows, for the choice's limit sentence.
  const choiceButtons: Record<string, string> = {};
  for (const platform of platforms) {
    const shown = signInButton(shownControl(byPlatform.get(platform)));
    if (shown) choiceButtons[platform] = shown;
  }
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
            <ConnectLinkChoice token={token} pendingId={pendingId} buttons={choiceButtons} />
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
            // R60 pages-a L2: the name Settings shows, by the same rule (never an opaque id).
            const name = connection ? connectionShownName(connection) : null;
            const connected = name ? `Connected: ${name}` : "Connected";
            // R56: the label starts with the visible text and names the platform, as the rows repeat.
            const form = (label: string, accessibleName = `${label} ${PLATFORM_LABELS[platform]}`) => (
              <form action={action} method="post">
                <input type="hidden" name="platform" value={platform} />
                <Button type="submit" size="md" aria-label={accessibleName}>
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
                    aria-label={`Reconnect ${PLATFORM_LABELS[platform]}`}
                    className={cn(buttonVariants({ size: "md" }), "cursor-pointer list-none [&::-webkit-details-marker]:hidden")}
                  >
                    Reconnect
                  </summary>
                  <div className="mt-3 rounded-[var(--radius)] border p-3 text-left text-sm text-muted-foreground">
                    <ol className="list-decimal space-y-1.5 pl-5">
                      <li>
                        <ExternalLink href={LINKEDIN_SIGN_OUT_URL} className="underline">
                          Open LinkedIn sign-out
                        </ExternalLink>{" "}
                        and sign out in the new tab. If that tab shows a sign-in page instead, you&apos;re already
                        signed out: close it.
                      </li>
                      <li>{linkedInReconnectSignInStep(connectedAccountName(connection))}</li>
                    </ol>
                    <div className="mt-3 flex justify-end">{form("Continue", `Continue to ${PLATFORM_LABELS[platform]}`)}</div>
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
                          ? // R11-pages L3: date and time in UTC, labelled; the owners' email gives their own zone.
                            `${connected}. Ends ${utcDisplayDateTime(sameEndOn.expiresAt)}. LinkedIn kept this end date.`
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
