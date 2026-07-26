"use client";

import { useState, useEffect } from "react";
import type { TikTokCreatorInfo, TikTokPostMetadata } from "@/server/platforms/types";
import { Alert } from "@/components/ui/alert";
import { Card } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";

interface TikTokPostSettingsProps {
  metadata: TikTokPostMetadata;
  onChange: (metadata: TikTokPostMetadata) => void;
  isVideo: boolean;
  /** Submit-time privacy validation message surfaced inline near the field. */
  privacyError?: string | null;
  /** Lifted to the form so it can enforce the commercial-content rule at submit. */
  commercialContentEnabled: boolean;
  onCommercialContentEnabledChange: (enabled: boolean) => void;
}

const checkboxClass =
  "h-4 w-4 rounded border-input accent-[var(--primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50";

export function TikTokPostSettings({
  metadata,
  onChange,
  isVideo,
  privacyError,
  commercialContentEnabled,
  onCommercialContentEnabledChange,
}: TikTokPostSettingsProps) {
  const [creatorInfo, setCreatorInfo] = useState<TikTokCreatorInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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
    } catch (err: unknown) {
      console.error("Failed to fetch TikTok creator info:", err);
      setError((err as Error).message || "Failed to load TikTok settings");
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
    onCommercialContentEnabledChange(enabled);
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
      <Card className="p-4">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner size="sm" />
          <span>Loading TikTok settings&hellip;</span>
        </div>
      </Card>
    );
  }

  if (error || !creatorInfo) {
    return (
      <Alert variant="danger" title="Couldn't load TikTok settings">
        {error || "Unable to load TikTok settings"}
      </Alert>
    );
  }

  return (
    <Card className="space-y-4 p-4">
      <div className="flex items-center gap-2 border-b border-border pb-2">
        <h3 className="text-sm font-semibold text-foreground">TikTok post settings</h3>
        <span className="text-xs text-muted-foreground">@{creatorInfo.creatorUsername}</span>
      </div>

      {/* Privacy Level - REQUIRED by TikTok Guidelines */}
      <div className="space-y-1.5">
        <Label htmlFor="tiktok-privacy">
          Privacy level <span className="text-destructive">*</span>
        </Label>
        <Select
          id="tiktok-privacy"
          value={metadata.privacyLevel}
          onChange={(e) => handlePrivacyChange(e.target.value)}
          required
          aria-invalid={privacyError ? true : undefined}
          aria-describedby={privacyError ? "tiktok-privacy-error" : "tiktok-privacy-help"}
        >
          <option value="">Select privacy level...</option>
          {creatorInfo.privacyLevelOptions.map((option) => (
            <option key={option} value={option}>
              {option === "PUBLIC_TO_EVERYONE" && "Public (everyone)"}
              {option === "MUTUAL_FOLLOW_FRIENDS" && "Friends"}
              {option === "SELF_ONLY" && "Private (only me)"}
              {option === "FOLLOWER_OF_CREATOR" && "Followers"}
            </option>
          ))}
        </Select>
        {privacyError ? (
          <p id="tiktok-privacy-error" className="text-xs text-destructive" role="alert">
            {privacyError}
          </p>
        ) : (
          <p id="tiktok-privacy-help" className="text-xs text-muted-foreground">
            You must manually select who can view this video
          </p>
        )}
      </div>

      {/* Interaction Settings - REQUIRED by TikTok Guidelines */}
      <div>
        <Label className="mb-2 block">Interaction settings</Label>
        <div className="space-y-2">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={!metadata.disableComment}
              onChange={(e) => handleInteractionChange("disableComment", !e.target.checked)}
              disabled={creatorInfo.commentDisabled}
              className={checkboxClass}
            />
            <span className="text-sm text-foreground">
              Allow comments
              {creatorInfo.commentDisabled && (
                <span className="ml-2 text-xs text-muted-foreground">
                  (Disabled in your TikTok settings)
                </span>
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
                  className={checkboxClass}
                />
                <span className="text-sm text-foreground">
                  Allow duets
                  {creatorInfo.duetDisabled && (
                    <span className="ml-2 text-xs text-muted-foreground">
                      (Disabled in your TikTok settings)
                    </span>
                  )}
                </span>
              </label>

              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={!metadata.disableStitch}
                  onChange={(e) => handleInteractionChange("disableStitch", !e.target.checked)}
                  disabled={creatorInfo.stitchDisabled}
                  className={checkboxClass}
                />
                <span className="text-sm text-foreground">
                  Allow stitches
                  {creatorInfo.stitchDisabled && (
                    <span className="ml-2 text-xs text-muted-foreground">
                      (Disabled in your TikTok settings)
                    </span>
                  )}
                </span>
              </label>
            </>
          )}
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          Manually enable interaction features. None are checked by default.
        </p>
      </div>

      {/* Commercial Content Disclosure - REQUIRED by TikTok Guidelines */}
      <div>
        <label className="mb-2 flex items-center gap-2">
          <input
            type="checkbox"
            checked={commercialContentEnabled}
            onChange={(e) => handleCommercialToggle(e.target.checked)}
            className={checkboxClass}
          />
          <span className="text-sm font-medium text-foreground">
            This content promotes a brand, product, or service
          </span>
        </label>

        {commercialContentEnabled && (
          <div className="ml-6 mt-2 space-y-2 rounded-[var(--radius)] border border-border bg-muted p-3">
            <label className="flex items-start gap-2">
              <input
                type="checkbox"
                checked={metadata.brandOrganic || false}
                onChange={(e) => onChange({ ...metadata, brandOrganic: e.target.checked })}
                className={`${checkboxClass} mt-0.5`}
              />
              <div className="flex-1">
                <span className="text-sm font-medium text-foreground">Your brand</span>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  You are promoting yourself or your own business
                </p>
                {metadata.brandOrganic && (
                  <p className="mt-1 text-xs font-medium text-primary">
                    &#10003; Your video will be labeled as &quot;Promotional content&quot;
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
                className={`${checkboxClass} mt-0.5`}
              />
              <div className="flex-1">
                <span className="text-sm font-medium text-foreground">Branded content</span>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  You are promoting another brand or third party
                </p>
                {isBrandedContentDisabled && (
                  <p className="mt-1 text-xs text-warning">
                    Branded content cannot be set to private. Change privacy to Public or Friends.
                  </p>
                )}
                {metadata.brandedContent && (
                  <p className="mt-1 text-xs font-medium text-primary">
                    &#10003; Your video will be labeled as &quot;Paid partnership&quot;
                  </p>
                )}
              </div>
            </label>

            {!canPublish && (
              <Alert variant="warning" className="p-2 text-xs">
                You must select at least one option (Your brand or Branded content) to proceed
              </Alert>
            )}
          </div>
        )}
      </div>

      {/* Consent declaration — REQUIRED by TikTok's UX Guidelines.
          The 2026-01 Direct Post audit was rejected partly because this was
          plain text: the guideline requires the referenced policies to be
          CLICKABLE links, and the sentence to name the Branded Content Policy
          only when a commercial-content option is selected. */}
      <div className="border-t border-border pt-3">
        <Alert variant="info">
          By posting, you agree to{" "}
          {metadata.brandedContent || metadata.brandOrganic ? (
            <>
              TikTok&apos;s{" "}
              <a
                href="https://www.tiktok.com/legal/page/global/bc-policy/en"
                target="_blank"
                rel="noopener noreferrer"
                className="font-medium underline underline-offset-2 hover:no-underline"
              >
                Branded Content Policy
              </a>{" "}
              and{" "}
            </>
          ) : (
            <>TikTok&apos;s </>
          )}
          <a
            href="https://www.tiktok.com/legal/page/global/music-usage-confirmation/en"
            target="_blank"
            rel="noopener noreferrer"
            className="font-medium underline underline-offset-2 hover:no-underline"
          >
            Music Usage Confirmation
          </a>
          .
        </Alert>
      </div>

      {/* Post Processing Notice - REQUIRED by TikTok Guidelines */}
      <Alert variant="info">
        After publishing, it may take a few minutes for your content to process and be visible on
        your profile.
      </Alert>
    </Card>
  );
}
