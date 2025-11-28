"use client";

import Link from "next/link";
import type { SocialConnection } from "@prisma/client";
import { GoogleBusinessLocationForm } from "./google-business-location-form";
import { ConnectionActions } from "./connection-actions";
import { LinkedInSetupDialog } from "./linkedin-setup-dialog";

const PLATFORM_LABELS = {
  tiktok: "TikTok",
  youtube: "YouTube",
  x: "X (Twitter)",
  linkedin: "LinkedIn",
  instagram: "Instagram",
  google_business_profile: "Google Business Profile (Maps)",
} as const;

type PlatformKey = keyof typeof PLATFORM_LABELS;

interface ConnectionsSectionProps {
  connections: SocialConnection[];
}

export function ConnectionsSection({ connections }: ConnectionsSectionProps) {
  return (
    <>
      <LinkedInSetupDialog />
      <div className="bg-white rounded-lg shadow-lg p-6">
      <div className="space-y-4">
        {(Object.keys(PLATFORM_LABELS) as PlatformKey[]).map((platform) => {
          const label = PLATFORM_LABELS[platform];
          const connection = connections.find((c) => c.platform === platform);

          const isGoogleBusinessProfile = platform === "google_business_profile";
          const isTikTok = platform === "tiktok";
          const isYouTube = platform === "youtube";
          const isInstagram = platform === "instagram";
          const isLinkedIn = platform === "linkedin";
          const isX = platform === "x";

          const locationName = (connection?.metadata as any)?.locationName ?? null;
          const username = (connection?.metadata as any)?.username ?? connection?.accountIdentifier;

          return (
            <div
              key={platform}
              className="flex flex-col gap-3 rounded-xl border-2 border-gray-200 px-5 py-4 hover:border-blue-200 transition-all bg-gradient-to-r from-white to-gray-50"
            >
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-base font-semibold text-gray-900">{label}</div>
                  <div className="text-sm text-gray-600">
                    {connection
                      ? `Connected as ${username}`
                      : isGoogleBusinessProfile
                      ? "Connect your Google Business Profile so new photos appear on your Maps listing."
                      : isTikTok
                      ? "Connect your TikTok account so Vibe Socials can upload videos to your inbox."
                      : isYouTube
                      ? "Connect your YouTube channel to upload videos directly."
                      : isInstagram
                      ? "Connect your Instagram Business account to post photos and videos."
                      : isLinkedIn
                      ? "Connect your LinkedIn profile to share posts with your network."
                      : isX
                      ? "Connect your X (Twitter) account to post tweets with media."
                      : "Not connected yet (scaffolded; implementation pending)."}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {connection ? (
                    <ConnectionActions
                      platform={platform}
                      isConnected={true}
                      isGoogleBusinessProfile={isGoogleBusinessProfile}
                    />
                  ) : isGoogleBusinessProfile ? (
                    <Link
                      href="/api/auth/google_business_profile/start"
                      className="rounded-lg bg-gradient-to-r from-blue-600 to-blue-700 px-4 py-2 text-sm font-semibold text-white hover:from-blue-700 hover:to-blue-800 transition-all shadow-sm hover:shadow-md"
                    >
                      Connect
                    </Link>
                  ) : isTikTok ? (
                    <Link
                      href="/api/auth/tiktok/start"
                      className="rounded-lg bg-gradient-to-r from-blue-600 to-blue-700 px-4 py-2 text-sm font-semibold text-white hover:from-blue-700 hover:to-blue-800 transition-all shadow-sm hover:shadow-md"
                    >
                      Connect
                    </Link>
                  ) : isYouTube ? (
                    <Link
                      href="/api/auth/youtube/start"
                      className="rounded-lg bg-gradient-to-r from-blue-600 to-blue-700 px-4 py-2 text-sm font-semibold text-white hover:from-blue-700 hover:to-blue-800 transition-all shadow-sm hover:shadow-md"
                    >
                      Connect
                    </Link>
                  ) : isInstagram ? (
                    <Link
                      href="/api/auth/instagram/start"
                      className="rounded-lg bg-gradient-to-r from-blue-600 to-blue-700 px-4 py-2 text-sm font-semibold text-white hover:from-blue-700 hover:to-blue-800 transition-all shadow-sm hover:shadow-md"
                    >
                      Connect
                    </Link>
                  ) : isLinkedIn ? (
                    <Link
                      href="/api/auth/linkedin/start"
                      className="rounded-lg bg-gradient-to-r from-blue-600 to-blue-700 px-4 py-2 text-sm font-semibold text-white hover:from-blue-700 hover:to-blue-800 transition-all shadow-sm hover:shadow-md"
                    >
                      Connect
                    </Link>
                  ) : isX ? (
                    <Link
                      href="/api/auth/x/start"
                      className="rounded-lg bg-gradient-to-r from-blue-600 to-blue-700 px-4 py-2 text-sm font-semibold text-white hover:from-blue-700 hover:to-blue-800 transition-all shadow-sm hover:shadow-md"
                    >
                      Connect
                    </Link>
                  ) : (
                    <button
                      type="button"
                      className="rounded-lg bg-gray-100 px-4 py-2 text-sm font-medium text-gray-500"
                      disabled
                    >
                      Coming soon
                    </button>
                  )}
                </div>
              </div>
              {isGoogleBusinessProfile && connection && (
                <GoogleBusinessLocationForm initialLocationName={locationName} />
              )}
            </div>
          );
        })}
      </div>
    </div>
    </>
  );
}
