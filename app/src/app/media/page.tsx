import Link from "next/link";

import { getCurrentUser } from "@/lib/auth";
import { MediaLibrary } from "@/components/media-library";

export default async function MediaPage() {
  const user = await getCurrentUser();

  if (!user) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-blue-50 via-cyan-50 to-teal-50">
        <div className="w-full max-w-md rounded-2xl bg-white p-10 shadow-xl border border-gray-100">
          <p className="text-base text-gray-700">
            You need to be logged in to manage your media library.
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
    <div className="min-h-screen bg-gradient-to-br from-blue-50 via-cyan-50 to-teal-50 py-12 px-4">
      <div className="mx-auto w-full max-w-4xl rounded-2xl bg-white p-10 shadow-xl border border-gray-100">
        <div className="mb-4 flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold bg-gradient-to-r from-blue-600 to-teal-600 bg-clip-text text-transparent">Media library</h1>
            <p className="mt-2 text-base text-gray-700">
              Upload videos or images once, then reuse them across posts and platforms.
            </p>
          </div>
          <Link href="/" className="text-sm text-gray-600 hover:text-blue-600 underline transition-colors">
            Back to dashboard
          </Link>
        </div>

        <MediaLibrary />
      </div>
    </div>
  );
}
