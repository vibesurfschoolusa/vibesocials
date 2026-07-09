"use client";

import { useState, useEffect } from "react";
import { Info, AlertCircle } from "lucide-react";
import type { TikTokCreatorInfo, TikTokPostMetadata } from "@/server/platforms/types";

interface TikTokPostSettingsProps {
  metadata: TikTokPostMetadata;
  onChange: (metadata: TikTokPostMetadata) => void;
  isVideo: boolean;
}

export function TikTokPostSettings({ metadata, onChange, isVideo }: TikTokPostSettingsProps) {
  const [creatorInfo, setCreatorInfo] = useState<TikTokCreatorInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [commercialContentEnabled, setCommercialContentEnabled] = useState(false);

  useEffect(() => {
    fetchCreatorInfo();
  }, []);

  async function fetchCreatorInfo() {
    try {
      setLoading(true);
      setError(null);
      const response = await fetch("/api/tiktok/creator-info");
      
      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || "Failed to fetch TikTok creator info");
      }

      const data = await response.json();
      setCreatorInfo(data);
    } catch (err: any) {
      console.error("Failed to fetch TikTok creator info:", err);
      setError(err.message || "Failed to load TikTok settings");
    } finally {
      setLoading(false);
    }
  }

  const handlePrivacyChange = (privacyLevel: string) => {
    onChange({ ...metadata, privacyLevel });
  };

  const handleInteractionChange = (field: keyof TikTokPostMetadata, value: boolean) => {
    onChange({ ...metadata, [field]: value });
  };

  const handleCommercialToggle = (enabled: boolean) => {
    setCommercialContentEnabled(enabled);
    if (!enabled) {
      onChange({ ...metadata, brandedContent: false, brandOrganic: false });
    }
  };

  const handleBrandedContentChange = (checked: boolean) => {
    const newMetadata = { ...metadata, brandedContent: checked };
    
    // If branded content is selected and privacy is SELF_ONLY, switch to PUBLIC_TO_EVERYONE
    if (checked && metadata.privacyLevel === "SELF_ONLY") {
      newMetadata.privacyLevel = "PUBLIC_TO_EVERYONE";
    }
    
    onChange(newMetadata);
  };

  const isBrandedContentDisabled = metadata.privacyLevel === "SELF_ONLY";
  const canPublish = !commercialContentEnabled || metadata.brandedContent || metadata.brandOrganic;

  if (loading) {
    return (
      <div className="rounded-lg border border-zinc-200 bg-zinc-50 p-4">
        <p className="text-sm text-zinc-600">Loading TikTok settings...</p>
      </div>
    );
  }

  if (error || !creatorInfo) {
    return (
      <div className="rounded-lg border border-red-200 bg-red-50 p-4">
        <div className="flex items-start gap-2">
          <AlertCircle className="h-4 w-4 text-red-600 mt-0.5" />
          <div>
            <p className="text-sm font-medium text-red-900">TikTok Settings Error</p>
            <p className="text-xs text-red-700 mt-1">{error || "Unable to load TikTok settings"}</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4 rounded-lg border border-zinc-200 bg-white p-4">
      <div className="flex items-center gap-2 pb-2 border-b border-zinc-200">
        <h3 className="text-sm font-semibold text-zinc-900">TikTok Post Settings</h3>
        <span className="text-xs text-zinc-500">@{creatorInfo.creatorUsername}</span>
      </div>

      {/* Privacy Level - REQUIRED by TikTok Guidelines */}
      <div>
        <label className="block text-sm font-medium text-zinc-900 mb-2">
          Privacy Level <span className="text-red-600">*</span>
        </label>
        <select
          value={metadata.privacyLevel}
          onChange={(e) => handlePrivacyChange(e.target.value)}
          className="w-full rounded border border-zinc-300 px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-1 focus:ring-zinc-900"
          required
        >
          <option value="">Select privacy level...</option>
          {creatorInfo.privacyLevelOptions.map((option) => (
            <option key={option} value={option}>
              {option === "PUBLIC_TO_EVERYONE" && "Public (Everyone)"}
              {option === "MUTUAL_FOLLOW_FRIENDS" && "Friends"}
              {option === "SELF_ONLY" && "Private (Only Me)"}
              {option === "FOLLOWER_OF_CREATOR" && "Followers"}
            </option>
          ))}
        </select>
        <p className="mt-1 text-xs text-zinc-500">
          You must manually select who can view this video
        </p>
      </div>

      {/* Interaction Settings - REQUIRED by TikTok Guidelines */}
      <div>
        <label className="block text-sm font-medium text-zinc-900 mb-2">
          Interaction Settings
        </label>
        <div className="space-y-2">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={!metadata.disableComment}
              onChange={(e) => handleInteractionChange("disableComment", !e.target.checked)}
              disabled={creatorInfo.commentDisabled}
              className="h-4 w-4 rounded border-zinc-300 disabled:opacity-50"
            />
            <span className="text-sm text-zinc-700">
              Allow Comments
              {creatorInfo.commentDisabled && (
                <span className="ml-2 text-xs text-zinc-500">(Disabled in your TikTok settings)</span>
              )}
            </span>
          </label>

          {isVideo && (
            <>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={!metadata.disableDuet}
                  onChange={(e) => handleInteractionChange("disableDuet", !e.target.checked)}
                  disabled={creatorInfo.duetDisabled}
                  className="h-4 w-4 rounded border-zinc-300 disabled:opacity-50"
                />
                <span className="text-sm text-zinc-700">
                  Allow Duet
                  {creatorInfo.duetDisabled && (
                    <span className="ml-2 text-xs text-zinc-500">(Disabled in your TikTok settings)</span>
                  )}
                </span>
              </label>

              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={!metadata.disableStitch}
                  onChange={(e) => handleInteractionChange("disableStitch", !e.target.checked)}
                  disabled={creatorInfo.stitchDisabled}
                  className="h-4 w-4 rounded border-zinc-300 disabled:opacity-50"
                />
                <span className="text-sm text-zinc-700">
                  Allow Stitch
                  {creatorInfo.stitchDisabled && (
                    <span className="ml-2 text-xs text-zinc-500">(Disabled in your TikTok settings)</span>
                  )}
                </span>
              </label>
            </>
          )}
        </div>
        <p className="mt-2 text-xs text-zinc-500">
          Manually enable interaction features. None are checked by default.
        </p>
      </div>

      {/* Commercial Content Disclosure - REQUIRED by TikTok Guidelines */}
      <div>
        <label className="flex items-center gap-2 mb-2">
          <input
            type="checkbox"
            checked={commercialContentEnabled}
            onChange={(e) => handleCommercialToggle(e.target.checked)}
            className="h-4 w-4 rounded border-zinc-300"
          />
          <span className="text-sm font-medium text-zinc-900">
            This content promotes a brand, product, or service
          </span>
        </label>

        {commercialContentEnabled && (
          <div className="ml-6 space-y-2 mt-2 p-3 bg-zinc-50 rounded border border-zinc-200">
            <label className="flex items-start gap-2">
              <input
                type="checkbox"
                checked={metadata.brandOrganic || false}
                onChange={(e) => onChange({ ...metadata, brandOrganic: e.target.checked })}
                className="h-4 w-4 rounded border-zinc-300 mt-0.5"
              />
              <div className="flex-1">
                <span className="text-sm text-zinc-700 font-medium">Your Brand</span>
                <p className="text-xs text-zinc-600 mt-0.5">
                  You are promoting yourself or your own business
                </p>
                {metadata.brandOrganic && (
                  <p className="text-xs text-blue-700 mt-1 font-medium">
                    ✓ Your video will be labeled as &quot;Promotional content&quot;
                  </p>
                )}
              </div>
            </label>

            <label className="flex items-start gap-2">
              <input
                type="checkbox"
                checked={metadata.brandedContent || false}
                onChange={(e) => handleBrandedContentChange(e.target.checked)}
                disabled={isBrandedContentDisabled}
                className="h-4 w-4 rounded border-zinc-300 mt-0.5 disabled:opacity-50"
              />
              <div className="flex-1">
                <span className="text-sm text-zinc-700 font-medium">Branded Content</span>
                <p className="text-xs text-zinc-600 mt-0.5">
                  You are promoting another brand or third party
                </p>
                {isBrandedContentDisabled && (
                  <p className="text-xs text-amber-700 mt-1">
                    Branded content cannot be set to private. Change privacy to Public or Friends.
                  </p>
                )}
                {metadata.brandedContent && (
                  <p className="text-xs text-blue-700 mt-1 font-medium">
                    ✓ Your video will be labeled as &quot;Paid partnership&quot;
                  </p>
                )}
              </div>
            </label>

            {!canPublish && (
              <div className="flex items-start gap-2 mt-2 p-2 bg-amber-50 border border-amber-200 rounded">
                <Info className="h-4 w-4 text-amber-600 mt-0.5" />
                <p className="text-xs text-amber-800">
                  You must select at least one option (Your Brand or Branded Content) to proceed
                </p>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Required Consent Declaration - REQUIRED by TikTok Guidelines */}
      <div className="pt-3 border-t border-zinc-200">
        <div className="flex items-start gap-2 p-3 bg-blue-50 border border-blue-200 rounded">
          <Info className="h-4 w-4 text-blue-600 mt-0.5" />
          <div className="text-xs text-blue-900">
            <p className="font-medium">By posting, you agree to:</p>
            <ul className="mt-1 space-y-0.5 list-disc list-inside">
              <li>TikTok&apos;s Music Usage Confirmation</li>
              {(metadata.brandedContent || metadata.brandOrganic) && (
                <li>TikTok&apos;s Branded Content Policy</li>
              )}
            </ul>
          </div>
        </div>
      </div>

      {/* Post Processing Notice - REQUIRED by TikTok Guidelines */}
      <div className="flex items-start gap-2 p-3 bg-zinc-50 border border-zinc-200 rounded">
        <Info className="h-4 w-4 text-zinc-600 mt-0.5" />
        <p className="text-xs text-zinc-700">
          After publishing, it may take a few minutes for your content to process and be visible on your profile.
        </p>
      </div>
    </div>
  );
}
