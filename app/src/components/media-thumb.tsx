/**
 * Shared 48px activity/queue media thumbnail: a muted, non-interactive video
 * preview for video media, an `<img>` for everything else. Renders nothing
 * when there's no media.
 *
 * Extracted from post-job-card.tsx / queue-view.tsx (whole-branch review,
 * Finding 3) — both cards rendered an identical block; this is the single
 * source of truth now. Visual output (classes/attributes) is unchanged.
 */
export function MediaThumb({
  media,
}: {
  media: { url: string; mimeType: string } | null;
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

  return (
    // eslint-disable-next-line @next/next/no-img-element -- remote (already-public) Vercel Blob URL thumbnail; same pattern as create-post-form.tsx's reuse preview
    <img
      src={media.url}
      alt=""
      className="h-12 w-12 shrink-0 rounded-[var(--radius)] border border-border object-cover"
    />
  );
}
