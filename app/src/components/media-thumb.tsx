/**
 * The number a post's thumbnail shows for its photo count, or null for a
 * single file (07c). Shared with the composer's preview.
 */
export function mediaCountBadge(count: number | undefined): string | null {
  return count !== undefined && count > 1 ? String(count) : null;
}

/** The small count badge over a thumbnail's corner. */
export function MediaCountBadge({ count }: { count: number | undefined }) {
  const label = mediaCountBadge(count);
  if (!label) return null;
  return (
    <span
      aria-label={`${label} photos`}
      className="absolute bottom-0.5 right-0.5 rounded-full bg-black/70 px-1.5 text-[10px] font-semibold leading-4 text-white"
    >
      {label}
    </span>
  );
}

/**
 * Shared 48px activity/queue media thumbnail: a muted, non-interactive video
 * preview for video media, an `<img>` for everything else. Renders nothing
 * when there's no media.
 *
 * Extracted from post-job-card.tsx / queue-view.tsx (whole-branch review,
 * Finding 3) — both cards rendered an identical block; this is the single
 * source of truth now. Visual output (classes/attributes) is unchanged.
 *
 * `count` (07c) is the post's number of files: above 1 the photo gets a badge
 * with the number; otherwise the markup is exactly the single-file one.
 */
export function MediaThumb({
  media,
  count,
}: {
  media: { url: string; mimeType: string } | null;
  count?: number;
}) {
  if (!media) return null;

  if (media.mimeType.startsWith("video/")) {
    return (
      <video
        src={media.url}
        muted
        playsInline
        preload="metadata"
        aria-hidden
        tabIndex={-1}
        className="h-12 w-12 shrink-0 rounded-[var(--radius)] border border-border object-cover"
      />
    );
  }

  const image = (
    // eslint-disable-next-line @next/next/no-img-element -- remote (already-public) Vercel Blob URL thumbnail; same pattern as create-post-form.tsx's reuse preview
    <img
      src={media.url}
      alt=""
      className="h-12 w-12 shrink-0 rounded-[var(--radius)] border border-border object-cover"
    />
  );
  if (!mediaCountBadge(count)) return image;

  return (
    <span className="relative inline-block h-12 w-12 shrink-0">
      {image}
      <MediaCountBadge count={count} />
    </span>
  );
}
