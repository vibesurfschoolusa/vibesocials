import type { Metadata } from "next";

import { ClientPageShell } from "@/components/client-page-header";
import { CONNECT_LINK_REOPEN_MESSAGE } from "@/lib/connectLink";

/**
 * /c — where a connect-link flow lands when the browser that finished it is
 * not the one that started it, or its cookie ran out (server/connectLink/
 * callback.ts). There is no token here to name a link, so one sentence.
 */

export const metadata: Metadata = {
  title: "Connect your accounts",
  robots: { index: false, follow: false },
};

export default function ConnectLinkReopenPage() {
  return (
    <ClientPageShell workspace={null}>
      <p className="text-base">{CONNECT_LINK_REOPEN_MESSAGE}</p>
    </ClientPageShell>
  );
}
