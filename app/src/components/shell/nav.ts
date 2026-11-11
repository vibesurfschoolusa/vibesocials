import {
  Activity,
  CalendarClock,
  FileText,
  Images,
  LayoutDashboard,
  PenSquare,
  Settings,
  Star,
  type LucideIcon,
} from "lucide-react";

import { paymentsConfigured, type BillingEnv } from "@/lib/billing";

export interface NavItemDef {
  label: string;
  href: string;
  icon: LucideIcon;
}

/** Primary app navigation, shown in the sidebar (desktop) and drawer (mobile). */
export const NAV_ITEMS: NavItemDef[] = [
  { label: "Dashboard", href: "/", icon: LayoutDashboard },
  { label: "Create", href: "/posts/new", icon: PenSquare },
  { label: "Queue", href: "/queue", icon: CalendarClock },
  { label: "Activity", href: "/activity", icon: Activity },
  { label: "Reports", href: "/reports", icon: FileText },
  { label: "Media", href: "/media", icon: Images },
  { label: "Reviews", href: "/reviews", icon: Star },
  { label: "Settings", href: "/settings", icon: Settings },
];

/** Pages the top bar titles that are not in the sidebar. */
const TITLE_ONLY_ITEMS: Pick<NavItemDef, "label" | "href">[] = [
  { label: "Workspaces", href: "/workspaces" },
];

/**
 * Routes that render with NO app shell — auth pages and legal pages. Everything
 * else is treated as an authenticated app route and gets the full shell once the
 * user is signed in.
 */
export const PUBLIC_ROUTE_PREFIXES = [
  "/login",
  "/register",
  "/forgot-password",
  "/reset-password",
  "/verify-email",
  "/privacy",
  "/terms",
  "/data-deletion",
  "/about",
  "/help",
  // Client upload links (2026-11-10): the client has no account, so no shell.
  "/u",
  // Client review links (2026-11-10): the client has no account, so no shell.
  "/v",
  // Client connect links (2026-11-11): the client has no account, so no shell.
  "/c",
];

/**
 * `pricingPublic`: /pricing renders with no shell too (23). The shell runs in
 * the browser, which cannot read the billing setting, so the root layout
 * passes it in (pricingShellProps). Without it /pricing is an unknown app page:
 * its 404 shows inside the shell, like any other.
 */
export function isPublicRoute(pathname: string, options: { pricingPublic?: boolean } = {}): boolean {
  const prefixes = options.pricingPublic ? [...PUBLIC_ROUTE_PREFIXES, "/pricing"] : PUBLIC_ROUTE_PREFIXES;
  return prefixes.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

/**
 * For the root layout, on the server: the AppShell prop that makes /pricing
 * public, only once payments are configured (the proxy's isPublicPath reads
 * the same function). Without them it is no prop at all, so every page's
 * markup is what it was before pricing existed.
 */
export function pricingShellProps(env: BillingEnv = process.env): { pricingPublic?: true } {
  return paymentsConfigured(env) ? { pricingPublic: true } : {};
}

/** Active-nav matching: exact for the dashboard root, prefix for the rest. */
export function isActiveNav(pathname: string, href: string): boolean {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}

/** Resolve the current section's title from the nav (longest match wins). */
export function sectionTitle(pathname: string): string {
  const match = [...NAV_ITEMS, ...TITLE_ONLY_ITEMS]
    .filter((item) => isActiveNav(pathname, item.href))
    .sort((a, b) => b.href.length - a.href.length)[0];
  return match?.label ?? "Vibe Socials";
}
