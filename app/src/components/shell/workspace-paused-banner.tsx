"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { useSession } from "next-auth/react";

import { Alert } from "@/components/ui/alert";

/**
 * The one banner a paused workspace's members see on every signed-in page
 * (2026-11-10). Asks GET /api/workspaces/status on each page change, so a pause
 * or resume shows on the next navigation; renders nothing unless the workspace
 * is blocked, or while the answer is loading or failed.
 */
export function WorkspacePausedBanner() {
  const { status } = useSession();
  const pathname = usePathname();
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (status !== "authenticated") return;
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch("/api/workspaces/status", { cache: "no-store" });
        if (!response.ok) return;
        const data = (await response.json()) as { blockedMessage?: unknown };
        if (!cancelled) setMessage(typeof data.blockedMessage === "string" ? data.blockedMessage : null);
      } catch {
        // Best effort: the routes still refuse with the same message.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [status, pathname]);

  if (!message) return null;

  return (
    <div className="px-4 pt-4 md:px-6">
      <Alert variant="danger" className="p-3">
        <span className="text-foreground">{message}</span>
      </Alert>
    </div>
  );
}
