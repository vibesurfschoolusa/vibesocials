import Link from "next/link";

import { BrandMark } from "@/components/brand-mark";
import { SignedInSwap } from "@/components/signed-in-swap";
import { buttonVariants } from "@/components/ui/buttonVariants";
import { cn } from "@/lib/cn";
import { OPERATOR_NAME, PRODUCT_NAME } from "@/lib/siteInfo";

/**
 * The public site's header and footer, shared by the landing page and the
 * pricing page (S1). Moved out of landing.tsx unchanged: the landing's HTML
 * with billing off is pinned by publicPagesBillingOff.test.ts.
 */

export function PublicHeader({
  showPricing,
  brandHref,
  signedIn = false,
}: {
  showPricing: boolean;
  /**
   * S1: the pricing page links the brand back to "/" (the dashboard when
   * signed in). Absent on the landing, whose header stays plain text so its
   * billing-off HTML is unchanged.
   */
  brandHref?: string;
  /**
   * R17-pages L1: a page that already read the session on the server (Pricing)
   * says so; elsewhere the client session swaps "Log in" once it is read.
   */
  signedIn?: boolean;
}) {
  const brand = (
    <>
      <BrandMark className="rounded-lg" />
      <span className="text-sm font-semibold text-foreground">
        Vibe Socials
      </span>
    </>
  );
  // R26 pages L8: with Pricing, the brand and three buttons were wider than a
  // 375 px phone ("Dashboard" is about 30 px wider than "Log in"), so below sm
  // the buttons are narrower and the header may wrap. Without Pricing it fits
  // and its markup is unchanged (publicPagesBillingOff.test.ts).
  const navLink = buttonVariants({ variant: "ghost", size: "sm", className: showPricing ? "px-2 sm:px-3" : undefined });
  // R17-pages L1: someone signed in already has an account; "Log in" would
  // only lead to a second sign-in.
  const dashboardLink = (
    <Link href="/" className={navLink}>
      Dashboard
    </Link>
  );
  return (
    <header
      className={cn(
        "mx-auto flex w-full max-w-5xl items-center justify-between px-4 py-5 md:px-6",
        showPricing && "flex-wrap gap-x-4 gap-y-2",
      )}
    >
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
          <Link href="/pricing" className={navLink}>
            Pricing
          </Link>
        ) : null}
        <Link href="/about" className={navLink}>
          About
        </Link>
        {signedIn ? (
          dashboardLink
        ) : (
          <SignedInSwap
            signedIn={dashboardLink}
            signedOut={
              <Link href="/login" className={navLink}>
                Log in
              </Link>
            }
          />
        )}
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
