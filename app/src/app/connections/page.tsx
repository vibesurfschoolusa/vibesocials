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
      <div className="flex min-h-screen items-center justify-center bg-zinc-50">
        <div className="w-full max-w-md rounded-lg bg-white p-8 shadow">
          <p className="text-sm text-zinc-700">
            You need to be logged in to manage connections.
          </p>
          <div className="mt-4 flex gap-3">
            <Link
              href="/login"
              className="flex-1 rounded bg-black px-4 py-2 text-center text-sm font-medium text-white hover:bg-zinc-800"
            >
              Log in
            </Link>
            <Link
              href="/register"
              className="flex-1 rounded border border-zinc-300 px-4 py-2 text-center text-sm font-medium text-zinc-900 hover:bg-zinc-50"
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
    <div className="flex min-h-screen items-center justify-center bg-zinc-50">
      <div className="w-full max-w-2xl rounded-lg bg-white p-8 shadow">
        <div className="mb-4 flex items-center justify-between">
          <h1 className="text-2xl font-semibold">Connections</h1>
          <Link href="/" className="text-xs text-zinc-600 underline">
            Back to dashboard
          </Link>
        </div>
        <p className="mb-6 text-sm text-zinc-700">
          Connect your social accounts so Vibe Social Sync can publish on your behalf.
        </p>
        <div className="space-y-4">
          {(Object.keys(PLATFORM_LABELS) as PlatformKey[]).map((platform) => {
            const label = PLATFORM_LABELS[platform];
            const connection = connections.find((c) => c.platform === platform);

            const isGoogleBusinessProfile = platform === "google_business_profile";
            const isTikTok = platform === "tiktok";

            const locationName = (connection?.metadata as any)?.locationName ?? null;

            return (
              <div
                key={platform}
                className="flex flex-col gap-2 rounded border border-zinc-200 px-4 py-3"
              >
                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-sm font-medium">{label}</div>
                    <div className="text-xs text-zinc-600">
                      {connection
                        ? `Connected as ${connection.accountIdentifier}`
                        : isGoogleBusinessProfile
                        ? "Connect your Google Business Profile so new photos appear on your Maps listing."
                        : isTikTok
                        ? "Connect your TikTok account so Vibe Social Sync can upload videos to your inbox."
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
                        className="rounded bg-black px-3 py-1 text-xs font-medium text-white hover:bg-zinc-800"
                      >
                        Connect
                      </Link>
                    ) : isTikTok ? (
                      <Link
                        href="/api/auth/tiktok/start"
                        className="rounded bg-black px-3 py-1 text-xs font-medium text-white hover:bg-zinc-800"
                      >
                        Connect
                      </Link>
                    ) : (
                      <button
                        type="button"
                        className="rounded bg-zinc-200 px-3 py-1 text-xs font-medium text-zinc-700"
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
