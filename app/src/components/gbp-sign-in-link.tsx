import { buttonVariants } from "@/components/ui/button";

/**
 * JJ3 lead review: the in-place Google sign-in (lib/gbpSignIn.ts), the
 * Reconnect button's own start. A plain anchor: /api/auth/* is a redirect
 * handler, not a Next.js page. Shown only to an owner; the routes give a
 * member no URL. R25 pages L2: it opens in a new tab, so this page, and a
 * reply or anything else typed on it, stays. The hint is visible and part of
 * the link's text, so its name is what sighted users read.
 */
export function SignInAgainLink({ href, size = "sm" }: { href: string; size?: "sm" | "md" }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={buttonVariants({ variant: "primary", size })}
    >
      Sign in to Google again <span className="text-xs font-normal opacity-90">(opens in a new tab)</span>
    </a>
  );
}
