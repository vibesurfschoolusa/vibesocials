import Link from "next/link";

import { prisma } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { GoogleBusinessLocationForm } from "@/components/google-business-location-form";
import { ConnectionActions } from "@/components/connection-actions";

const PLATFORM_LABELS = {
  tiktok: "TikTok",
  youtube: "YouTube",
  x: "X (Twitter)",
  linkedin: "LinkedIn",
  instagram: "Instagram",
  google_business_profile: "Google Business Profile (Maps)",
} as const;

type PlatformKey = keyof typeof PLATFORM_LABELS;

export default async function ConnectionsPage() {
  const user = await getCurrentUser();

  if (!user) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-blue-50 via-cyan-50 to-teal-50">
        <div className="w-full max-w-md rounded-2xl bg-white p-10 shadow-xl border border-gray-100">
          <p className="text-base text-gray-700">
            You need to be logged in to manage connections.
          </p>
          <div className="mt-4 flex gap-3">
            <Link
              href="/login"
              className="flex-1 rounded-lg bg-gradient-to-r from-blue-600 to-blue-700 px-4 py-2.5 text-center text-sm font-semibold text-white hover:from-blue-700 hover:to-blue-800 transition-all shadow-md hover:shadow-lg"
            >
              Log in
            </Link>
            <Link
              href="/register"
              className="flex-1 rounded-lg border-2 border-blue-200 px-4 py-2.5 text-center text-sm font-semibold text-blue-700 hover:bg-blue-50 transition-all"
            >
              Create account
            </Link>
          </div>
        </div>
      </div>
    );
  }

  const connections = await prisma.socialConnection.findMany({
    where: { userId: user.id },
  });

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 via-cyan-50 to-teal-50 py-12 px-4">
      <div className="mx-auto w-full max-w-3xl rounded-2xl bg-white p-10 shadow-xl border border-gray-100">
        <div className="mb-4 flex items-center justify-between">
          <h1 className="text-3xl font-bold bg-gradient-to-r from-blue-600 to-teal-600 bg-clip-text text-transparent">Connections</h1>
          <Link href="/" className="text-sm text-gray-600 hover:text-blue-600 underline transition-colors">
            Back to dashboard
          </Link>
        </div>
        <p className="mb-8 text-base text-gray-700 leading-relaxed">
          Connect your social accounts so Vibe Social Sync can publish on your behalf.
        </p>
        <div className="space-y-4">
          {(Object.keys(PLATFORM_LABELS) as PlatformKey[]).map((platform) => {
            const label = PLATFORM_LABELS[platform];
            const connection = connections.find((c) => c.platform === platform);

            const isGoogleBusinessProfile = platform === "google_business_profile";
            const isTikTok = platform === "tiktok";
            const isYouTube = platform === "youtube";

            const locationName = (connection?.metadata as any)?.locationName ?? null;

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
                        ? `Connected as ${connection.accountIdentifier}`
                        : isGoogleBusinessProfile
                        ? "Connect your Google Business Profile so new photos appear on your Maps listing."
                        : isTikTok
                        ? "Connect your TikTok account so Vibe Social Sync can upload videos to your inbox."
                        : isYouTube
                        ? "Connect your YouTube channel to upload videos directly."
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
    </div>
  );
}
