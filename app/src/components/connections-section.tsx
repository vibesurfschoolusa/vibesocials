"use client";

import { Suspense, useCallback } from "react";
import { useRouter } from "next/navigation";
import {
  Facebook,
  Instagram,
  Linkedin,
  MapPin,
  Music2,
  Pin,
  Twitter,
  Youtube,
  type LucideIcon,
} from "lucide-react";

import type { ConnectionSummary } from "@/lib/connectionSummary";
import { connectionShownName } from "@/lib/differentAccount";
import {
  PLATFORM_CONNECT_REQUIREMENTS,
  PLATFORM_MATURITY_NOTES,
} from "@/lib/platforms";
import { PLATFORM_GUIDES, platformHelpHref } from "@/lib/platformGuides";
import { withWorkspaceId } from "@/lib/workspaceChanged";
import type { Platform } from "@prisma/client";
import { ExternalLink, NEW_TAB_HINT } from "@/components/external-link";
import { Badge } from "@/components/ui/badge";
import { Button, ButtonLink } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { GoogleBusinessLocationForm } from "./google-business-location-form";
import { ConnectionActions } from "./connection-actions";
import { useResetOnReturnFromCache } from "./returnFromCache";
import { SignInAgainLink } from "./gbp-sign-in-link";
import { LinkedInConnectButton } from "./linkedin-account-dialog";
import { LinkedInSetupDialog } from "./linkedin-setup-dialog";
import { PendingConnectionDialog } from "./pending-connection-dialog";
import { GBP_CARD_ID, gbpSignInUrl } from "@/lib/gbpSignIn";

interface PlatformConfig {
  key: Platform;
  label: string;
  /** OAuth start route. Absent for not-yet-implemented platforms ("Coming soon"). */
  href?: string;
  icon: LucideIcon;
  description: string;
}

// Single source of truth for the connect list — the 7 rows used to be
// copy-pasted. Each platform's OAuth start route is `/api/auth/{key}/start`.
// Ordered by connection friction, lowest first: platforms a personal account
// can link right now (YouTube, X) lead, so a new user's first Connect click
// succeeds; the ones needing a business/creator account or pending platform
// approval (see PLATFORM_CONNECT_REQUIREMENTS) follow.
const PLATFORMS: PlatformConfig[] = [
  {
    key: "youtube",
    label: "YouTube",
    href: "/api/auth/youtube/start",
    icon: Youtube,
    description: "Connect your YouTube channel to upload videos directly.",
  },
  {
    key: "x",
    label: "X",
    href: "/api/auth/x/start",
    icon: Twitter,
    description: "Connect your X (Twitter) account to post tweets with media.",
  },
  {
    key: "tiktok",
    label: "TikTok",
    href: "/api/auth/tiktok/start",
    icon: Music2,
    description:
      "Connect your TikTok account to post videos to it directly.",
  },
  {
    key: "pinterest",
    label: "Pinterest",
    href: "/api/auth/pinterest/start",
    icon: Pin,
    description:
      "Connect your Pinterest account to publish photos and videos as Pins on one of your boards.",
  },
  {
    key: "instagram",
    label: "Instagram",
    href: "/api/auth/instagram/start",
    icon: Instagram,
    description: "Connect your Instagram Business account to post photos and videos.",
  },
  {
    key: "facebook_page",
    label: "Facebook Page",
    href: "/api/auth/facebook_page/start",
    icon: Facebook,
    description:
      "Connect your Facebook Page so Vibe Socials can post photos and videos to it.",
  },
  {
    key: "linkedin",
    label: "LinkedIn",
    href: "/api/auth/linkedin/start",
    icon: Linkedin,
    description: "Connect the LinkedIn company page you administer, to post as your company.",
  },
  {
    key: "google_business_profile",
    label: "Google Business Profile",
    href: "/api/auth/google_business_profile/start",
    icon: MapPin,
    description:
      "Connect your Google Business Profile so new photos appear on your Maps listing.",
  },
];

interface ConnectionsSectionProps {
  /**
   * The workspace this page was rendered for (F3). Every connect, disconnect,
   * switch and location save sends it, and the routes refuse any other: the
   * active workspace is one cookie every tab shares.
   */
  workspaceId: string;
  connections: ConnectionSummary[];
  /**
   * Team Workspaces (Task 7, design §7): connections are workspace-owned and
   * owner-only to mutate. A member sees the same rows (health/connected
   * status stays visible) but no Connect/Disconnect/Switch/Reconnect
   * controls, and no GBP location picker (also a mutation).
   */
  readOnly?: boolean;
  /**
   * Platforms this deployment can't connect yet (app/settings/page.tsx:
   * Pinterest, until its app credentials are set). Not listed, unless the
   * workspace already has that connection, which stays visible and removable.
   */
  unavailablePlatforms?: readonly Platform[];
  /**
   * R6-pages M1: connected platforms inside their expiry warning window
   * (lib/connectionExpiry.ts, decided on the server): their row offers
   * Reconnect in place.
   */
  reconnectSoon?: readonly Platform[];
  /** Of those, the ones whose end date has passed: platform -> end date (ISO). */
  endedAt?: Partial<Record<Platform, string>>;
  /** R8-pages L5: of those, one a reconnect just left with the same end date: platform -> end date (ISO). */
  sameEndAt?: Partial<Record<Platform, string>>;
  /** R13-pages L3: of those, the ones still ahead: platform -> end date (ISO). */
  endsAt?: Partial<Record<Platform, string>>;
}

export function ConnectionsSection({
  workspaceId,
  connections,
  readOnly = false,
  unavailablePlatforms = [],
  reconnectSoon = [],
  endedAt = {},
  sameEndAt = {},
  endsAt = {},
}: ConnectionsSectionProps) {
  // R37 new-customer and lead follow-up: Switch account disconnects, then
  // leaves the page; Back can restore it from the cache with the rows still
  // saying "Connected as ...". One refresh here for all the rows.
  const router = useRouter();
  const refreshServerData = useCallback(() => router.refresh(), [router]);
  useResetOnReturnFromCache(refreshServerData, undefined);

  return (
    <>
      {!readOnly ? (
        <Suspense fallback={null}>
          <LinkedInSetupDialog workspaceId={workspaceId} />
          {/* ?choose=<id>: a connect found several Pages/accounts to pick from. */}
          <PendingConnectionDialog workspaceId={workspaceId} />
        </Suspense>
      ) : null}

      <div className="flex flex-col gap-3">
        {PLATFORMS.map(({ key, label, href, icon: Icon, description }) => {
          const connection = connections.find((c) => c.platform === key);
          if (!connection && unavailablePlatforms.includes(key)) return null;
          const isGoogleBusinessProfile = key === "google_business_profile";
          // A Business Profile has no account name to show until a location is
          // chosen (lib/connectionSummary.ts names it after that location).
          // R60 pages-a L2: the one rule for the name shown (never an opaque
          // id); a row with none says "Connected" instead.
          const username = connection ? connectionShownName(connection) : null;
          const locationName = connection?.locationName ?? null;

          return (
            // JJ3 lead review: owner links from Google failures land on this card (lib/gbpSignIn.ts).
            <Card
              key={key}
              id={isGoogleBusinessProfile ? GBP_CARD_ID : undefined}
              // The same scroll margin as Settings' other anchors (settings/page.tsx), clear of the header.
              className={isGoogleBusinessProfile ? "scroll-mt-32 p-4 sm:p-5 lg:scroll-mt-20" : "p-4 sm:p-5"}
            >
              {/* R7 review 1: stacked below xl (name on top, the state and
                  buttons below, wrapping), so the name column never
                  collapses; side by side from xl, the name keeping 12rem. */}
              <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
                <div className="flex min-w-0 flex-1 items-start gap-3 xl:min-w-[12rem]">
                  <span
                    aria-hidden
                    className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[var(--radius)] bg-muted text-muted-foreground"
                  >
                    <Icon className="h-4 w-4" />
                  </span>
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-base font-semibold text-foreground">
                        {label}
                      </span>
                      {/* Requirement badge only while unconnected — once the
                          account is linked the requirement is proven met. */}
                      {!connection && PLATFORM_CONNECT_REQUIREMENTS[key] ? (
                        <Badge variant="neutral">
                          {PLATFORM_CONNECT_REQUIREMENTS[key]}
                        </Badge>
                      ) : null}
                    </div>
                    <p className="mt-0.5 break-words text-sm text-muted-foreground">
                      {connection
                        ? username
                          ? `Connected as ${username}`
                          : isGoogleBusinessProfile
                            ? locationName
                              ? // R13 L2: chosen, but its title isn't read yet (gbpLocationTitle.ts).
                                "Connected. Posts go to the chosen Maps location."
                              : readOnly
                                ? // R12 L2: the location form below is the owner's only.
                                  "Connected. The workspace owner chooses the Maps location."
                                : "Connected. Choose the Maps location to post to below."
                            : "Connected"
                        : readOnly
                          ? // R11-pages L2: a member can't connect; say who can.
                            "Not connected. The workspace owner can connect it."
                          : description}
                    </p>
                    {PLATFORM_MATURITY_NOTES[key] ? (
                      <p className="mt-1 break-words text-xs text-muted-foreground/90">
                        {PLATFORM_MATURITY_NOTES[key]}
                      </p>
                    ) : null}
                    {/* Said before Connect: a platform still reviewing the app
                        refuses or limits newcomers (lib/platformGuides.ts). */}
                    {!connection && !readOnly && PLATFORM_GUIDES[key].status ? (
                      <p className="mt-1 break-words text-xs text-muted-foreground">
                        {PLATFORM_GUIDES[key].status}
                      </p>
                    ) : null}
                    {!connection && !readOnly ? (
                      <ExternalLink
                        href={platformHelpHref(key)}
                        aria-label={`How to connect ${label} ${NEW_TAB_HINT}`}
                        className="mt-1 inline-block text-xs font-medium text-primary underline-offset-4 hover:underline"
                      >
                        How to connect
                      </ExternalLink>
                    ) : null}
                  </div>
                </div>

                {/* R7-pages L7: never shrink-0, so an Ended sentence and three
                    buttons wrap inside the card instead of pushing past it. */}
                <div className="flex min-w-0 flex-wrap items-center gap-2 xl:justify-end">
                  {connection ? (
                    <ConnectionActions
                      platform={key}
                      workspaceId={workspaceId}
                      isConnected
                      needsReconnect={connection.needsReconnect}
                      reconnectSoon={reconnectSoon.includes(key)}
                      endedAt={endedAt[key] ?? null}
                      sameEndAt={sameEndAt[key] ?? null}
                      endsAt={endsAt[key] ?? null}
                      readOnly={readOnly}
                      accountName={username ?? undefined}
                    />
                  ) : readOnly ? null : key === "linkedin" ? (
                    // LinkedIn reuses whichever account is signed in to
                    // linkedin.com: offer to sign out first (lib/linkedinAccount.ts).
                    <LinkedInConnectButton workspaceId={workspaceId} />
                  ) : href ? (
                    <ButtonLink
                      href={withWorkspaceId(href, workspaceId)}
                      variant="outline"
                      size="sm"
                      aria-label={`Connect ${label}`}
                    >
                      Connect
                    </ButtonLink>
                  ) : (
                    <Button size="sm" variant="secondary" disabled aria-label={`Coming soon: ${label}`}>
                      Coming soon
                    </Button>
                  )}
                </div>
              </div>

              {isGoogleBusinessProfile && connection && !readOnly ? (
                <div className="mt-4 border-t border-border pt-4">
                  {/* LL1's publish 403 sends the owner here to sign in again
                      (lib/publishFailureText.ts). Where the card shows
                      Reconnect, that is the one step. */}
                  {!connection.needsReconnect && !reconnectSoon.includes(key) ? (
                    <div className="mb-4 flex flex-col items-start gap-2">
                      <p className="text-sm text-muted-foreground">
                        If Google refuses posts or reviews for this listing, sign in again with the Google
                        account that manages it. The listing&apos;s numbers are kept.
                      </p>
                      <SignInAgainLink href={gbpSignInUrl(workspaceId)} />
                    </div>
                  ) : null}
                  <GoogleBusinessLocationForm
                    workspaceId={workspaceId}
                    initialLocationName={locationName}
                    initialLocationTitle={connection.username}
                  />
                </div>
              ) : null}
            </Card>
          );
        })}
      </div>
    </>
  );
}
