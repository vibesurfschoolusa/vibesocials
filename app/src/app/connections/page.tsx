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

  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-blue-50 via-cyan-50 to-teal-50">
      <div className="w-full max-w-md rounded-2xl bg-white p-10 shadow-xl border border-gray-100">
        <p className="text-base text-gray-700">
          The connections page has been consolidated into the settings page.
        </p>
        <div className="mt-4 flex gap-3">
          <Link
            href="/settings"
            className="flex-1 rounded-lg bg-gradient-to-r from-blue-600 to-blue-700 px-4 py-2.5 text-center text-sm font-semibold text-white hover:from-blue-700 hover:to-blue-800 transition-all shadow-md hover:shadow-lg"
          >
            Go to settings
          </Link>
        </div>
      </div>
    </div>
  );
}
