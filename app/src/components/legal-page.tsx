import Link from "next/link";
import type { ReactNode } from "react";

import { LEGAL_LAST_UPDATED, PRODUCT_NAME } from "@/lib/siteInfo";

/** The shared frame of the public legal and about pages: a card with a title. */
export function LegalPage({
  title,
  intro,
  showUpdated = true,
  children,
}: {
  title: string;
  intro?: ReactNode;
  showUpdated?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="flex min-h-screen justify-center bg-background px-4 py-10 text-foreground">
      <div className="w-full max-w-3xl rounded-[calc(var(--radius)+0.125rem)] border border-border bg-card p-6 text-card-foreground shadow-sm sm:p-8">
        <div className="mb-4 flex items-center justify-between gap-4">
          <h1 className="text-2xl font-semibold text-foreground">{title}</h1>
          <Link
            href="/"
            className="shrink-0 text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
          >
            Back to {PRODUCT_NAME}
          </Link>
        </div>
        {showUpdated ? (
          <p className="mb-4 text-xs text-muted-foreground">Last updated: {LEGAL_LAST_UPDATED}</p>
        ) : null}
        {intro ? <div className="mb-6 text-sm text-muted-foreground">{intro}</div> : null}
        <div className="space-y-5 text-sm leading-relaxed text-muted-foreground">{children}</div>
        <SiteLinks />
      </div>
    </div>
  );
}

export function LegalSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h2 className="mb-1.5 text-sm font-semibold text-foreground">{title}</h2>
      {children}
    </section>
  );
}

/** About, Privacy, Terms and Data deletion, linked from every public page. */
export function SiteLinks() {
  return (
    <nav aria-label="Site" className="mt-8 flex flex-wrap gap-x-4 gap-y-2 border-t border-border pt-4 text-xs text-muted-foreground">
      <Link href="/about" className="hover:text-foreground">About</Link>
      <Link href="/about#contact" className="hover:text-foreground">Contact</Link>
      <Link href="/privacy" className="hover:text-foreground">Privacy Policy</Link>
      <Link href="/terms" className="hover:text-foreground">Terms of Service</Link>
      <Link href="/data-deletion" className="hover:text-foreground">Delete your data</Link>
    </nav>
  );
}
