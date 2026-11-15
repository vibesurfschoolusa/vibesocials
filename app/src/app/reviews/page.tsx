import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { prisma } from "@/lib/db";
import { getWorkspaceContext } from "@/lib/workspace";
import { ReviewsView } from "./reviews-view";

export const metadata: Metadata = { title: "Reviews | Vibe Socials" };

// Server-side auth gate (matches queue/activity): signed-out users are
// redirected before the client view ever fetches — no more raw
// "Unauthorized" error page.
export default async function ReviewsPage() {
  const context = await getWorkspaceContext();
  if (!context) {
    redirect(`/login?callbackUrl=${encodeURIComponent("/reviews")}`);
  }
  // The Google location Settings saved for posts, so the page opens on it
  // (go-live check 2026-11-11). Only its name leaves the server.
  const connection = await prisma.socialConnection.findFirst({
    where: { workspaceId: context.workspace.id, platform: "google_business_profile" },
    select: { metadata: true },
  });
  const metadata = connection?.metadata as { locationName?: unknown } | null | undefined;
  const savedLocation =
    typeof metadata?.locationName === "string" && metadata.locationName ? metadata.locationName : null;
  // key: remount on a workspace switch (router.refresh keeps client state),
  // so the previous workspace's selection and reviews never carry over.
  return <ReviewsView key={context.workspace.id} savedLocation={savedLocation} />;
}
