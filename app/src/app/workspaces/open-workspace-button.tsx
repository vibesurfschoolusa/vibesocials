"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";

/** Makes the workspace active (POST /api/workspaces/switch) and goes to the dashboard. */
export function OpenWorkspaceButton({ workspaceId, name }: { workspaceId: string; name: string }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);

  async function handleOpen() {
    if (busy) return;
    setBusy(true);
    try {
      const response = await fetch("/api/workspaces/switch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspaceId }),
      });
      if (!response.ok) {
        const data = (await response.json().catch(() => null)) as { error?: string } | null;
        toast.error(data?.error ?? "Couldn't open that workspace. Try again.");
        setBusy(false);
        return;
      }
      // A full navigation, as the account menu's switch does: router.push would
      // keep client views on the previous workspace's data. `busy` stays set
      // while the page unloads so a second click can't race it.
      // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- see above
      window.location.assign("/");
    } catch {
      toast.error("Couldn't open that workspace. Try again.");
      setBusy(false);
    }
  }

  return (
    <Button
      type="button"
      size="sm"
      variant="secondary"
      loading={busy}
      onClick={handleOpen}
      aria-label={`Open ${name}`}
      className="w-full sm:w-auto"
    >
      Open
    </Button>
  );
}
