import Link from "next/link";

import { getCurrentUser } from "@/lib/auth";
import { CreatePostForm } from "@/components/create-post-form";
import { buttonVariants } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

export default async function NewPostPage() {
  const user = await getCurrentUser();

  if (!user) {
    return (
      <div className="mx-auto flex min-h-[60vh] max-w-md items-center px-4 py-12">
        <Card className="w-full p-8">
          <p className="text-base text-foreground">
            You need to be logged in to create posts.
          </p>
          <div className="mt-6 flex gap-3">
            <Link
              href="/login"
              className={buttonVariants({ variant: "primary", className: "flex-1" })}
            >
              Log in
            </Link>
            <Link
              href="/register"
              className={buttonVariants({ variant: "outline", className: "flex-1" })}
            >
              Create account
            </Link>
          </div>
        </Card>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl px-4 py-8 md:px-6">
      <div className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight text-foreground">Create post</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Upload a new image or video, then post to your connected platforms.
        </p>
      </div>

      <CreatePostForm />
    </div>
  );
}
