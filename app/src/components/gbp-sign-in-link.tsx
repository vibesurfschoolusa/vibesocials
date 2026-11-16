import { buttonVariants } from "@/components/ui/button";

/**
 * JJ3 lead review: the in-place Google sign-in (lib/gbpSignIn.ts), the
 * Reconnect button's own start. A plain anchor: /api/auth/* is a redirect
 * handler, not a Next.js page. Shown only to an owner; the routes give a
 * member no URL.
 */
export function SignInAgainLink({ href, size = "sm" }: { href: string; size?: "sm" | "md" }) {
  return (
    <a href={href} className={buttonVariants({ variant: "primary", size })}>
      Sign in to Google again
    </a>
  );
}
