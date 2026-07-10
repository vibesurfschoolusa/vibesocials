"use client";

import { useEffect, useId, useRef, useState } from "react";
import { signOut, useSession } from "next-auth/react";
import { ChevronDown, LogOut } from "lucide-react";

import { cn } from "@/lib/cn";
import { ThemeToggle } from "./theme-toggle";

/**
 * Account dropdown: signed-in email, theme toggle, and sign-out. Implemented as
 * a labelled popover (not an ARIA menu, since it hosts a control group) with
 * Esc-to-close, outside-click-to-close, and focus returned to the trigger.
 */
export function AccountMenu() {
  const { data: session } = useSession();
  const email = session?.user?.email ?? "";
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();

  useEffect(() => {
    if (!open) return;

    function onPointerDown(event: MouseEvent) {
      if (containerRef.current?.contains(event.target as Node)) return;
      setOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOpen(false);
        buttonRef.current?.focus();
      }
    }

    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const initial = (email.trim()[0] ?? "?").toUpperCase();

  return (
    <div ref={containerRef} className="relative">
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-haspopup="true"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        className="flex items-center gap-2 rounded-[var(--radius)] border border-border bg-card px-2 py-1.5 text-sm outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
      >
        <span
          aria-hidden
          className="flex h-6 w-6 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground"
        >
          {initial}
        </span>
        <span className="hidden max-w-[11rem] truncate text-muted-foreground sm:inline">
          {email || "Account"}
        </span>
        <ChevronDown
          aria-hidden
          className={cn(
            "h-4 w-4 text-muted-foreground transition-transform",
            open && "rotate-180",
          )}
        />
      </button>

      {open ? (
        <div
          id={panelId}
          role="group"
          aria-label="Account"
          className="absolute right-0 z-50 mt-2 w-64 rounded-[calc(var(--radius)+0.125rem)] border border-border bg-card p-1.5 text-card-foreground shadow-lg"
        >
          <div className="px-2 py-2">
            <p className="text-xs text-muted-foreground">Signed in as</p>
            <p className="truncate text-sm font-medium text-foreground">
              {email || "Your account"}
            </p>
          </div>
          <div className="my-1 h-px bg-border" />
          <div className="flex items-center justify-between gap-2 px-2 py-2">
            <span className="text-sm text-muted-foreground">Theme</span>
            <ThemeToggle />
          </div>
          <div className="my-1 h-px bg-border" />
          <button
            type="button"
            onClick={async () => {
              setOpen(false);
              await signOut({ callbackUrl: "/" });
            }}
            className="flex w-full items-center gap-2 rounded-[var(--radius)] px-2 py-2 text-left text-sm text-foreground outline-none transition-colors hover:bg-accent focus-visible:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <LogOut aria-hidden className="h-4 w-4 text-muted-foreground" />
            Sign out
          </button>
        </div>
      ) : null}
    </div>
  );
}
