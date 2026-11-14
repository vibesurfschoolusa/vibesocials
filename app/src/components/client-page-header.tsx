import type { ReactNode } from "react";

import { BrandMark } from "@/components/brand-mark";
import { cn } from "@/lib/cn";
import { workspaceInitials } from "@/lib/clientPage";

/**
 * The frame of the pages a client opens from a link (/u, /v, /c): the
 * workspace's logo (or a tile with its initials), its name and the page title,
 * and a quiet footer. With no workspace (an inactive link) only the Vibe
 * Socials mark and name show, so the page says nothing about whose link it was.
 */

export interface ClientPageWorkspace {
  name: string;
  logoUrl: string | null;
}

export function ClientPageShell({
  workspace,
  title,
  width = "md",
  children,
}: {
  workspace: ClientPageWorkspace | null;
  title?: string;
  width?: "md" | "2xl";
  children: ReactNode;
}) {
  return (
    <main className="min-h-screen bg-background px-4 py-8 text-foreground sm:py-10">
      <div className={cn("mx-auto w-full", width === "2xl" ? "max-w-2xl" : "max-w-md")}>
        <header className="mb-6 flex items-center gap-3">
          {workspace ? (
            <>
              {workspace.logoUrl ? (
                // eslint-disable-next-line @next/next/no-img-element -- the logo's public storage address, as the monthly report; alt is empty because the name is beside it
                <img
                  src={workspace.logoUrl}
                  alt=""
                  className="h-12 w-12 shrink-0 rounded-xl border border-border bg-card object-contain"
                />
              ) : (
                <span
                  aria-hidden
                  className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-muted text-base font-semibold text-muted-foreground"
                >
                  {workspaceInitials(workspace.name)}
                </span>
              )}
              <div className="min-w-0">
                <p className="break-words text-sm font-medium text-muted-foreground">{workspace.name}</p>
                {title ? (
                  <h1 className="break-words text-xl font-bold leading-tight tracking-tight sm:text-2xl">{title}</h1>
                ) : null}
              </div>
            </>
          ) : (
            <>
              <BrandMark />
              <p className="text-base font-semibold">Vibe Socials</p>
            </>
          )}
        </header>
        {children}
        {workspace ? (
          <footer className="mt-10 flex items-center justify-center gap-2 text-xs text-muted-foreground">
            <BrandMark className="h-4 w-4" />
            <span>Sent with Vibe Socials</span>
          </footer>
        ) : null}
      </div>
    </main>
  );
}
