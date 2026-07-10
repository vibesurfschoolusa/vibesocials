"use client";

import { useSyncExternalStore } from "react";
import { Monitor, Moon, Sun, type LucideIcon } from "lucide-react";

import { cn } from "@/lib/cn";

type Theme = "light" | "dark" | "system";

const THEMES: { value: Theme; label: string; icon: LucideIcon }[] = [
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
  { value: "system", label: "System", icon: Monitor },
];

/**
 * Apply a theme by toggling the manual-override class on <html>. "system" clears
 * the override so the `prefers-color-scheme` rules in globals.css take over.
 * Mirrors the inline boot script in layout.tsx.
 */
function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  root.classList.remove("dark", "light");
  if (theme === "dark") root.classList.add("dark");
  else if (theme === "light") root.classList.add("light");
}

// Tiny external store over localStorage so the control reads persisted state
// without a setState-in-effect and stays hydration-safe via getServerSnapshot.
const listeners = new Set<() => void>();

function subscribe(callback: () => void): () => void {
  listeners.add(callback);
  window.addEventListener("storage", callback);
  return () => {
    listeners.delete(callback);
    window.removeEventListener("storage", callback);
  };
}

function readStoredTheme(): Theme {
  try {
    const stored = localStorage.getItem("theme");
    return stored === "dark" || stored === "light" ? stored : "system";
  } catch {
    return "system";
  }
}

function getServerTheme(): Theme {
  return "system";
}

function setStoredTheme(theme: Theme): void {
  try {
    localStorage.setItem("theme", theme);
  } catch {
    /* private mode / storage disabled — still applies for this session */
  }
  applyTheme(theme);
  listeners.forEach((listener) => listener());
}

/**
 * Light / dark / system segmented control. Persists to localStorage and updates
 * <html> immediately; reads current state via useSyncExternalStore so it stays
 * correct on hydration without an effect.
 */
export function ThemeToggle() {
  const theme = useSyncExternalStore(subscribe, readStoredTheme, getServerTheme);

  return (
    <div
      role="group"
      aria-label="Color theme"
      className="inline-flex items-center gap-0.5 rounded-[var(--radius)] border border-border bg-background p-0.5"
    >
      {THEMES.map(({ value, label, icon: Icon }) => {
        const active = theme === value;
        return (
          <button
            key={value}
            type="button"
            onClick={() => setStoredTheme(value)}
            aria-pressed={active}
            aria-label={`${label} theme`}
            title={`${label} theme`}
            className={cn(
              "inline-flex h-7 w-7 items-center justify-center rounded-[calc(var(--radius)-0.25rem)] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
              active
                ? "bg-accent text-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            <Icon aria-hidden className="h-4 w-4" />
          </button>
        );
      })}
    </div>
  );
}
