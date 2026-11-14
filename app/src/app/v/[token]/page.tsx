import type { Metadata } from "next";

import { ClientPageShell } from "@/components/client-page-header";
import { findClientPageLogo } from "@/lib/clientPageLogo";
import { REVIEW_LINK_INACTIVE_MESSAGE } from "@/lib/reviewLink";
import { findActiveReviewLink } from "@/server/reviewLink";

import { ReviewLinkView } from "./review-link-view";

/**
 * /v/[token] — a workspace's client review link (2026-11-10). Open signed out
 * (proxy.ts isPublicPath, nav.ts PUBLIC_ROUTE_PREFIXES: no app shell). Shows the
 * workspace's name; the posts come from GET /api/review-link/[token], which is
 * rate limited. An unknown and a revoked link get the same single sentence. The
 * token is the only thing the list is given.
 */

interface ReviewLinkPageProps {
  params: Promise<{ token: string }>;
}

export const metadata: Metadata = {
  title: "Upcoming posts",
  robots: { index: false, follow: false },
  // The token is in the address: never pass it on to another site.
  referrer: "no-referrer",
};

export default async function ReviewLinkPage({ params }: ReviewLinkPageProps) {
  const { token } = await params;
  const link = await findActiveReviewLink(token);

  if (!link) {
    return (
      <ClientPageShell workspace={null} width="2xl">
        <p className="text-base">{REVIEW_LINK_INACTIVE_MESSAGE}</p>
      </ClientPageShell>
    );
  }

  const logoUrl = await findClientPageLogo(link.workspaceId);
  return (
    <ClientPageShell workspace={{ name: link.workspaceName, logoUrl }} title="Upcoming posts" width="2xl">
      <a href={`/v/${token}/report`} className="mb-3 inline-flex min-h-10 items-center text-sm underline">
        Reports
      </a>
      <p className="text-sm text-muted-foreground">
        These go out at the time shown unless you ask for a change.
      </p>
      <div className="mt-6">
        <ReviewLinkView token={token} />
      </div>
    </ClientPageShell>
  );
}
