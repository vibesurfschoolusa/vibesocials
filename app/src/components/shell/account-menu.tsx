"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { signOut, useSession } from "next-auth/react";
import { Check, ChevronDown, LogOut } from "lucide-react";
import type { WorkspaceRole } from "@prisma/client";

import { cn } from "@/lib/cn";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/components/ui/toast";
import { ThemeToggle } from "./theme-toggle";

/** GET /api/workspaces list item (design doc §4/§7) — the switcher's data. */
interface WorkspaceSummary {
  id: string;
  name: string;
  role: WorkspaceRole;
  isActive: boolean;
}

/**
 * Account dropdown: signed-in email, workspace switcher, theme toggle, and
 * sign-out. Implemented as a labelled popover (not an ARIA menu, since it
 * hosts a control group) with Esc-to-close, outside-click-to-close, and focus
 * returned to the trigger.
 */
export function AccountMenu() {
  const { data: session } = useSession();
  const router = useRouter();
  const toast = useToast();
  const email = session?.user?.email ?? "";
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();

  // Team Workspaces (Task 7) — the switcher's memberships. Fetched fresh every
  // time the popover opens (a cheap, membership-checked route) rather than
  // cached across opens, so a switch made elsewhere (another tab/device) is
  // always reflected the next time this menu is opened.
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[] | null>(null);
  const [workspacesLoading, setWorkspacesLoading] = useState(false);
  const [switchingId, setSwitchingId] = useState<string | null>(null);

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

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setWorkspacesLoading(true);

    (async () => {
      try {
        const response = await fetch("/api/workspaces");
        if (!response.ok) throw new Error("Failed to load workspaces");
        const data: { workspaces: WorkspaceSummary[] } = await response.json();
        if (!cancelled) setWorkspaces(data.workspaces);
      } catch {
        // Leave `workspaces` at its previous value (null on first failure) —
        // the render below already renders nothing for the workspace section
        // when there's no active workspace resolved, so a fetch failure just
        // degrades to "no workspace shown" rather than a dedicated error UI.
        // Sign-out/theme controls in the rest of the menu stay unaffected.
      } finally {
        if (!cancelled) setWorkspacesLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [open]);

  async function handleSwitch(workspace: WorkspaceSummary) {
    if (workspace.isActive || switchingId) return;
    setSwitchingId(workspace.id);
    try {
      const response = await fetch("/api/workspaces/switch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspaceId: workspace.id }),
      });
      if (!response.ok) {
        const data = (await response.json().catch(() => null)) as { error?: string } | null;
        toast.error(data?.error ?? "Couldn't switch workspaces.");
        return;
      }
      setOpen(false);
      // Return focus to the trigger, exactly like the Escape handler — the
      // popover (and the button that had focus) just went away under the user.
      buttonRef.current?.focus();
      toast.success(`Switched to ${workspace.name}.`);
      router.refresh();
    } catch {
      toast.error("Couldn't switch workspaces.");
    } finally {
      setSwitchingId(null);
    }
  }

  const initial = (email.trim()[0] ?? "?").toUpperCase();
  const activeWorkspace = workspaces?.find((workspace) => workspace.isActive) ?? null;

  return (
    <div ref={containerRef} className="relative">
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-haspopup="dialog"
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
          className="absolute right-0 z-50 mt-2 w-72 rounded-[calc(var(--radius)+0.125rem)] border border-border bg-card p-1.5 text-card-foreground shadow-lg"
        >
          <div className="px-2 py-2">
            <p className="text-xs text-muted-foreground">Signed in as</p>
            <p className="truncate text-sm font-medium text-foreground">
              {email || "Your account"}
            </p>
          </div>

          <div className="my-1 h-px bg-border" />

          <div className="px-2 py-2">
            <p className="text-xs text-muted-foreground">Workspace</p>
            {workspacesLoading ? (
              <Skeleton className="mt-1.5 h-5 w-32" />
            ) : activeWorkspace ? (
              <p className="truncate text-sm font-medium text-foreground">
                {activeWorkspace.name}
              </p>
            ) : null}

            {!workspacesLoading && workspaces && workspaces.length > 1 ? (
              <div
                role="group"
                aria-label="Switch workspace"
                className="mt-2 flex flex-col gap-0.5"
              >
                {workspaces.map((workspace) => (
                  <button
                    key={workspace.id}
                    type="button"
                    aria-pressed={workspace.isActive}
                    disabled={switchingId !== null}
                    onClick={() => handleSwitch(workspace)}
                    className={cn(
                      "flex items-center justify-between gap-2 rounded-[var(--radius)] px-2 py-1.5 text-left text-sm outline-none transition-colors hover:bg-accent focus-visible:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60",
                      workspace.isActive ? "text-foreground" : "text-muted-foreground",
                    )}
                  >
                    <span className="min-w-0 flex-1 truncate">{workspace.name}</span>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {workspace.role === "owner" ? "Owner" : "Member"}
                    </span>
                    {workspace.isActive ? (
                      <Check aria-hidden className="h-4 w-4 shrink-0 text-primary" />
                    ) : (
                      <span aria-hidden className="h-4 w-4 shrink-0" />
                    )}
                  </button>
                ))}
              </div>
            ) : null}
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
