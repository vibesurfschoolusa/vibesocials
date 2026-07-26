import {
  Activity,
  CalendarClock,
  Images,
  LayoutDashboard,
  PenSquare,
  Settings,
  Star,
  type LucideIcon,
} from "lucide-react";

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
  { label: "Media", href: "/media", icon: Images },
  { label: "Reviews", href: "/reviews", icon: Star },
  { label: "Settings", href: "/settings", icon: Settings },
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
];

export function isPublicRoute(pathname: string): boolean {
  return PUBLIC_ROUTE_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

/** Active-nav matching: exact for the dashboard root, prefix for the rest. */
export function isActiveNav(pathname: string, href: string): boolean {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}

/** Resolve the current section's title from the nav (longest match wins). */
export function sectionTitle(pathname: string): string {
  const match = [...NAV_ITEMS]
    .filter((item) => isActiveNav(pathname, item.href))
    .sort((a, b) => b.href.length - a.href.length)[0];
  return match?.label ?? "Vibe Socials";
}
