"use client";

import { usePathname } from "next/navigation";

import { Brand } from "./brand";
import { NavItem } from "./nav-item";
import { NAV_ITEMS, isActiveNav } from "./nav";

/** Fixed desktop sidebar: brand + primary navigation. Hidden below `md`. */
export function Sidebar() {
  const pathname = usePathname();

  return (
    <aside className="fixed inset-y-0 left-0 z-30 hidden w-64 flex-col border-r border-border bg-card md:flex">
      <div className="flex h-16 items-center px-5">
        <Brand />
      </div>
      <nav aria-label="Main" className="flex-1 space-y-1 overflow-y-auto px-3 py-3">
        {NAV_ITEMS.map((item) => (
          <NavItem
            key={item.href}
            item={item}
            active={isActiveNav(pathname, item.href)}
          />
        ))}
      </nav>
    </aside>
  );
}
