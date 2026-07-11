import { redirect } from "next/navigation";

import { getCurrentUser } from "@/lib/auth";
import { CreatePostForm } from "@/components/create-post-form";
import type { CaptionFooterUser } from "@/lib/captionFooter";

export default async function NewPostPage() {
  const user = await getCurrentUser();

  if (!user) {
    redirect(`/login?callbackUrl=${encodeURIComponent("/posts/new")}`);
  }

  // SEC-1: project only the two caption-footer fields the Preview section
  // needs (Roadmap Phase 7) so passwordHash/email never reach the client
  // component payload — same pattern as `settings/page.tsx`'s `UserSettings`
  // projection. Never pass the raw `user` row into CreatePostForm.
  const footerSettings: CaptionFooterUser = {
    companyWebsite: user.companyWebsite,
    defaultHashtags: user.defaultHashtags,
  };

  return (
    <div className="mx-auto max-w-2xl px-4 py-8 md:px-6">
      <div className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight text-foreground">Create post</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Upload a new image or video, then post to your connected platforms.
        </p>
      </div>

      <CreatePostForm footerSettings={footerSettings} />
    </div>
  );
}
