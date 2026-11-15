"use client";

import { useState, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import { useSession } from "next-auth/react";

import { useSignedInAccount } from "@/components/signed-in-swap";
import { ToastProvider } from "@/components/ui/toast";
import { Sidebar } from "./sidebar";
import { TopBar } from "./top-bar";
import { MobileDrawer } from "./mobile-drawer";
import { TimeZoneSync } from "./time-zone-sync";
import { VerifyEmailBanner } from "./verify-email-banner";
import { WorkspacePausedBanner } from "./workspace-paused-banner";
import { isPublicRoute } from "./nav";
import { SignedOutAlert, useServerSaysSignedOut } from "./signed-out-alert";

/**
 * App-wide chrome. `ToastProvider` wraps everything so toasts work on every
 * route. The persistent sidebar/top-bar shell is shown only for authenticated
 * app routes; public routes (auth, legal, design preview) and the signed-out
 * dashboard landing render bare. Server-side auth redirects still run first —
 * this is presentational chrome around whatever the page renders.
 */
export function AppShell({ children, pricingPublic }: { children: ReactNode; pricingPublic?: boolean }) {
  const pathname = usePathname();
  const { status } = useSession();
  // R19 new-customer L1: signed in means the session names someone, as for the
  // header; a session the server ended is "authenticated" with no user.
  const signedIn = useSignedInAccount() !== null;

  // Task 10 — show the chrome optimistically while the session resolves, to
  // avoid a bare-then-shell flash on hard loads of protected routes. Safe
  // because every non-public route except "/" server-redirects unauthenticated
  // users before this ever mounts (Tasks 3/4 + settings); "/" keeps its exact
  // prior behavior (bare while loading/signed-out, shell only once
  // authenticated) since it's excluded from `isAppRoute` and hosts both the
  // signed-out Landing and the signed-in Dashboard.
  //
  // R20 new-customer L1: an app route keeps the frame whatever the session says
  // later. Swapping the tree remounted the page and lost unsent work (a caption,
  // a file); once the server confirms nobody, one signed-out line shows instead.
  const isPublic = isPublicRoute(pathname, { pricingPublic });
  const isAppRoute = !isPublic && pathname !== "/";
  const showShell = isAppRoute || (signedIn && !isPublic);
  // FF1 review: the line waits for the server's own "signed out"; a failed
  // session fetch also reads as nobody here.
  const signedOut = useServerSaysSignedOut(isAppRoute && status !== "loading" && !signedIn);

  return (
    <ToastProvider>
      {showShell ? <AuthenticatedShell signedOut={signedOut}>{children}</AuthenticatedShell> : children}
    </ToastProvider>
  );
}

function AuthenticatedShell({ children, signedOut = false }: { children: ReactNode; signedOut?: boolean }) {
  const pathname = usePathname();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerPath, setDrawerPath] = useState(pathname);
  // 23: true while the workspace banner asks this person to confirm their
  // address (billing on only); the older verify nudge then stays hidden.
  const [confirmEmailShown, setConfirmEmailShown] = useState(false);

  // Close the mobile drawer on any route change (nav click, back button, etc.).
  // Render-time state adjustment — React's recommended alternative to a
  // setState-in-effect; the guard prevents a render loop.
  if (pathname !== drawerPath) {
    setDrawerPath(pathname);
    setDrawerOpen(false);
  }

  return (
    <div className="min-h-screen bg-background text-foreground">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-[100] focus:rounded-[var(--radius)] focus:bg-card focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:text-foreground focus:shadow-lg focus:outline-none focus:ring-2 focus:ring-ring"
      >
        Skip to content
      </a>

      <Sidebar />
      <MobileDrawer open={drawerOpen} onClose={() => setDrawerOpen(false)} />

      <div className="md:pl-64">
        <TopBar onMenuClick={() => setDrawerOpen(true)} />
        {/* F4: sends the browser's time zone once, so emails show local times. */}
        <TimeZoneSync />
        <main id="main-content" className="min-h-[calc(100vh-4rem)]">
          {/* Soft email-verification nudge. Self-gates: renders nothing unless
              the authenticated user is unverified AND email is configured, so it
              is safe to mount unconditionally inside the authed chrome. */}
          <VerifyEmailBanner suppressed={confirmEmailShown} />
          <WorkspacePausedBanner onConfirmEmailShownChange={setConfirmEmailShown} />
          {/* Its own slot before the page, so the page keeps its place in the tree. */}
          {signedOut ? <SignedOutAlert /> : null}
          {children}
        </main>
      </div>
    </div>
  );
}
