import Link from "next/link";

import { buttonVariants } from "@/components/ui/button";
import { OPERATOR_NAME, PRODUCT_NAME } from "@/lib/siteInfo";

/**
 * The public site's header and footer, shared by the landing page and the
 * pricing page (S1). Moved out of landing.tsx unchanged: the landing's HTML
 * with billing off is pinned by publicPagesBillingOff.test.ts.
 */

export function PublicHeader({
  showPricing,
  brandHref,
}: {
  showPricing: boolean;
  /**
   * S1: the pricing page links the brand back to "/" (the dashboard when
   * signed in). Absent on the landing, whose header stays plain text so its
   * billing-off HTML is unchanged.
   */
  brandHref?: string;
}) {
  const brand = (
    <>
      <span
        aria-hidden
        className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-indigo-500 to-indigo-700 text-xs font-bold text-white"
      >
        VS
      </span>
      <span className="text-sm font-semibold text-foreground">
        Vibe Socials
      </span>
    </>
  );
  return (
    <header className="mx-auto flex w-full max-w-5xl items-center justify-between px-4 py-5 md:px-6">
      {brandHref ? (
        <Link href={brandHref} className="flex items-center gap-2.5">
          {brand}
        </Link>
      ) : (
        <span className="flex items-center gap-2.5">{brand}</span>
      )}
      <nav aria-label="Main" className="flex items-center gap-1">
        {/* 23: only once /pricing exists; with payments not configured it is a 404. */}
        {showPricing ? (
          <Link
            href="/pricing"
            className={buttonVariants({ variant: "ghost", size: "sm" })}
          >
            Pricing
          </Link>
        ) : null}
        <Link
          href="/about"
          className={buttonVariants({ variant: "ghost", size: "sm" })}
        >
          About
        </Link>
        <Link
          href="/login"
          className={buttonVariants({ variant: "ghost", size: "sm" })}
        >
          Log in
        </Link>
      </nav>
    </header>
  );
}

export function PublicFooter() {
  return (
    <footer className="border-t border-border">
      <div className="mx-auto flex w-full max-w-5xl flex-col items-center justify-between gap-3 px-4 py-6 text-sm text-muted-foreground sm:flex-row md:px-6">
        <span>
          © {new Date().getFullYear()} {PRODUCT_NAME} · operated by {OPERATOR_NAME}
        </span>
        <nav aria-label="Legal" className="flex flex-wrap items-center justify-center gap-x-4 gap-y-1">
          <Link href="/about" className="hover:text-foreground">
            About
          </Link>
          <Link href="/about#contact" className="hover:text-foreground">
            Contact
          </Link>
          <Link href="/privacy" className="hover:text-foreground">
            Privacy
          </Link>
          <Link href="/terms" className="hover:text-foreground">
            Terms
          </Link>
          <Link href="/data-deletion" className="hover:text-foreground">
            Delete your data
          </Link>
        </nav>
      </div>
    </footer>
  );
}
