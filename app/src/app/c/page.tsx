import type { Metadata } from "next";

import { ClientPageShell } from "@/components/client-page-header";

/**
 * /c — reached by a bare /c with no token, and by a connect-link flow that
 * finished in a browser other than the one that started it, or after its
 * cookie ran out (server/connectLink/callback.ts). There is no token here to
 * name a link, so one heading and one sentence that fit both (R11 review).
 */

export const metadata: Metadata = {
  title: "Connect your accounts",
  robots: { index: false, follow: false },
};

export default function ConnectLinkReopenPage() {
  return (
    <ClientPageShell workspace={null} title="Open your link again">
      <p className="text-base">
        This page needs the full link you were sent. Open that link again from the message, in the same browser you
        started in.
      </p>
    </ClientPageShell>
  );
}
