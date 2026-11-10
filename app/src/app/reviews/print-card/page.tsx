import { redirect } from "next/navigation";

import { prisma } from "@/lib/db";
import { getWorkspaceContext } from "@/lib/workspace";
import { savedNewReviewUri } from "@/server/googleReviews";

import { PrintCard } from "./print-card";

export const dynamic = "force-dynamic";

/**
 * The printable review card (2026-11-10), opened from the "Get more reviews"
 * panel. Any member may open it. It prints the review link the panel already
 * saved for the workspace and never asks Google itself.
 */
export default async function ReviewPrintCardPage() {
  const context = await getWorkspaceContext();
  if (!context) {
    redirect(`/login?callbackUrl=${encodeURIComponent("/reviews/print-card")}`);
  }

  const connection = await prisma.socialConnection.findFirst({
    where: { workspaceId: context.workspace.id, platform: "google_business_profile" },
    select: { metadata: true },
  });
  const metadata =
    connection?.metadata && typeof connection.metadata === "object" && !Array.isArray(connection.metadata)
      ? (connection.metadata as Record<string, unknown>)
      : {};
  const title = typeof metadata.locationTitle === "string" ? metadata.locationTitle.trim() : "";

  return (
    <PrintCard businessName={title || context.workspace.name} url={savedNewReviewUri(connection?.metadata)} />
  );
}
