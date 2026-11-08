"use client";

import { useState, useEffect } from "react";
import type { TikTokCreatorInfo, TikTokPostMetadata } from "@/server/platforms/types";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import {
  TIKTOK_BRANDED_PRIVATE_TEXT,
  TIKTOK_DISCLOSURE_INCOMPLETE_TEXT,
  formatDuration,
  tiktokDisclosureLabel,
  tiktokPrivacyLabel,
  tiktokVideoTooLong,
} from "@/lib/tiktokPostRules";

/**
 * The "Post to TikTok" settings, built to TikTok's Content Sharing Guidelines
 * (https://developers.tiktok.com/doc/content-sharing-guidelines), in the
 * guideline's order: 1 creator info, 2 metadata (privacy, interactions),
 * 3 commercial content disclosure, then 5d the processing notice. The consent
 * declaration (4) sits right above the Publish button (TikTokConsentDeclaration,
 * rendered by the form). The 2026 Direct Post audit was rejected for points
 * 3a, 3b, 4 and 5d; the rules live in lib/tiktokPostRules.ts and are tested.
 */

interface TikTokPostSettingsProps {
  metadata: TikTokPostMetadata;
  onChange: (metadata: TikTokPostMetadata) => void;
  isVideo: boolean;
  /** Submit-time privacy validation message surfaced inline near the field. */
  privacyError?: string | null;
  /** Lifted to the form so it can enforce the commercial-content rule at submit. */
  commercialContentEnabled: boolean;
  onCommercialContentEnabledChange: (enabled: boolean) => void;
  /** Length of the chosen video in seconds, once the browser has read it. */
  videoDurationSec?: number | null;
  /**
   * Why TikTok can't take this post right now (null when it can): the
   * creator can't post (guideline 1b), the settings didn't load, or the video
   * is longer than this account allows (1c). The form blocks Publish while
   * TikTok is selected and this is set.
   */
  onBlockingChange?: (reason: string | null) => void;
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
  videoDurationSec = null,
  onBlockingChange,
}: TikTokPostSettingsProps) {
  const [creatorInfo, setCreatorInfo] = useState<TikTokCreatorInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [cannotPost, setCannotPost] = useState(false);

  useEffect(() => {
    fetchCreatorInfo();
  }, []);

  // Guideline 1: the latest creator info every time the panel renders.
  async function fetchCreatorInfo() {
    try {
      setLoading(true);
      setError(null);
      setCannotPost(false);
      const response = await fetch("/api/tiktok/creator-info");
      const data = await response.json().catch(() => null);

      if (!response.ok) {
        // 409 = TikTok says this creator can't post right now (guideline 1b).
        setCannotPost(response.status === 409);
        throw new Error(data?.error || "Failed to fetch TikTok creator info");
      }

      setCreatorInfo(data as TikTokCreatorInfo);
    } catch (err: unknown) {
      console.error("Failed to fetch TikTok creator info:", err);
      setError((err as Error).message || "Failed to load TikTok settings");
    } finally {
      setLoading(false);
    }
  }

  const tooLong =
    creatorInfo !== null && tiktokVideoTooLong(videoDurationSec, creatorInfo.maxVideoPostDurationSec);

  const blockingReason = loading
    ? "Loading TikTok settings…"
    : error
      ? error
      : tooLong && creatorInfo
        ? `This video is ${formatDuration(videoDurationSec ?? 0)} long. TikTok allows up to ${formatDuration(creatorInfo.maxVideoPostDurationSec)} for this account.`
        : null;

  useEffect(() => {
    onBlockingChange?.(blockingReason);
  }, [blockingReason, onBlockingChange]);

  // When the panel goes away (TikTok unselected, media removed), it no longer
  // blocks anything.
  useEffect(() => () => onBlockingChange?.(null), [onBlockingChange]);

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

  // Guideline 3b: "Only me" and Branded content exclude each other. Each one
  // disables the other, with TikTok's text shown on hover and inline.
  const isBrandedContentDisabled = metadata.privacyLevel === "SELF_ONLY";
  const isOnlyMeDisabled = metadata.brandedContent === true;
  const disclosureIncomplete =
    commercialContentEnabled && !metadata.brandedContent && !metadata.brandOrganic;
  const disclosureLabel = tiktokDisclosureLabel(metadata);

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
      <Alert
        variant={cannotPost ? "warning" : "danger"}
        title={cannotPost ? "TikTok can't take a post from this account right now" : "Couldn't load TikTok settings"}
      >
        <p>{error || "Unable to load TikTok settings"}</p>
        <p className="mt-1">You can post to your other platforms by unselecting TikTok.</p>
        <Button size="sm" variant="outline" className="mt-2" onClick={() => fetchCreatorInfo()}>
          Try again
        </Button>
      </Alert>
    );
  }

  return (
    <Card className="space-y-4 p-4">
      {/* 1a: which TikTok account this goes to — avatar and nickname. */}
      <div className="flex items-center gap-3 border-b border-border pb-3">
        {creatorInfo.creatorAvatarUrl ? (
          // eslint-disable-next-line @next/next/no-img-element -- TikTok-signed avatar URL (2 h TTL); next/image would need remote host config
          <img
            src={creatorInfo.creatorAvatarUrl}
            alt=""
            className="h-9 w-9 rounded-full border border-border object-cover"
          />
        ) : null}
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-foreground">Post to TikTok</h3>
          <p className="truncate text-xs text-muted-foreground">
            Posting as <span className="font-medium text-foreground">{creatorInfo.creatorNickname}</span>
            {creatorInfo.creatorUsername ? <> (@{creatorInfo.creatorUsername})</> : null}
          </p>
        </div>
      </div>

      {/* 1c: video length against this account's limit. */}
      {tooLong ? (
        <Alert variant="danger" title="Video too long for TikTok">
          {blockingReason}
        </Alert>
      ) : null}

      {/* 2b: privacy — from creator_info, no default. */}
      <div className="space-y-1.5">
        <Label htmlFor="tiktok-privacy">
          Who can view this video <span className="text-destructive">*</span>
        </Label>
        <Select
          id="tiktok-privacy"
          value={metadata.privacyLevel}
          onChange={(e) => handlePrivacyChange(e.target.value)}
          required
          aria-invalid={privacyError ? true : undefined}
          aria-describedby={privacyError ? "tiktok-privacy-error" : "tiktok-privacy-help"}
        >
          <option value="">Select who can view this video…</option>
          {creatorInfo.privacyLevelOptions.map((option) => {
            const disabled = option === "SELF_ONLY" && isOnlyMeDisabled;
            return (
              <option
                key={option}
                value={option}
                disabled={disabled}
                title={disabled ? TIKTOK_BRANDED_PRIVATE_TEXT : undefined}
              >
                {tiktokPrivacyLabel(option)}
              </option>
            );
          })}
        </Select>
        {privacyError ? (
          <p id="tiktok-privacy-error" className="text-xs text-destructive" role="alert">
            {privacyError}
          </p>
        ) : isOnlyMeDisabled ? (
          <p id="tiktok-privacy-help" className="text-xs text-muted-foreground">
            {TIKTOK_BRANDED_PRIVATE_TEXT}
          </p>
        ) : (
          <p id="tiktok-privacy-help" className="text-xs text-muted-foreground">
            Choose who can view this video. Nothing is selected for you.
          </p>
        )}
      </div>

      {/* 2c: interactions — creator_info disables, none on by default. */}
      <div>
        <Label className="mb-2 block">Allow users to</Label>
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
              Comment
              {creatorInfo.commentDisabled && (
                <span className="ml-2 text-xs text-muted-foreground">
                  (Turned off in your TikTok settings)
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
                  Duet
                  {creatorInfo.duetDisabled && (
                    <span className="ml-2 text-xs text-muted-foreground">
                      (Turned off in your TikTok settings)
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
                  Stitch
                  {creatorInfo.stitchDisabled && (
                    <span className="ml-2 text-xs text-muted-foreground">
                      (Turned off in your TikTok settings)
                    </span>
                  )}
                </span>
              </label>
            </>
          )}
        </div>
        <p className="mt-2 text-xs text-muted-foreground">None are turned on for you.</p>
      </div>

      {/* 3a: commercial content disclosure — a switch, off by default. */}
      <div>
        <div className="flex items-start justify-between gap-3">
          <div>
            <p id="tiktok-disclosure-label" className="text-sm font-medium text-foreground">
              Disclose video content
            </p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Turn on to disclose that this video promotes goods or services in exchange for
              something of value. Your video could promote yourself, a third party, or both.
            </p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={commercialContentEnabled}
            aria-labelledby="tiktok-disclosure-label"
            onClick={() => handleCommercialToggle(!commercialContentEnabled)}
            className={`relative mt-0.5 inline-flex h-6 w-11 shrink-0 items-center rounded-full border border-border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
              commercialContentEnabled ? "bg-primary" : "bg-muted"
            }`}
          >
            <span
              className={`inline-block h-4 w-4 rounded-full bg-background shadow transition-transform ${
                commercialContentEnabled ? "translate-x-6" : "translate-x-1"
              }`}
            />
          </button>
        </div>

        {commercialContentEnabled && (
          <div className="mt-3 space-y-3 rounded-[var(--radius)] border border-border bg-muted p-3">
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
                  You are promoting yourself or your own business. This content will be classified
                  as Brand Organic.
                </p>
              </div>
            </label>

            <label
              className="flex items-start gap-2"
              title={isBrandedContentDisabled ? TIKTOK_BRANDED_PRIVATE_TEXT : undefined}
            >
              <input
                type="checkbox"
                checked={metadata.brandedContent || false}
                onChange={(e) => onChange({ ...metadata, brandedContent: e.target.checked })}
                disabled={isBrandedContentDisabled}
                className={`${checkboxClass} mt-0.5`}
              />
              <div className="flex-1">
                <span className="text-sm font-medium text-foreground">Branded content</span>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  You are promoting another brand or a third party. This content will be classified
                  as Branded Content.
                </p>
                {isBrandedContentDisabled && (
                  <p className="mt-1 text-xs text-warning">{TIKTOK_BRANDED_PRIVATE_TEXT}</p>
                )}
              </div>
            </label>

            {/* One label for the selection: "Paid partnership" whenever Branded
                content is ticked, else "Promotional content" (3a). */}
            {disclosureLabel ? (
              <p className="text-xs font-medium text-primary" role="status">
                Your video will be labeled as &lsquo;{disclosureLabel}&rsquo;
              </p>
            ) : null}

            {disclosureIncomplete && (
              <Alert variant="warning" className="p-2 text-xs">
                {TIKTOK_DISCLOSURE_INCOMPLETE_TEXT}
              </Alert>
            )}
          </div>
        )}
      </div>

      {/* 5d: processing notice. */}
      <Alert variant="info">
        After publishing, it may take a few minutes for your content to process and be visible on
        your profile.
      </Alert>
    </Card>
  );
}

const policyLinkClass = "font-medium underline underline-offset-2 hover:no-underline";

/**
 * TikTok's declaration (guideline 4), shown right above the Publish button
 * when TikTok is a target. Its policy names are links (the 2026-01 audit was
 * rejected partly because they were plain text), and the Branded Content
 * Policy appears only when Branded content is ticked: "Your brand" alone gets
 * the Music Usage sentence.
 */
export function TikTokConsentDeclaration({ brandedContent }: { brandedContent: boolean }) {
  // A block <span>, not a <p>: it is also rendered inside the confirm dialog's description paragraph.
  return (
    <span className="block text-sm text-muted-foreground">
      By posting, you agree to TikTok&apos;s{" "}
      {brandedContent ? (
        <>
          <a
            href="https://www.tiktok.com/legal/page/global/bc-policy/en"
            target="_blank"
            rel="noopener noreferrer"
            className={policyLinkClass}
          >
            Branded Content Policy
          </a>{" "}
          and{" "}
        </>
      ) : null}
      <a
        href="https://www.tiktok.com/legal/page/global/music-usage-confirmation/en"
        target="_blank"
        rel="noopener noreferrer"
        className={policyLinkClass}
      >
        Music Usage Confirmation
      </a>
      .
    </span>
  );
}
