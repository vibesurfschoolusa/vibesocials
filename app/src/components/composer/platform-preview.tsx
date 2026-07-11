"use client";

import { AlertTriangle } from "lucide-react";
import type { Platform } from "@prisma/client";

import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import type { CaptionFooterUser } from "@/lib/captionFooter";
import { platformLabel } from "@/lib/platforms";
import { buildPlatformPreview } from "@/lib/platformPreview";

export interface PlatformPreviewListProps {
  /** Platforms to render a card for — the composer's CONNECTED platforms. */
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
}

/**
 * Roadmap Phase 7 (spec §7.1) — live, per-platform preview of how a post will
 * actually render: caption with footer, media thumbnail, and character-limit
 * feedback. One card per CONNECTED platform, updating on every render (the
 * caller re-renders this on every keystroke since `caption` is composer
 * state).
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
}: PlatformPreviewListProps) {
  if (platforms.length === 0) {
    return null;
  }

  return (
    <div className="space-y-2">
      <h2 className="text-sm font-medium text-foreground">Preview</h2>
      <p className="text-xs text-muted-foreground">
        How this post will look on each connected platform.
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        {platforms.map((platform) => (
          <PlatformPreviewCard
            key={platform}
            platform={platform}
            caption={caption}
            override={overrides?.[platform] ?? null}
            user={user}
            mediaUrl={mediaUrl}
            mediaMimeType={mediaMimeType}
          />
        ))}
      </div>
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
}: {
  platform: Platform;
  caption: string;
  override: string | null;
  user?: CaptionFooterUser | null;
  mediaUrl: string | null;
  mediaMimeType: string | null;
}) {
  const preview = buildPlatformPreview({ platform, caption, override, user });
  const headingId = `platform-preview-heading-${platform}`;
  const isImage = mediaMimeType?.startsWith("image/") ?? false;
  const isVideo = mediaMimeType?.startsWith("video/") ?? false;

  return (
    <Card
      role="group"
      aria-labelledby={headingId}
      className="flex flex-col gap-2 p-3"
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

      {mediaUrl && isImage && (
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

      <p className="min-h-[1.25rem] whitespace-pre-wrap break-words text-sm text-foreground">
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
