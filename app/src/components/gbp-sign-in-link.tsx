"use client";

import { useSyncExternalStore } from "react";

import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { isInstalledApp } from "@/lib/installedApp";

const HINT_CLASS = "text-xs font-normal opacity-90";

/** R26 pages L6: the visible hint every new-tab link in these pages carries, as part of its text. */
export function NewTabHint() {
  return <span className={HINT_CLASS}>(opens in a new tab)</span>;
}

/** R26 pages L3: in the installed app the sign-in leaves this page, so a typed reply must be copied first. */
export const INSTALLED_APP_HINT = "(you'll leave this page: copy any reply you typed first)";

const noSubscribe = () => () => {};

/**
 * JJ3 lead review: the in-place Google sign-in (lib/gbpSignIn.ts), the
 * Reconnect button's own start. A plain anchor: /api/auth/* is a redirect
 * handler, not a Next.js page. Shown only to an owner; the routes give a
 * member no URL. R25 pages L2: it opens in a new tab, so this page, and a
 * reply or anything else typed on it, stays. The hint is visible and part of
 * the link's text, so its name is what sighted users read.
 *
 * R26 pages L3: in the installed app a new tab opens the browser, with other
 * cookies and no session, so there it opens in the same view and says to copy
 * a typed reply first. The server's HTML (and the first render) is the
 * new-tab link; the installed app is known only in the browser.
 */
export function SignInAgainLink({ href, size = "sm" }: { href: string; size?: "sm" | "md" }) {
  const installed = useSyncExternalStore(noSubscribe, () => isInstalledApp(window), () => false);
  return <SignInAgainLinkView href={href} size={size} installed={installed} />;
}

export function SignInAgainLinkView({
  href,
  size = "sm",
  installed,
}: {
  href: string;
  size?: "sm" | "md";
  installed: boolean;
}) {
  // R26 pages L2: buttonVariants is whitespace-nowrap, which ran this link past
  // a 375 px reply form; it wraps (the hint onto its own line first) and grows.
  const className = cn(
    buttonVariants({ variant: "primary", size }),
    "h-auto flex-wrap gap-x-1 gap-y-0 whitespace-normal py-1.5 text-left",
    size === "md" ? "min-h-10" : "min-h-8",
  );
  if (installed) {
    return (
      <a href={href} className={className}>
        Sign in to Google again <span className={HINT_CLASS}>{INSTALLED_APP_HINT}</span>
      </a>
    );
  }
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className={className}>
      Sign in to Google again <NewTabHint />
    </a>
  );
}
