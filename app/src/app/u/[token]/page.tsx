import type { Metadata } from "next";

import { ClientPageShell } from "@/components/client-page-header";
import { findClientPageLogo } from "@/lib/clientPageLogo";
import { UPLOAD_LINK_INACTIVE_MESSAGE } from "@/lib/uploadLink";
import { findActiveUploadLink } from "@/server/uploadLink";

import { UploadLinkForm } from "./upload-link-form";

/**
 * /u/[token] — a workspace's client upload link (2026-11-10). Open signed out
 * (proxy.ts isPublicPath, nav.ts PUBLIC_ROUTE_PREFIXES: no app shell). Shows the
 * workspace's name and nothing else about it; an unknown and a revoked link get
 * the same single sentence. The token is the only thing the form is given.
 */

interface UploadLinkPageProps {
  params: Promise<{ token: string }>;
}

export const metadata: Metadata = {
  title: "Send photos and videos",
  robots: { index: false, follow: false },
  // The token is in the address: never pass it on to another site.
  referrer: "no-referrer",
};

export default async function UploadLinkPage({ params }: UploadLinkPageProps) {
  const { token } = await params;
  const link = await findActiveUploadLink(token);

  if (!link) {
    return (
      <ClientPageShell workspace={null}>
        <p className="text-base">{UPLOAD_LINK_INACTIVE_MESSAGE}</p>
      </ClientPageShell>
    );
  }

  const logoUrl = await findClientPageLogo(link.workspaceId);
  return (
    <ClientPageShell workspace={{ name: link.workspaceName, logoUrl }} title="Send photos and videos">
      <UploadLinkForm token={token} />
    </ClientPageShell>
  );
}
