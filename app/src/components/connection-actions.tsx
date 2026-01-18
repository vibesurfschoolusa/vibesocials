"use client";

import { useState } from "react";

interface Props {
  platform: string;
  isConnected: boolean;
  isGoogleBusinessProfile: boolean;
}

const PLATFORM_AUTH_URLS: Record<string, string> = {
  tiktok: "/api/auth/tiktok/start",
  youtube: "/api/auth/youtube/start",
  x: "/api/auth/x/start",
  linkedin: "/api/auth/linkedin/start",
  instagram: "/api/auth/instagram/start",
  google_business_profile: "/api/auth/google_business_profile/start",
  facebook_page: "/api/auth/facebook_page/start",
};

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

  async function handleSwitchAccount() {
    setError(null);
    const confirmed = window.confirm(
      "This will disconnect your current account and let you connect a different one. Continue?",
    );
    if (!confirmed) return;

    setLoading(true);
    try {
      // First disconnect the current account
      const response = await fetch(`/api/connections/${platform}`, {
        method: "DELETE",
      });
      
      if (!response.ok) {
        setError("Failed to disconnect current account.");
        setLoading(false);
        return;
      }

      // Redirect to OAuth start to connect new account
      const authUrl = PLATFORM_AUTH_URLS[platform];
      if (authUrl) {
        window.location.href = authUrl;
      } else {
        window.location.reload();
      }
    } catch (_err) {
      setError("Unexpected error while switching accounts.");
      setLoading(false);
    }
  }

  if (!isConnected) {
    return null;
  }

  return (
    <div className="flex flex-col items-end gap-1 text-[11px]">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="rounded-full bg-emerald-50 px-3 py-1 text-[11px] font-medium text-emerald-700">
          Connected
        </span>
        <button
          type="button"
          onClick={handleSwitchAccount}
          disabled={loading}
          className="rounded border border-blue-200 px-2 py-1 text-[11px] font-medium text-blue-700 hover:bg-blue-50 disabled:opacity-70"
        >
          {loading ? "Switching..." : "Switch Account"}
        </button>
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
