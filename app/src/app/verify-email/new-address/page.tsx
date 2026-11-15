import Link from "next/link";
import type { Metadata } from "next";

import { BrandMark } from "@/components/brand-mark";

import { NewAddressClient } from "./new-address-client";

export const metadata: Metadata = {
  title: "Confirm your new email | Vibe Socials",
};

/**
 * R5 new-customer L4: where the link sent to a new sign-in address lands
 * (lib/accountEmails.ts buildEmailChangeEmail). Under /verify-email so it is
 * public and shell-free like the other account-link pages.
 */
export default function NewAddressPage() {
  return (
    <main className="relative flex min-h-screen flex-col items-center justify-center overflow-hidden bg-background px-4 py-16">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 -z-10 bg-gradient-to-b from-primary/5 via-background to-background"
      />
      <div className="w-full max-w-md">
        <div className="mb-6 flex justify-center">
          <Link
            href="/"
            aria-label="Vibe Socials home"
            className="rounded-2xl outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          >
            <BrandMark className="h-14 w-14 rounded-2xl shadow-lg" />
          </Link>
        </div>
        <NewAddressClient />
      </div>
    </main>
  );
}
