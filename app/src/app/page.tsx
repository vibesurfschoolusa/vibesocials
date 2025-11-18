"use client";

import Link from "next/link";
import { signOut, useSession } from "next-auth/react";

export default function Home() {
  const { data: session } = useSession();
  const userEmail = session?.user?.email ?? "";

  return (
    <div className="flex min-h-screen items-center justify-center bg-zinc-50 font-sans">
      <main className="w-full max-w-xl rounded-lg bg-white p-8 shadow">
        <h1 className="mb-4 text-2xl font-semibold">Vibe Social Sync</h1>
        {!session ? (
          <div className="space-y-4">
            <p className="text-sm text-zinc-700">
              Sign in to connect your social accounts and sync your content.
            </p>
            <div className="flex gap-3">
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
        ) : (
          <div className="space-y-4">
            <p className="text-sm text-zinc-700">
              Signed in as <span className="font-medium">{userEmail}</span>
            </p>
            <div className="flex flex-col gap-3 sm:flex-row">
              <Link
                href="/connections"
                className="flex-1 rounded bg-black px-4 py-2 text-center text-sm font-medium text-white hover:bg-zinc-800"
              >
                Connections
              </Link>
              <Link
                href="/posts/new"
                className="flex-1 rounded border border-zinc-300 px-4 py-2 text-center text-sm font-medium text-zinc-900 hover:bg-zinc-50"
              >
                Create post
              </Link>
            </div>
            <button
              type="button"
              onClick={async () => {
                await signOut({ callbackUrl: "/" });
              }}
              className="mt-2 text-xs text-zinc-600 underline"
            >
              Sign out
            </button>
          </div>
        )}
      </main>
    </div>
  );
}
