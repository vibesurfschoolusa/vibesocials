"use client";

import { usePathname } from "next/navigation";
import { Menu } from "lucide-react";

import { Brand } from "./brand";
import { AccountMenu } from "./account-menu";
import { sectionTitle } from "./nav";

/**
 * Sticky top bar. On mobile it carries the drawer trigger + brand; on desktop it
 * shows the current section title. The account menu sits on the right at every
 * breakpoint.
 */
export function TopBar({ onMenuClick }: { onMenuClick: () => void }) {
  const pathname = usePathname();
  const title = sectionTitle(pathname);

  return (
    <header className="sticky top-0 z-20 flex h-16 items-center gap-3 border-b border-border bg-background/80 px-4 backdrop-blur md:px-6">
      <button
        type="button"
        onClick={onMenuClick}
        aria-label="Open navigation"
        className="inline-flex h-9 w-9 items-center justify-center rounded-[var(--radius)] text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring md:hidden"
      >
        <Menu aria-hidden className="h-5 w-5" />
      </button>

      <div className="md:hidden">
        <Brand />
      </div>

      <span className="min-w-0 truncate text-sm font-semibold text-foreground">
        {title}
      </span>

      <div className="ml-auto flex items-center gap-2">
        <AccountMenu />
      </div>
    </header>
  );
}
