"use client";

import { useState, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import { useSession } from "next-auth/react";

import { ToastProvider } from "@/components/ui/toast";
import { Sidebar } from "./sidebar";
import { TopBar } from "./top-bar";
import { MobileDrawer } from "./mobile-drawer";
import { isPublicRoute } from "./nav";

/**
 * App-wide chrome. `ToastProvider` wraps everything so toasts work on every
 * route. The persistent sidebar/top-bar shell is shown only for authenticated
 * app routes; public routes (auth, legal, design preview) and the signed-out
 * dashboard landing render bare. Server-side auth redirects still run first —
 * this is presentational chrome around whatever the page renders.
 */
export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const { status } = useSession();

  // Task 10 — show the chrome optimistically while the session resolves, to
  // avoid a bare-then-shell flash on hard loads of protected routes. Safe
  // because every non-public route except "/" server-redirects unauthenticated
  // users before this ever mounts (Tasks 3/4 + settings); "/" keeps its exact
  // prior behavior (bare while loading/signed-out, shell only once
  // authenticated) since it's excluded from `isAppRoute` and hosts both the
  // signed-out Landing and the signed-in Dashboard.
  const isAppRoute = !isPublicRoute(pathname) && pathname !== "/";
  const showShell =
    status === "authenticated" ? !isPublicRoute(pathname) : isAppRoute && status === "loading";

  return (
    <ToastProvider>
      {showShell ? <AuthenticatedShell>{children}</AuthenticatedShell> : children}
    </ToastProvider>
  );
}

function AuthenticatedShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerPath, setDrawerPath] = useState(pathname);

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
        <main id="main-content" className="min-h-[calc(100vh-4rem)]">
          {children}
        </main>
      </div>
    </div>
  );
}
