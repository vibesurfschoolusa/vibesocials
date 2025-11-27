"use client";

import Link from "next/link";
import { signOut, useSession } from "next-auth/react";

export default function Home() {
  const { data: session } = useSession();
  const userEmail = session?.user?.email ?? "";

  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-blue-50 via-cyan-50 to-teal-50">
      <main className="w-full max-w-xl rounded-2xl bg-white p-10 shadow-xl border border-gray-100">
        <h1 className="mb-2 text-4xl font-bold bg-gradient-to-r from-blue-600 to-teal-600 bg-clip-text text-transparent">Vibe Socials</h1>
        <p className="mb-6 text-sm text-gray-600">Upload once, post everywhere.</p>
        {!session ? (
          <div className="space-y-4">
            <p className="text-base text-gray-700 leading-relaxed">
              Sign in to connect your social accounts and sync your content across multiple platforms.
            </p>
            <div className="flex gap-3">
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
        ) : (
          <div className="space-y-4">
            <p className="text-sm text-gray-700">
              Signed in as <span className="font-semibold text-blue-600">{userEmail}</span>
            </p>
            <div className="flex flex-col gap-3">
              <div className="flex flex-col gap-3 sm:flex-row">
                <Link
                  href="/connections"
                  className="flex-1 rounded-lg bg-gradient-to-r from-blue-600 to-blue-700 px-4 py-2.5 text-center text-sm font-semibold text-white hover:from-blue-700 hover:to-blue-800 transition-all shadow-md hover:shadow-lg"
                >
                  Connections
                </Link>
                <Link
                  href="/posts/new"
                  className="flex-1 rounded-lg border-2 border-blue-200 px-4 py-2.5 text-center text-sm font-semibold text-blue-700 hover:bg-blue-50 transition-all"
                >
                  Create post
                </Link>
              </div>
              <div className="flex flex-col gap-3 sm:flex-row">
                <Link
                  href="/reviews"
                  className="flex-1 rounded-lg border-2 border-green-200 px-4 py-2.5 text-center text-sm font-semibold text-green-700 hover:bg-green-50 transition-all"
                >
                  Google Reviews
                </Link>
                <Link
                  href="/settings"
                  className="flex-1 rounded-lg border-2 border-gray-200 px-4 py-2.5 text-center text-sm font-semibold text-gray-700 hover:bg-gray-50 transition-all"
                >
                  Settings
                </Link>
              </div>
            </div>
            <button
              type="button"
              onClick={async () => {
                await signOut({ callbackUrl: "/" });
              }}
              className="mt-2 text-xs text-gray-500 hover:text-gray-700 underline transition-colors"
            >
              Sign out
            </button>
          </div>
        )}
      </main>
    </div>
  );
}
