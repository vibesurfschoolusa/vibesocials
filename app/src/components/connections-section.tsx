"use client";

import { Suspense } from "react";
import {
  Facebook,
  Instagram,
  Linkedin,
  MapPin,
  Music2,
  Twitter,
  Youtube,
  type LucideIcon,
} from "lucide-react";

import type { ConnectionSummary } from "@/lib/connectionSummary";
import { Button, ButtonLink } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { GoogleBusinessLocationForm } from "./google-business-location-form";
import { ConnectionActions } from "./connection-actions";
import { LinkedInSetupDialog } from "./linkedin-setup-dialog";

interface PlatformConfig {
  key: string;
  label: string;
  /** OAuth start route. Absent for not-yet-implemented platforms ("Coming soon"). */
  href?: string;
  icon: LucideIcon;
  description: string;
}

// Single source of truth for the connect list — the 7 rows used to be
// copy-pasted. Each platform's OAuth start route is `/api/auth/{key}/start`.
const PLATFORMS: PlatformConfig[] = [
  {
    key: "tiktok",
    label: "TikTok",
    href: "/api/auth/tiktok/start",
    icon: Music2,
    description:
      "Connect your TikTok account. Videos are sent to your TikTok inbox as drafts — you finish and publish them in the TikTok app.",
  },
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
    key: "linkedin",
    label: "LinkedIn",
    href: "/api/auth/linkedin/start",
    icon: Linkedin,
    description: "Connect your LinkedIn profile to share posts with your network.",
  },
  {
    key: "instagram",
    label: "Instagram",
    href: "/api/auth/instagram/start",
    icon: Instagram,
    description: "Connect your Instagram Business account to post photos and videos.",
  },
  {
    key: "google_business_profile",
    label: "Google Business Profile",
    href: "/api/auth/google_business_profile/start",
    icon: MapPin,
    description:
      "Connect your Google Business Profile so new photos appear on your Maps listing.",
  },
  {
    key: "facebook_page",
    label: "Facebook Page",
    href: "/api/auth/facebook_page/start",
    icon: Facebook,
    description:
      "Connect your Facebook Page so Vibe Socials can post photos directly to your page.",
  },
];

interface ConnectionsSectionProps {
  connections: ConnectionSummary[];
  /**
   * Team Workspaces (Task 7, design §7): connections are workspace-owned and
   * owner-only to mutate. A member sees the same rows (health/connected
   * status stays visible) but no Connect/Disconnect/Switch/Reconnect
   * controls, and no GBP location picker (also a mutation).
   */
  readOnly?: boolean;
}

export function ConnectionsSection({ connections, readOnly = false }: ConnectionsSectionProps) {
  return (
    <>
      {!readOnly ? (
        <Suspense fallback={null}>
          <LinkedInSetupDialog />
        </Suspense>
      ) : null}

      <div className="flex flex-col gap-3">
        {PLATFORMS.map(({ key, label, href, icon: Icon, description }) => {
          const connection = connections.find((c) => c.platform === key);
          const isGoogleBusinessProfile = key === "google_business_profile";
          const username = connection?.username ?? connection?.accountIdentifier;
          const locationName = connection?.locationName ?? null;

          return (
            <Card key={key} className="p-4 sm:p-5">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex min-w-0 flex-1 items-start gap-3">
                  <span
                    aria-hidden
                    className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[var(--radius)] bg-muted text-muted-foreground"
                  >
                    <Icon className="h-4 w-4" />
                  </span>
                  <div className="min-w-0">
                    <div className="text-base font-semibold text-foreground">{label}</div>
                    <p className="mt-0.5 break-words text-sm text-muted-foreground">
                      {connection ? `Connected as ${username}` : description}
                    </p>
                  </div>
                </div>

                <div className="flex shrink-0 flex-wrap items-center gap-2 sm:justify-end">
                  {connection ? (
                    <ConnectionActions
                      platform={key}
                      isConnected
                      needsReconnect={connection.needsReconnect}
                      readOnly={readOnly}
                    />
                  ) : readOnly ? null : href ? (
                    <ButtonLink href={href} variant="outline" size="sm">
                      Connect
                    </ButtonLink>
                  ) : (
                    <Button size="sm" variant="secondary" disabled>
                      Coming soon
                    </Button>
                  )}
                </div>
              </div>

              {isGoogleBusinessProfile && connection && !readOnly ? (
                <div className="mt-4 border-t border-border pt-4">
                  <GoogleBusinessLocationForm initialLocationName={locationName} />
                </div>
              ) : null}
            </Card>
          );
        })}
      </div>
    </>
  );
}
