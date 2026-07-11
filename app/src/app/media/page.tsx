import { redirect } from "next/navigation";

import { getCurrentUser } from "@/lib/auth";
import { MediaLibrary } from "@/components/media-library";

export default async function MediaPage() {
  const user = await getCurrentUser();

  if (!user) {
    redirect(`/login?callbackUrl=${encodeURIComponent("/media")}`);
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
