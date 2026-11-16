import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { prisma } from "@/lib/db";
import { getWorkspaceContext } from "@/lib/workspace";
import { savedNewReviewUri } from "@/server/googleReviews";

import { PrintCard } from "./print-card";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Review card | Vibe Socials",
};

/**
 * The printable review card (2026-11-10), opened from the "Get more reviews"
 * panel. Any member may open it. It prints the review link the panel already
 * saved for the workspace and never asks Google itself.
 *
 * R27 security-billing L2: the panel links it with `?workspaceId=` of the
 * workspace the Reviews page was rendered for; another workspace's id (a switch
 * in another tab) gets a plain page instead of the cookie workspace's card (a
 * reload of the Reviews page sends the active id). A
 * link without one (an old link, a bookmark) prints the active workspace's card.
 */
export default async function ReviewPrintCardPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sent = (await searchParams).workspaceId;
  const workspaceId = typeof sent === "string" && sent ? sent : null;
  const context = await getWorkspaceContext();
  if (!context) {
    const back = workspaceId ? `/reviews/print-card?workspaceId=${encodeURIComponent(workspaceId)}` : "/reviews/print-card";
    redirect(`/login?callbackUrl=${encodeURIComponent(back)}`);
  }

  if (workspaceId && workspaceId !== context.workspace.id) {
    return (
      <div className="mx-auto max-w-xl px-4 py-8">
        <h1 className="text-2xl font-bold tracking-tight text-foreground">Review card</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          This page was opened for another workspace. Go back, reload that page, then open Print card again.
        </p>
      </div>
    );
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
