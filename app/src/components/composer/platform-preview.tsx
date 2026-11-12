"use client";

import { useState, type KeyboardEvent } from "react";
import { AlertTriangle } from "lucide-react";
import type { Platform } from "@prisma/client";

import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { MediaCountBadge, mediaCountBadge } from "@/components/media-thumb";
import type { CaptionFooterUser } from "@/lib/captionFooter";
import { cn } from "@/lib/cn";
import { PLATFORM_ORDER, platformLabel } from "@/lib/platforms";
import { buildPlatformPreview } from "@/lib/platformPreview";

export interface PlatformPreviewListProps {
  /** Platforms to preview, in order — the composer's SELECTED platforms. */
  platforms: Platform[];
  /** The composer's base caption, before any footer/override is applied. */
  caption: string;
  /** Per-platform caption overrides, if the attached media has any. */
  overrides?: Partial<Record<Platform, string>> | null;
  /**
   * The posting user's footer settings. Omitted/null renders every card
   * without a footer instead of crashing — see create-post-form.tsx.
   */
  user?: CaptionFooterUser | null;
  /** Attached media's displayable URL (object URL or blob URL), or null. */
  mediaUrl: string | null;
  /** Attached media's MIME type, used to pick an image vs. video thumbnail. */
  mediaMimeType: string | null;
  /** How many photos are attached (07c); above 1 the first gets a count badge. */
  mediaCount?: number;
}

/**
 * The platform whose preview shows: the one chosen while it stays selected,
 * else the next selected one after it in the app's order (the one before it
 * when it was the last), else the first. Null when nothing is selected.
 */
export function shownPreviewPlatform(platforms: readonly Platform[], chosen: Platform | null): Platform | null {
  if (platforms.length === 0) return null;
  if (chosen === null || platforms.includes(chosen)) return chosen ?? platforms[0];
  const at = PLATFORM_ORDER.indexOf(chosen);
  const after = platforms.find((platform) => PLATFORM_ORDER.indexOf(platform) > at);
  return after ?? platforms[platforms.length - 1];
}

const tabId = (platform: Platform) => `platform-preview-tab-${platform}`;
const panelId = "platform-preview-panel";

/**
 * Roadmap Phase 7 (spec §7.1) — live, per-platform preview of how a post will
 * actually render: caption with footer, media thumbnail, and character-limit
 * feedback, updating on every render (the caller re-renders this on every
 * keystroke since `caption` is composer state).
 *
 * One platform's card at a time behind a row of tabs (M1): seven stacked
 * cards made a phone scroll past near-identical previews to reach Publish.
 * A tab is marked when its text is over the platform's limit, so a problem on
 * a hidden tab is still seen. With one platform there is nothing to choose,
 * so the card shows alone.
 *
 * All caption math (footer, override precedence, truncation) is done by the
 * pure `buildPlatformPreview` helper (unit-tested in
 * lib/platformPreview.test.ts) — this component only lays the result out, so
 * "preview == reality" holds without re-deriving any of that logic here.
 */
export function PlatformPreviewList({
  platforms,
  caption,
  overrides,
  user,
  mediaUrl,
  mediaMimeType,
  mediaCount,
}: PlatformPreviewListProps) {
  const [chosen, setChosen] = useState<Platform | null>(null);
  const shown = shownPreviewPlatform(platforms, chosen);
  // Kept as the shown one, so a platform deselected and ticked again does not take the view back.
  if (shown !== null && chosen !== null && shown !== chosen) setChosen(shown);

  if (shown === null) {
    return null;
  }

  const card = (
    <PlatformPreviewCard
      key={shown}
      platform={shown}
      caption={caption}
      override={overrides?.[shown] ?? null}
      user={user}
      mediaUrl={mediaUrl}
      mediaMimeType={mediaMimeType}
      mediaCount={mediaCount}
    />
  );

  const choose = (platform: Platform, focus: boolean) => {
    setChosen(platform);
    if (focus) document.getElementById(tabId(platform))?.focus();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const at = platforms.indexOf(shown);
    const target =
      event.key === "ArrowRight"
        ? platforms[(at + 1) % platforms.length]
        : event.key === "ArrowLeft"
          ? platforms[(at - 1 + platforms.length) % platforms.length]
          : event.key === "Home"
            ? platforms[0]
            : event.key === "End"
              ? platforms[platforms.length - 1]
              : null;
    if (!target) return;
    event.preventDefault();
    choose(target, true);
  };

  return (
    <div className="space-y-2">
      <h2 className="text-sm font-medium text-foreground">Preview</h2>
      <p className="text-xs text-muted-foreground">
        How this post will look on each connected platform.
      </p>
      {platforms.length === 1 ? (
        card
      ) : (
        <>
          <div
            role="tablist"
            aria-label="Preview for"
            onKeyDown={onKeyDown}
            className="-mx-1 flex gap-1 overflow-x-auto px-1 pb-1"
          >
            {platforms.map((platform) => {
              const selected = platform === shown;
              const over = buildPlatformPreview({
                platform,
                caption,
                override: overrides?.[platform] ?? null,
                user,
              }).willTruncate;
              return (
                <button
                  key={platform}
                  type="button"
                  role="tab"
                  id={tabId(platform)}
                  aria-selected={selected}
                  aria-controls={panelId}
                  aria-label={over ? `${platformLabel(platform)}, over its limit: the text will be shortened` : undefined}
                  tabIndex={selected ? 0 : -1}
                  onClick={() => choose(platform, false)}
                  className={cn(
                    "inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-[var(--radius)] border px-3 py-1.5 text-sm font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
                    selected
                      ? "border-primary/40 bg-primary/10 text-foreground"
                      : "border-input text-muted-foreground hover:text-foreground",
                  )}
                >
                  {platformLabel(platform)}
                  {over ? <AlertTriangle aria-hidden className="h-3.5 w-3.5 text-warning" /> : null}
                </button>
              );
            })}
          </div>
          <div role="tabpanel" id={panelId} aria-labelledby={tabId(shown)}>
            {card}
          </div>
        </>
      )}
    </div>
  );
}

function PlatformPreviewCard({
  platform,
  caption,
  override,
  user,
  mediaUrl,
  mediaMimeType,
  mediaCount,
}: {
  platform: Platform;
  caption: string;
  override: string | null;
  user?: CaptionFooterUser | null;
  mediaUrl: string | null;
  mediaMimeType: string | null;
  mediaCount?: number;
}) {
  const preview = buildPlatformPreview({ platform, caption, override, user });
  const headingId = `platform-preview-heading-${platform}`;
  const isImage = mediaMimeType?.startsWith("image/") ?? false;
  const isVideo = mediaMimeType?.startsWith("video/") ?? false;
  // Several photos (07c): the first is shown with a count badge over it.
  const several = isImage && mediaCountBadge(mediaCount) !== null;

  return (
    <Card
      role="group"
      aria-labelledby={headingId}
      className="flex min-w-0 flex-col gap-2 p-3"
    >
      <div className="flex items-center justify-between gap-2">
        <h3 id={headingId} className="text-sm font-semibold text-foreground">
          {platformLabel(platform)}
        </h3>
        {preview.willTruncate && (
          <Badge variant="warning">
            <AlertTriangle aria-hidden className="h-3.5 w-3.5" />
            Will be shortened
          </Badge>
        )}
      </div>

      {mediaUrl && several && (
        <div className="relative">
          {/* eslint-disable-next-line @next/next/no-img-element -- the same preview as below, with the photo count over it */}
          <img
            src={mediaUrl}
            alt=""
            className="h-32 w-full rounded-[var(--radius)] border border-border object-cover"
          />
          <MediaCountBadge count={mediaCount} />
        </div>
      )}
      {mediaUrl && isImage && !several && (
        // eslint-disable-next-line @next/next/no-img-element -- reuses the composer's existing local object-URL / already-public blob preview (see previewUrl / reuseItem in create-post-form.tsx); not a fresh upload, decorative duplicate of the media picked above so alt is empty
        <img
          src={mediaUrl}
          alt=""
          className="h-32 w-full rounded-[var(--radius)] border border-border object-cover"
        />
      )}
      {mediaUrl && isVideo && (
        <video
          src={mediaUrl}
          controls
          muted
          className="h-32 w-full rounded-[var(--radius)] border border-border object-cover"
        />
      )}

      {/* Wraps anywhere: a footer link with tracking tags has no break point and ran past the card on a phone. */}
      <p className="min-h-[1.25rem] whitespace-pre-wrap break-words [overflow-wrap:anywhere] text-sm text-foreground">
        {preview.rendered || <span className="text-muted-foreground">No caption yet</span>}
      </p>

      <p className="text-xs text-muted-foreground">
        {preview.limit !== null
          ? `${preview.charCount} / ${preview.limit} characters`
          : `${preview.charCount} characters`}
      </p>
    </Card>
  );
}
