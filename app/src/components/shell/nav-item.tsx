import Link from "next/link";

import { cn } from "@/lib/cn";
import type { NavItemDef } from "./nav";

/**
 * A single sidebar/drawer nav link. Active state is signalled three ways so it
 * never relies on color alone: a leading accent rail (shape), `aria-current`
 * (assistive tech), and heavier text weight.
 */
export function NavItem({
  item,
  active,
  onNavigate,
}: {
  item: NavItemDef;
  active: boolean;
  onNavigate?: () => void;
}) {
  const Icon = item.icon;
  return (
    <Link
      href={item.href}
      onClick={onNavigate}
      aria-current={active ? "page" : undefined}
      className={cn(
        "group relative flex items-center gap-3 rounded-[var(--radius)] px-3 py-2 text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
        active
          ? "bg-accent font-semibold text-foreground"
          : "font-medium text-muted-foreground hover:bg-accent hover:text-foreground",
      )}
    >
      <span
        aria-hidden
        className={cn(
          "absolute left-0 top-1/2 h-5 w-0.5 -translate-y-1/2 rounded-full bg-primary transition-opacity",
          active ? "opacity-100" : "opacity-0",
        )}
      />
      <Icon
        aria-hidden
        className={cn(
          "h-5 w-5 shrink-0",
          active ? "text-primary" : "text-muted-foreground group-hover:text-foreground",
        )}
      />
      <span>{item.label}</span>
    </Link>
  );
}
