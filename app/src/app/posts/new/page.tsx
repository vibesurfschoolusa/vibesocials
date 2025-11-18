import Link from "next/link";

import { getCurrentUser } from "@/lib/auth";
import { CreatePostForm } from "@/components/create-post-form";

export default async function NewPostPage() {
  const user = await getCurrentUser();

  if (!user) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-zinc-50">
        <div className="w-full max-w-md rounded-lg bg-white p-8 shadow">
          <p className="text-sm text-zinc-700">
            You need to be logged in to create posts.
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

  return (
    <div className="flex min-h-screen items-center justify-center bg-zinc-50">
      <div className="w-full max-w-3xl rounded-lg bg-white p-8 shadow">
        <div className="mb-4 flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-semibold">Create post</h1>
            <p className="mt-1 text-sm text-zinc-700">
              Upload a new image or video, or reuse something from your media library, then post to your connected platforms.
            </p>
          </div>
          <Link href="/" className="text-xs text-zinc-600 underline">
            Back to dashboard
          </Link>
        </div>

        <CreatePostForm />
      </div>
    </div>
  );
}
