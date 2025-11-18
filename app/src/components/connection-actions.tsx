"use client";

import { useState } from "react";

interface Props {
  platform: string;
  isConnected: boolean;
  isGoogleBusinessProfile: boolean;
}

export function ConnectionActions({
  platform,
  isConnected,
  isGoogleBusinessProfile,
}: Props) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleDisconnect() {
    setError(null);
    const confirmed = window.confirm(
      "Are you sure you want to disconnect this account? Future posts will no longer use it.",
    );
    if (!confirmed) return;

    setLoading(true);
    try {
      const response = await fetch(`/api/connections/${platform}`, {
        method: "DELETE",
      });
      const data = await response.json().catch(() => null);

      if (!response.ok) {
        setError((data as any)?.error ?? "Failed to disconnect.");
        setLoading(false);
        return;
      }

      window.location.reload();
    } catch (_err) {
      setError("Unexpected error while disconnecting.");
      setLoading(false);
    }
  }

  const showReconnect = isConnected && isGoogleBusinessProfile;

  if (!isConnected) {
    return null;
  }

  return (
    <div className="flex flex-col items-end gap-1 text-[11px]">
      <div className="flex items-center gap-2">
        <span className="rounded-full bg-emerald-50 px-3 py-1 text-[11px] font-medium text-emerald-700">
          Connected
        </span>
        {showReconnect && (
          <a
            href="/api/auth/google_business_profile/start"
            className="rounded border border-zinc-300 px-2 py-1 text-[11px] font-medium text-zinc-900 hover:bg-zinc-50"
          >
            Reconnect
          </a>
        )}
        <button
          type="button"
          onClick={handleDisconnect}
          disabled={loading}
          className="rounded border border-red-200 px-2 py-1 text-[11px] font-medium text-red-700 hover:bg-red-50 disabled:opacity-70"
        >
          {loading ? "Disconnecting..." : "Disconnect"}
        </button>
      </div>
      {error && <span className="text-[11px] text-red-600">{error}</span>}
    </div>
  );
}
