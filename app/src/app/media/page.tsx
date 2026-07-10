import Link from "next/link";
import { Lock } from "lucide-react";

import { getCurrentUser } from "@/lib/auth";
import { MediaLibrary } from "@/components/media-library";
import { buttonVariants } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";

export default async function MediaPage() {
  const user = await getCurrentUser();

  if (!user) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background px-4">
        <h1 className="sr-only">Media library</h1>
        <EmptyState
          icon={<Lock />}
          title="Sign in to manage your media"
          description="Log in or create an account to upload and organize the media you post across platforms."
          action={
            <div className="flex flex-col gap-3 sm:flex-row">
              <Link
                href="/login"
                className={buttonVariants({ variant: "primary" })}
              >
                Log in
              </Link>
              <Link
                href="/register"
                className={buttonVariants({ variant: "outline" })}
              >
                Create account
              </Link>
            </div>
          }
        />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 md:px-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-foreground">
          Media library
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Upload videos or images once, then reuse them across posts and platforms.
        </p>
      </div>

      <div className="mt-8">
        <MediaLibrary />
      </div>
    </div>
  );
}
