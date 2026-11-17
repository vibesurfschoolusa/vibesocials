import type { Metadata } from "next";
import Link from "next/link";
import { Compass } from "lucide-react";

import { buttonVariants } from "@/components/ui/buttonVariants";

export const metadata: Metadata = {
  title: "Page not found | Vibe Socials",
};

/**
 * Branded 404. Replaces Next's stock "404 | This page could not be found.",
 * which rendered inside the app shell with no way back. Drawn like the app's
 * EmptyState, but with the page's h1 (R5 pages L11). Signed in, the app shell
 * around it supplies the nav and the main landmark, so this adds no <main>;
 * the link goes to "/", which is the dashboard signed in and the home page
 * signed out, and its label suits both.
 */
export default function NotFound() {
  return (
    <div className="mx-auto max-w-6xl px-4 py-16 md:px-6 lg:px-8">
      <div className="flex flex-col items-center justify-center gap-3 rounded-[calc(var(--radius)+0.125rem)] border border-dashed border-border px-6 py-12 text-center">
        <div
          aria-hidden
          className="flex h-12 w-12 items-center justify-center rounded-full bg-muted text-muted-foreground [&_svg]:h-6 [&_svg]:w-6"
        >
          <Compass />
        </div>
        <div className="flex flex-col gap-1">
          <h1 className="text-base font-semibold text-foreground">Page not found</h1>
          <p className="mx-auto max-w-sm text-sm text-muted-foreground">
            That link doesn&apos;t lead anywhere. It may have moved, or the address may have a typo.
          </p>
        </div>
        <div className="mt-1">
          <Link href="/" className={buttonVariants({ variant: "primary" })}>
            Go to Vibe Socials
          </Link>
        </div>
      </div>
    </div>
  );
}
